// @ts-nocheck
/**
 * 执行透明层（ETL）前端偏好：从 config.json 读写、校验与变更广播。
 * 纯数据层，无 DOM 依赖。
 */

/* exported EtlPrefs */

export const EtlPrefs = (() => {

  const DEFAULTS = {
    showTransparencyPanel: true,
    panelDefaultExpanded: true,
    panelWidth: 320,
    taskDoneNotification: false,
    panelAutoCollapse: false,
  };

  let cached = null;
  let listeners = [];
  let readyPromise = null;
  let readyResolved = false;
  let loading = false;

  const ALLOWED_PANEL_WIDTHS = [280, 320, 380];

  function clampPanelWidth(value) {
    const w = typeof value === 'number' ? value : parseInt(value, 10);
    if (!isFinite(w)) return DEFAULTS.panelWidth;
    let best = ALLOWED_PANEL_WIDTHS[0];
    let bestDist = Math.abs(w - best);
    for (let i = 1; i < ALLOWED_PANEL_WIDTHS.length; i++) {
      const d = Math.abs(w - ALLOWED_PANEL_WIDTHS[i]);
      if (d < bestDist) {
        best = ALLOWED_PANEL_WIDTHS[i];
        bestDist = d;
      }
    }
    return best;
  }

  function sanitize(raw) {
    const out = { ...DEFAULTS };
    if (!raw || typeof raw !== 'object') return out;

    if (typeof raw.showTransparencyPanel === 'boolean') {
      out.showTransparencyPanel = raw.showTransparencyPanel;
    }
    if (typeof raw.panelDefaultExpanded === 'boolean') {
      out.panelDefaultExpanded = raw.panelDefaultExpanded;
    }
    if (typeof raw.taskDoneNotification === 'boolean') {
      out.taskDoneNotification = raw.taskDoneNotification;
    }
    if (typeof raw.panelAutoCollapse === 'boolean') {
      out.panelAutoCollapse = raw.panelAutoCollapse;
    }
    out.panelWidth = clampPanelWidth(raw.panelWidth);
    return out;
  }

  function prefsChanged(before, after) {
    for (const key in after) {
      if (after[key] !== before[key]) return true;
    }
    return false;
  }

  function emit() {
    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](cached);
      } catch (_e) { /* ignore */ }
    }
  }

  function resolveReady() {
    if (readyResolved) return;
    readyResolved = true;
    if (readyPromise && typeof readyPromise.resolve === 'function') {
      readyPromise.resolve();
    }
  }

  function whenReady() {
    if (readyResolved) return Promise.resolve();
    if (!readyPromise) {
      readyPromise = {};
      readyPromise.promise = new Promise((resolve) => {
        readyPromise.resolve = resolve;
      });
    }
    return readyPromise.promise;
  }

  function applyLoaded(raw) {
    const next = sanitize(raw);
    const before = cached || sanitize(DEFAULTS);
    cached = next;
    if (prefsChanged(before, next)) emit();
  }

  function loadFromServer() {
    if (loading) return whenReady();
    loading = true;
    if (!cached) cached = sanitize(DEFAULTS);

    if (typeof fetch !== 'function') {
      resolveReady();
      return whenReady();
    }

    return fetch('/api/config')
      .then((res) => {
        if (!res.ok) throw new Error('fetch failed');
        return res.json();
      })
      .then((data) => {
        applyLoaded(data && data.iceEtlPrefs);
      })
      .catch(() => {
        /* 读取失败时保留内存默认，不阻塞 UI */
      })
      .finally(() => {
        loading = false;
        resolveReady();
      });
  }

  function get() {
    if (!cached) cached = sanitize(DEFAULTS);
    return { ...cached };
  }

  function getKey(key) {
    if (!cached) cached = sanitize(DEFAULTS);
    return cached[key];
  }

  function set(patch) {
    if (!patch || typeof patch !== 'object') return Promise.resolve(false);
    if (!cached) cached = sanitize(DEFAULTS);

    const before = cached;
    const next = sanitize({ ...cached, ...patch });
    if (!prefsChanged(before, next)) return Promise.resolve(true);

    if (typeof fetch !== 'function') {
      cached = next;
      emit();
      return Promise.resolve(true);
    }

    return fetch('/api/config/ice-etl-prefs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iceEtlPrefs: patch }),
    })
      .then((res) => {
        return res.json().then((body) =>  ({ ok: res.ok, body }));
      })
      .then((result) => {
        if (!result.ok || !result.body || result.body.success !== true) {
          const message = (result.body && result.body.error) || '更新失败';
          return Promise.reject(new Error(message));
        }
        cached = sanitize(result.body.iceEtlPrefs || next);
        emit();
        return true;
      });
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function unsubscribe() {
      listeners = listeners.filter((item) => item !== fn);
    };
  }

  loadFromServer();

  return {
    get,
    getKey,
    set,
    onChange,
    whenReady,
  };
})();

if (typeof window !== 'undefined') {
  window.EtlPrefs = EtlPrefs;
}
