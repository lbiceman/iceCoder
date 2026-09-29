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
    sidebarWidth: 256,
    taskDoneNotification: false,
    panelAutoCollapse: false,
    showDesktopPet: true,
  };

  let cached = null;
  let listeners = [];
  let readyPromise = null;
  let readyResolved = false;
  let loading = false;

  const PANEL_WIDTH_MIN = 240;
  const PANEL_WIDTH_MAX = 640;
  const SIDEBAR_WIDTH_MIN = 200;
  const SIDEBAR_WIDTH_MAX = 480;

  function clampWidth(value, fallback, min, max) {
    const w = typeof value === 'number' ? value : parseInt(value, 10);
    if (!isFinite(w)) return fallback;
    return Math.round(Math.min(max, Math.max(min, w)));
  }

  /**
   * 拖拽宽度的本地锁定。
   * 运行中的配置接口若拒绝 sidebarWidth，或把 panelWidth 收成旧档位，
   * 仍保留用户松手时的像素，避免界面缩回。服务端原样接受后即去掉锁定。
   */
  const WIDTH_LOCK_KEY = 'ice-etl-width-lock';

  function readWidthLock() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage || typeof localStorage.getItem !== 'function') {
        return {};
      }
      const raw = JSON.parse(localStorage.getItem(WIDTH_LOCK_KEY) || 'null');
      if (!raw || typeof raw !== 'object') return {};
      const out = {};
      if (typeof raw.panelWidth === 'number' && isFinite(raw.panelWidth)) {
        out.panelWidth = clampWidth(raw.panelWidth, DEFAULTS.panelWidth, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX);
      }
      if (typeof raw.sidebarWidth === 'number' && isFinite(raw.sidebarWidth)) {
        out.sidebarWidth = clampWidth(raw.sidebarWidth, DEFAULTS.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
      }
      return out;
    } catch (_e) {
      return {};
    }
  }

  function writeWidthLock(lock) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      if (!lock || (lock.panelWidth == null && lock.sidebarWidth == null)) {
        localStorage.removeItem(WIDTH_LOCK_KEY);
        return;
      }
      localStorage.setItem(WIDTH_LOCK_KEY, JSON.stringify(lock));
    } catch (_e) { /* ignore */ }
  }

  function overlayWidthLock(prefs) {
    const lock = readWidthLock();
    if (lock.panelWidth == null && lock.sidebarWidth == null) return prefs;
    return { ...prefs, ...lock };
  }

  function rememberRequestedWidths(next, patch) {
    if (!patch) return;
    const lock = readWidthLock();
    let changed = false;
    if (typeof patch.panelWidth === 'number') {
      lock.panelWidth = next.panelWidth;
      changed = true;
    }
    if (typeof patch.sidebarWidth === 'number') {
      lock.sidebarWidth = next.sidebarWidth;
      changed = true;
    }
    if (changed) writeWidthLock(lock);
  }

  function clearLockIfServerAgrees(serverPrefs) {
    const lock = readWidthLock();
    let changed = false;
    if (lock.panelWidth != null && serverPrefs.panelWidth === lock.panelWidth) {
      delete lock.panelWidth;
      changed = true;
    }
    if (lock.sidebarWidth != null && serverPrefs.sidebarWidth === lock.sidebarWidth) {
      delete lock.sidebarWidth;
      changed = true;
    }
    if (changed) writeWidthLock(lock);
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
    if (typeof raw.showDesktopPet === 'boolean') {
      out.showDesktopPet = raw.showDesktopPet;
    }
    out.panelWidth = clampWidth(raw.panelWidth, DEFAULTS.panelWidth, PANEL_WIDTH_MIN, PANEL_WIDTH_MAX);
    out.sidebarWidth = clampWidth(raw.sidebarWidth, DEFAULTS.sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
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
    return overlayWidthLock({ ...cached });
  }

  function getKey(key) {
    if (!cached) cached = sanitize(DEFAULTS);
    const locked = overlayWidthLock(cached);
    return locked[key];
  }

  function set(patch) {
    if (!patch || typeof patch !== 'object') return Promise.resolve(false);
    if (!cached) cached = sanitize(DEFAULTS);

    const before = cached;
    const next = sanitize({ ...cached, ...patch });
    if (!prefsChanged(before, next)) return Promise.resolve(true);
    rememberRequestedWidths(next, patch);

    if (typeof fetch !== 'function') {
      cached = next;
      clearLockIfServerAgrees(next);
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
        clearLockIfServerAgrees(cached);
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
