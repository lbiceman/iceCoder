/**
 * 执行流本地持久化 — 每个 session 仅保留最近一次工作情况。
 *
 * 存储形态：localStorage[`ice-etl-flow:{sessionId}`] = [ latestSnapshot ]
 * 数组恒为 0 或 1 项；新一轮执行流写入时整体覆盖，不保留历史。
 */

/* exported ChatExecutionFlowStore */

window.ChatExecutionFlowStore = (function () {
  'use strict';

  var STORAGE_PREFIX = 'ice-etl-flow:';
  var FLOW_VERSION = 1;

  function storageKey(sessionId) {
    return STORAGE_PREFIX + (sessionId || 'default');
  }

  /**
   * 保存当前 session 的最近一次执行流快照（覆盖旧值）。
   * @param {string} sessionId
   * @param {object} snapshot
   */
  function save(sessionId, snapshot) {
    if (!sessionId || !snapshot || typeof snapshot !== 'object') return;
    try {
      var entry = Object.assign({}, snapshot, {
        version: FLOW_VERSION,
        savedAt: typeof snapshot.savedAt === 'number' ? snapshot.savedAt : Date.now(),
        sessionId: sessionId,
      });
      localStorage.setItem(storageKey(sessionId), JSON.stringify([entry]));
    } catch (_e) { /* quota / private mode */ }
  }

  /**
   * 读取 session 最近一次执行流快照；无数据时返回 null。
   * @param {string} sessionId
   * @returns {object|null}
   */
  function load(sessionId) {
    if (!sessionId) return null;
    try {
      var raw = localStorage.getItem(storageKey(sessionId));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) return null;
      var entry = parsed[parsed.length - 1];
      if (!entry || typeof entry !== 'object') return null;
      if (entry.version !== FLOW_VERSION) return null;
      return entry;
    } catch (_e) {
      return null;
    }
  }

  /** 删除指定 session 的执行流缓存。 */
  function clear(sessionId) {
    if (!sessionId) return;
    try {
      localStorage.removeItem(storageKey(sessionId));
    } catch (_e) { /* ignore */ }
  }

  return {
    save: save,
    load: load,
    clear: clear,
  };
})();
