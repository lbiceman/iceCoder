/**
 * 聊天底部模型下拉选择器。
 * 浮层已统一为 ChatDropdown；本模块只负责拉取 providers + 切换默认 + 写回 label。
 *
 * 用法：
 *   const Model = ChatModelPicker;
 *   Model.init({ chipEl, labelEl });
 *   Model.open();
 *   Model.close();
 *   Model.toggle();
 *   Model.setProviders(providers);
 *   Model.refreshFromServer();
 *   Model.isOpen();
 */

/* exported ChatModelPicker */

window.ChatModelPicker = (function () {
  'use strict';

  var elChip = null;
  var elLabel = null;
  var cachedProviders = [];
  var refreshPromise = null;
  var chipClickBound = false;

  function isCurrent(p, def) {
    if (!def) return false;
    if (def.id && p.id) return p.id === def.id;
    return p.modelName === def.modelName;
  }

  function buildItems() {
    var def = cachedProviders.find(function (p) { return p.isDefault; }) || cachedProviders[0];
    return cachedProviders.map(function (p) {
      return {
        key: p.id,
        name: p.modelName || p.id || 'model',
        isCurrent: isCurrent(p, def),
      };
    });
  }

  function defaultProvider() {
    return cachedProviders.find(function (p) { return p.isDefault; }) || cachedProviders[0] || null;
  }

  function writeLabel() {
    if (!elLabel) return;
    var def = defaultProvider();
    elLabel.textContent = def ? (def.modelName || '未配置') : '未配置';
  }

  function selectDefault(target) {
    if (!target) return;
    var list = cachedProviders.slice();
    var current = list.find(function (p) { return p.isDefault; }) || list[0];
    if (current && current.id === target.id) return;
    if (elLabel) elLabel.textContent = '切换中…';

    var payload = list.map(function (p) {
      return {
        id: p.id,
        apiUrl: p.apiUrl,
        apiKey: p.apiKey,
        modelName: p.modelName,
        parameters: p.parameters || {},
        isDefault: p.id === target.id,
        supportsVision: p.supportsVision !== undefined ? p.supportsVision : true,
        maxContextTokens: p.maxContextTokens,
        requestTimeoutMs: p.requestTimeoutMs,
      };
    });

    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: payload }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (!result.ok || (result.body && result.body.error)) {
          throw new Error((result.body && result.body.error) || '保存失败');
        }
        return fetch('/api/config').then(function (r) { return r.json(); });
      })
      .then(function (data) {
        var providers = (data && data.providers) || payload;
        cachedProviders = providers.map(function (p) { p._masked = true; return p; });
        writeLabel();
        if (window.AppRouter && typeof window.AppRouter.refreshStatus === 'function') {
          window.AppRouter.refreshStatus();
        }
      })
      .catch(function (err) {
        var def = defaultProvider();
        if (elLabel) elLabel.textContent = def && def.modelName ? def.modelName : '未配置';
        Notification.error('切换模型失败: ' + (err && err.message ? err.message : err));
      });
  }

  function open() {
    if (!window.ChatDropdown) return;
    // 先确保 providers 已加载：之前在打开前只 fire-and-forget，
    // 用户点 chip 太快就会拿到空数组、显示「暂无可选项」。
    var ensure = cachedProviders.length ? Promise.resolve(cachedProviders) : refreshFromServer();
    Promise.resolve(ensure).then(function () {
      var items = buildItems();
      if (!items.length) {
        Notification.info('暂无可用模型，请先在「配置」页添加。');
        return;
      }
      // 如果在 await 期间用户已经切换到别的会话、或 dropdown 被关掉了，直接放弃
      if (!elChip) return;
      var chipRect = elChip.getBoundingClientRect();
      window.ChatDropdown.open({
        anchor: elChip,
        items: items,
        variant: 'model',
        placement: 'top',
        placementRef: 'toolbar',
        align: 'start',
        fitContent: true,
        minWidth: Math.ceil(chipRect.width),
        maxWidth: 300,
        onSelect: function (item) {
          var target = cachedProviders.find(function (p) { return p.id === item.key; });
          if (target) selectDefault(target);
        },
      });
    }).catch(function () {
      var items = buildItems();
      if (items.length) open();
    });
  }

  function close() { if (window.ChatDropdown) window.ChatDropdown.close(); }
  function toggle() {
    if (isOpen()) close();
    else open();
  }
  function isOpen() { return !!(window.ChatDropdown && window.ChatDropdown.isOpen()); }

  function setProviders(providers) {
    cachedProviders = Array.isArray(providers) ? providers : [];
    writeLabel();
  }

  function refreshFromServer() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = fetch('/api/config')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var providers = (data && data.providers) || [];
        setProviders(providers);
        return providers;
      })
      .catch(function () { setProviders([]); return []; })
      .then(function (res) { refreshPromise = null; return res; });
    return refreshPromise;
  }

  function init(opts) {
    opts = opts || {};
    elChip = opts.chipEl || null;
    elLabel = opts.labelEl || null;
    if (elChip) {
      elChip.setAttribute('aria-haspopup', 'menu');
      elChip.setAttribute('aria-expanded', 'false');
      if (!chipClickBound) {
        chipClickBound = true;
        elChip.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        });
      }
    }
    writeLabel();
  }

  return {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    setProviders: setProviders,
    refreshFromServer: refreshFromServer,
    isOpen: isOpen,
  };
})();
