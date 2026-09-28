// @ts-nocheck
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

export const ChatModelPicker = (() => {

  let elChip = null;
  let elLabel = null;
  let cachedProviders = [];
  let refreshPromise = null;
  let chipClickBound = false;

  function parseModelNames(modelName) {
    if (window.ModelNames && typeof window.ModelNames.parseModelNames === 'function') {
      return window.ModelNames.parseModelNames(modelName);
    }
    return (modelName || '').split(',').map((s) =>  s.trim()).filter(Boolean);
  }

  function resolveActiveModelName(provider) {
    if (window.ModelNames && typeof window.ModelNames.resolveActiveModelName === 'function') {
      return window.ModelNames.resolveActiveModelName(provider);
    }
    const names = parseModelNames(provider && provider.modelName);
    return names.length ? names[0] : ((provider && provider.modelName) || '').trim();
  }

  function isCurrentSelection(provider, modelName, def) {
    if (!def || !provider) return false;
    if (def.id && provider.id) {
      return provider.id === def.id && modelName === resolveActiveModelName(def);
    }
    return provider.modelName === def.modelName && modelName === resolveActiveModelName(def);
  }

  function apiUrlGroupLabel(apiUrl) {
    if (window.ModelNames && typeof window.ModelNames.apiUrlGroupLabel === 'function') {
      return window.ModelNames.apiUrlGroupLabel(apiUrl);
    }
    return '';
  }

  function buildItems() {
    const def = cachedProviders.find((p) =>  p.isDefault) || cachedProviders[0];
    const items = [];
    for (let i = 0; i < cachedProviders.length; i++) {
      const p = cachedProviders[i];
      items.push({
        type: 'separator',
        key: `sep-${i}`,
        label: apiUrlGroupLabel(p.apiUrl),
      });
      let names = parseModelNames(p.modelName);
      if (!names.length) {
        names = [p.modelName || p.id || 'model'];
      }
      for (let j = 0; j < names.length; j++) {
        const name = names[j];
        items.push({
          type: 'item',
          key: `${p.id}::${name}`,
          providerId: p.id,
          modelName: name,
          name,
          isCurrent: isCurrentSelection(p, name, def),
        });
      }
    }
    return items;
  }

  function defaultProvider() {
    return cachedProviders.find((p) =>  p.isDefault) || cachedProviders[0] || null;
  }

  function writeLabel() {
    if (!elLabel) return;
    const def = defaultProvider();
    elLabel.textContent = def ? (resolveActiveModelName(def) || '未配置') : '未配置';
    syncReasoningStepper();
  }

  function syncReasoningStepper() {
    if (!window.ChatReasoningStepper || typeof window.ChatReasoningStepper.setLevels !== 'function') return;
    const def = defaultProvider();
    window.ChatReasoningStepper.setLevels(def && def.reasoningEffort);
  }

  function providerSaveFields(p, overrides) {
    const row = {
      id: p.id,
      apiUrl: p.apiUrl,
      apiKey: p.apiKey,
      modelName: p.modelName,
      activeModelName: p.activeModelName,
      parameters: p.parameters || {},
      isDefault: !!p.isDefault,
      supportsVision: p.supportsVision !== undefined ? p.supportsVision : true,
      maxContextTokens: p.maxContextTokens,
      requestTimeoutMs: p.requestTimeoutMs,
    };
    if (p.headers && typeof p.headers === 'object') row.headers = p.headers;
    if (p.apiMode) row.apiMode = p.apiMode;
    if (p.reasoningEffort) row.reasoningEffort = p.reasoningEffort;
    if (overrides) {
      for (const key in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, key)) row[key] = overrides[key];
      }
    }
    return row;
  }

  function selectDefault(target, activeModel) {
    if (!target) return;
    const list = cachedProviders.slice();
    const current = list.find((p) =>  p.isDefault) || list[0];
    const currentActive = current ? resolveActiveModelName(current) : '';
    if (current && current.id === target.id && currentActive === activeModel) return;
    if (elLabel) elLabel.textContent = '切换中…';

    const payload = list.map((p) =>  providerSaveFields(p, {
        isDefault: p.id === target.id,
        activeModelName: p.id === target.id ? activeModel : p.activeModelName,
      }));

    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: payload }),
    })
      .then((res) => { return res.json().then((body) =>  ({ ok: res.ok, body })); })
      .then((result) => {
        if (!result.ok || (result.body && result.body.error)) {
          throw new Error((result.body && result.body.error) || '保存失败');
        }
        return fetch('/api/config').then((r) =>  r.json());
      })
      .then((data) => {
        const providers = (data && data.providers) || payload;
        cachedProviders = providers.map((p) => { p._masked = true; return p; });
        writeLabel();
        if (window.AppRouter && typeof window.AppRouter.refreshStatus === 'function') {
          window.AppRouter.refreshStatus();
        }
      })
      .catch((err) => {
        const def = defaultProvider();
        if (elLabel) {
          elLabel.textContent = def ? (resolveActiveModelName(def) || '未配置') : '未配置';
        }
        Notification.error('切换模型失败: ' + (err && err.message ? err.message : err));
      });
  }

  function open() {
    if (!window.ChatDropdown) return;
    // 先确保 providers 已加载：之前在打开前只 fire-and-forget，
    // 用户点 chip 太快就会拿到空数组、显示「暂无可选项」。
    const ensure = cachedProviders.length ? Promise.resolve(cachedProviders) : refreshFromServer();
    Promise.resolve(ensure).then(() => {
      const items = buildItems();
      if (!items.length) {
        Notification.info('暂无可用模型，请先在「设置」页添加。');
        return;
      }
      // 如果在 await 期间用户已经切换到别的会话、或 dropdown 被关掉了，直接放弃
      if (!elChip) return;
      const chipRect = elChip.getBoundingClientRect();
      window.ChatDropdown.open({
        anchor: elChip,
        items,
        variant: 'model',
        placement: 'top',
        placementRef: 'toolbar',
        align: 'start',
        fitContent: true,
        minWidth: Math.ceil(chipRect.width),
        maxWidth: 300,
        onSelect(item) {
          if (!item || item.type === 'separator') return;
          const target = cachedProviders.find((p) =>  p.id === item.providerId);
          if (target) selectDefault(target, item.modelName);
        },
      });
    }).catch(() => {
      const items = buildItems();
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
      .then((res) =>  res.json())
      .then((data) => {
        const providers = (data && data.providers) || [];
        setProviders(providers);
        return providers;
      })
      .catch(() => { setProviders([]); return []; })
      .then((res) => { refreshPromise = null; return res; });
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
        elChip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        });
      }
    }
    writeLabel();
  }

  return {
    init,
    open,
    close,
    toggle,
    setProviders,
    refreshFromServer,
    isOpen,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatModelPicker = ChatModelPicker;
}
