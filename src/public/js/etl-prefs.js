/**
 * 执行透明层（ETL）前端偏好：读写、校验、旧键迁移与变更广播。
 * 纯数据层，无 DOM 依赖。
 */

/* exported EtlPrefs */

window.EtlPrefs = (function () {
  'use strict';

  var STORAGE_KEY = 'ICE_ETL_PREFS';
  var LEGACY_KEY = 'ICE_PLAN_PANEL';

  var DEFAULTS = {
    showTransparencyPanel: false,
    panelDefaultExpanded: true,
    showLlmActivity: true,
    panelWidth: 360,
  };

  var cached = null;
  var listeners = [];

  function clampPanelWidth(value) {
    var w = typeof value === 'number' ? value : parseInt(value, 10);
    if (!isFinite(w)) return DEFAULTS.panelWidth;
    return Math.min(480, Math.max(320, w));
  }

  function sanitize(raw) {
    var out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;

    if (typeof raw.showTransparencyPanel === 'boolean') {
      out.showTransparencyPanel = raw.showTransparencyPanel;
    }
    if (typeof raw.panelDefaultExpanded === 'boolean') {
      out.panelDefaultExpanded = raw.panelDefaultExpanded;
    }
    if (typeof raw.showLlmActivity === 'boolean') {
      out.showLlmActivity = raw.showLlmActivity;
    }
    out.panelWidth = clampPanelWidth(raw.panelWidth);
    return out;
  }

  function applyLegacyMigration(prefs) {
    try {
      if (localStorage.getItem(LEGACY_KEY) === '0') {
        prefs.showTransparencyPanel = false;
      }
    } catch (_e) { /* ignore */ }
    return prefs;
  }

  function persist(prefs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (_e) { /* ignore */ }
  }

  function load() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (_e) { /* ignore */ }

    var prefs;
    if (!raw) {
      prefs = applyLegacyMigration(sanitize(DEFAULTS));
      persist(prefs);
    } else {
      try {
        prefs = sanitize(JSON.parse(raw));
      } catch (_e) {
        prefs = sanitize(DEFAULTS);
      }
    }

    cached = prefs;
    return prefs;
  }

  function prefsChanged(before, after) {
    for (var key in after) {
      if (after[key] !== before[key]) return true;
    }
    return false;
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](cached);
      } catch (_e) { /* ignore */ }
    }
  }

  function get() {
    if (!cached) load();
    return Object.assign({}, cached);
  }

  function getKey(key) {
    if (!cached) load();
    return cached[key];
  }

  function set(patch) {
    if (!patch || typeof patch !== 'object') return;
    if (!cached) load();

    var before = cached;
    var next = sanitize(Object.assign({}, cached, patch));
    if (!prefsChanged(before, next)) return;

    cached = next;
    persist(cached);
    emit();
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function unsubscribe() {
      listeners = listeners.filter(function (item) { return item !== fn; });
    };
  }

  load();

  return {
    get: get,
    getKey: getKey,
    set: set,
    onChange: onChange,
  };
})();
