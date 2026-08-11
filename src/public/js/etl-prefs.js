/**
 * 执行透明层（ETL）前端偏好：从 config.json 读写、校验与变更广播。
 * 纯数据层，无 DOM 依赖。
 */

/* exported EtlPrefs */

window.EtlPrefs = (function () {
  'use strict';

  var DEFAULTS = {
    showTransparencyPanel: true,
    panelDefaultExpanded: true,
    panelWidth: 360,
    taskDoneNotification: false,
    panelAutoCollapse: false,
  };

  var cached = null;
  var listeners = [];
  var readyPromise = null;
  var readyResolved = false;
  var loading = false;

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
      readyPromise.promise = new Promise(function (resolve) {
        readyPromise.resolve = resolve;
      });
    }
    return readyPromise.promise;
  }

  function applyLoaded(raw) {
    var next = sanitize(raw);
    var before = cached || sanitize(DEFAULTS);
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
      .then(function (res) {
        if (!res.ok) throw new Error('fetch failed');
        return res.json();
      })
      .then(function (data) {
        applyLoaded(data && data.iceEtlPrefs);
      })
      .catch(function () {
        /* 读取失败时保留内存默认，不阻塞 UI */
      })
      .finally(function () {
        loading = false;
        resolveReady();
      });
  }

  function get() {
    if (!cached) cached = sanitize(DEFAULTS);
    return Object.assign({}, cached);
  }

  function getKey(key) {
    if (!cached) cached = sanitize(DEFAULTS);
    return cached[key];
  }

  function set(patch) {
    if (!patch || typeof patch !== 'object') return Promise.resolve(false);
    if (!cached) cached = sanitize(DEFAULTS);

    var before = cached;
    var next = sanitize(Object.assign({}, cached, patch));
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
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.body || result.body.success !== true) {
          var message = (result.body && result.body.error) || '更新失败';
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
      listeners = listeners.filter(function (item) { return item !== fn; });
    };
  }

  loadFromServer();

  return {
    get: get,
    getKey: getKey,
    set: set,
    onChange: onChange,
    whenReady: whenReady,
  };
})();
