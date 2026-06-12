/**
 * 聊天底部模型下拉选择器。
 * 样式与命令面板（`.cmd-dropdown` / `.cmd-name` / `.cmd-desc`）保持一致，
 * 切换逻辑复用 config-page 的"设为默认"：把目标 provider 标 isDefault，
 * 其余置为 false，整组 POST /api/config，保存后刷新本地缓存 + chip + 冰豆 token。
 *
 * 用法（与 ChatCommands 风格一致）：
 *   const Model = ChatModelPicker;
 *   Model.init({ chipEl, labelEl, getProviders, onChange });
 *   Model.open();   // 打开下拉（如果已有 provider）
 *   Model.close();
 *   Model.toggle();
 *   Model.setProviders(providers);
 *   Model.refreshFromServer(); // 从 /api/config 拉一次
 *   Model.isOpen();
 */

/* exported ChatModelPicker */

window.ChatModelPicker = (function () {
  'use strict';

  var elDropdown = null;
  var elPalette = null;
  var elChip = null;
  var elLabel = null;
  var isOpen = false;
  var outsideClickBound = false;
  var cachedProviders = [];
  var getProvidersFn = null;
  var onChangeFn = null;
  var refreshPromise = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function ensurePalette() {
    if (elPalette) return elPalette;
    var p = document.createElement('div');
    p.className = 'model-palette hidden';
    p.id = 'model-palette';
    p.setAttribute('role', 'menu');
    p.setAttribute('aria-label', '选择模型');
    p.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    p.addEventListener('click', function (e) {
      var item = e.target.closest('.cmd-item');
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      var idx = parseInt(item.getAttribute('data-index'), 10);
      if (isNaN(idx)) return;
      var target = cachedProviders[idx];
      if (!target) return;
      close();
      selectDefault(target);
    });
    document.body.appendChild(p);
    elPalette = p;
    return p;
  }

  function ensureDropdown() {
    if (elDropdown) return elDropdown;
    var palette = ensurePalette();
    var dd = document.createElement('div');
    dd.className = 'cmd-dropdown hidden';
    dd.id = 'model-picker-dropdown';
    dd.setAttribute('role', 'menu');
    dd.setAttribute('aria-label', '选择模型');
    palette.appendChild(dd);
    elDropdown = dd;
    return dd;
  }

  function render() {
    var dd = ensureDropdown();
    if (!cachedProviders || !cachedProviders.length) {
      dd.innerHTML = '<div class="cmd-empty">暂无可用模型</div>';
      return;
    }
    var def = cachedProviders.find(function (p) { return p.isDefault; }) || cachedProviders[0];
    var html = '';
    for (var i = 0; i < cachedProviders.length; i++) {
      var p = cachedProviders[i];
      var isCurrent = def && p.id === def.id;
      // 与命令面板布局一致：左为命令名（~modelname），右为描述（apiUrl 或 provider id）
      var desc = p.apiUrl ? p.apiUrl : (p.id ? p.id : 'LLM 提供者');
      html +=
        '<div class="cmd-item' + (isCurrent ? ' active' : '') + '" data-index="' + i + '" role="menuitem" title="' + escapeAttr(desc + ' · ' + (p.modelName || '')) + '">' +
          '<span class="cmd-name">' + escapeHtml((p.modelName || p.id || 'model')) + '</span>' +
        '</div>';
    }
    dd.innerHTML = html;
    // 条目较多时启用滚动上限，避免遮挡过多聊天内容
    if (cachedProviders.length > 6) {
      dd.classList.add('is-scrollable');
    } else {
      dd.classList.remove('is-scrollable');
    }
  }

  // 参照 chat-page.positionCmdPalette：把 left/top 写到外层 .model-palette。
  // dropdown 自身 position: static，由外层 .model-palette（position: fixed; z-index: 9999;）浮起。
  function position() {
    if (!elChip || !elPalette) return;
    var rect = elChip.getBoundingClientRect();
    var margin = 8;
    var panelWidth = Math.min(320, window.innerWidth - 32);
    elPalette.style.position = 'fixed';
    elPalette.style.width = panelWidth + 'px';
    elPalette.style.visibility = 'hidden';
    elPalette.style.left = '0px';
    elPalette.style.top = '0px';
    void elPalette.offsetHeight;
    var panelHeight = elPalette.offsetHeight;
    elPalette.style.visibility = '';
    // 面板底端 = chip 顶端之上 margin
    var left = rect.right - panelWidth;
    if (left < 8) left = 8;
    if (left + panelWidth > window.innerWidth - 8) {
      left = window.innerWidth - panelWidth - 8;
    }
    var top = rect.top - panelHeight - margin;
    if (top < 8) top = 8;
    elPalette.style.left = left + 'px';
    elPalette.style.top = top + 'px';
  }

  function open() {
    if (!elPalette) ensurePalette();
    if (!cachedProviders || !cachedProviders.length) {
      // 还没有 provider 缓存时拉一次
      refreshFromServer();
    }
    render();
    if (elDropdown) elDropdown.classList.remove('hidden');
    if (elPalette) elPalette.classList.remove('hidden');
    isOpen = true;
    if (elChip) {
      elChip.classList.add('active');
      elChip.setAttribute('aria-expanded', 'true');
    }
    position();
  }

  function close() {
    if (elDropdown) elDropdown.classList.add('hidden');
    if (elPalette) elPalette.classList.add('hidden');
    isOpen = false;
    if (elChip) {
      elChip.classList.remove('active');
      elChip.setAttribute('aria-expanded', 'false');
    }
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  function setProviders(providers) {
    cachedProviders = Array.isArray(providers) ? providers : [];
    if (isOpen) render();
  }

  function getProviders() {
    if (typeof getProvidersFn === 'function') {
      try { return getProvidersFn() || []; } catch (_e) { return []; }
    }
    return cachedProviders;
  }

  // 切换默认：仿 config-page 设为默认
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
        var def = cachedProviders.find(function (p) { return p.isDefault; }) || cachedProviders[0];
        if (elLabel && def) {
          elLabel.textContent = def.modelName || '未配置';
        }
        if (window.AppRouter && typeof window.AppRouter.refreshStatus === 'function') {
          window.AppRouter.refreshStatus();
        }
        if (typeof onChangeFn === 'function') {
          try { onChangeFn(def || null, cachedProviders); } catch (_e) { /* ignore */ }
        }
      })
      .catch(function (err) {
        // 回滚
        var def = cachedProviders.find(function (p) { return p.isDefault; }) || cachedProviders[0];
        if (elLabel) elLabel.textContent = def && def.modelName ? def.modelName : '未配置';
        if (window.UI && typeof window.UI.notify === 'function') {
          window.UI.notify('切换模型失败: ' + (err && err.message ? err.message : err), 'error');
        } else if (typeof alert === 'function') {
          alert('切换模型失败: ' + (err && err.message ? err.message : err));
        }
      });
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
      .catch(function () {
        setProviders([]);
        return [];
      })
      .then(function (res) {
        refreshPromise = null;
        return res;
      });
    return refreshPromise;
  }

  function bindOutsideClick() {
    if (outsideClickBound) return;
    outsideClickBound = true;
    document.addEventListener('mousedown', function (e) {
      if (!isOpen) return;
      if (elPalette && elPalette.contains(e.target)) return;
      if (elChip && elChip.contains(e.target)) return;
      close();
    });
    window.addEventListener('resize', function () { if (isOpen) position(); });
    window.addEventListener('scroll', function () { if (isOpen) position(); }, true);
  }

  function init(opts) {
    opts = opts || {};
    elChip = opts.chipEl || null;
    elLabel = opts.labelEl || null;
    getProvidersFn = typeof opts.getProviders === 'function' ? opts.getProviders : null;
    onChangeFn = typeof opts.onChange === 'function' ? opts.onChange : null;
    ensureDropdown();
    bindOutsideClick();
    if (elChip) {
      elChip.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      });
      elChip.setAttribute('aria-haspopup', 'menu');
      elChip.setAttribute('aria-expanded', 'false');
    }
    return {
      open: open,
      close: close,
      toggle: toggle,
      setProviders: setProviders,
      refreshFromServer: refreshFromServer,
      isOpen: function () { return isOpen; },
      position: position,
    };
  }

  return {
    init: init,
    open: open,
    close: close,
    toggle: toggle,
    setProviders: setProviders,
    refreshFromServer: refreshFromServer,
    isOpen: function () { return isOpen; },
    position: position,
  };
})();
