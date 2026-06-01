/**
 * 聊天会话管理模块
 * 负责：消息存取、localStorage 持久化、服务端同步、tool_trace 分离
 */

/* exported ChatSession */

window.ChatSession = (function () {
  'use strict';

  var STORAGE_KEY_MESSAGES = 'ice-chat-messages';
  var SESSION_ID = 'default';

  function getStorageKey() { return STORAGE_KEY_MESSAGES + ':' + SESSION_ID; }

  var messages = [];

  // T1-7: 首次使用多会话时，将旧 localStorage key 迁移到 default session
  (function migrateStorage() {
    try {
      var oldKey = STORAGE_KEY_MESSAGES;
      var newKey = STORAGE_KEY_MESSAGES + ':default';
      var oldData = localStorage.getItem(oldKey);
      var newData = localStorage.getItem(newKey);
      if (oldData && !newData) {
        localStorage.setItem(newKey, oldData);
        // 保留旧 key 以兼容降级回退，不删除
      }
    } catch (_e) { /* ignore */ }
  })();
  var toolTraces = {};
  var currentToolBatch = [];
  var lastSessionSyncSig = '';

  function getLiveToolStorageKey() {
    return 'ice-chat-live-tools:' + SESSION_ID;
  }

  function saveLiveToolBatch() {
    try {
      if (!currentToolBatch.length) {
        localStorage.removeItem(getLiveToolStorageKey());
        return;
      }
      localStorage.setItem(getLiveToolStorageKey(), JSON.stringify({
        tools: currentToolBatch.map(function (t) {
          return {
            toolName: t.toolName || '',
            detail: t.detail || '',
            status: t.status || 'pending',
          };
        }),
        savedAt: Date.now(),
      }));
    } catch (_e) { /* ignore */ }
  }

  function loadLiveToolBatch() {
    try {
      var raw = localStorage.getItem(getLiveToolStorageKey());
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tools)) return [];
      return parsed.tools.filter(function (t) {
        return t && typeof t.toolName === 'string' && t.toolName;
      }).map(function (t) {
        return {
          toolName: t.toolName,
          detail: typeof t.detail === 'string' ? t.detail : '',
          status: t.status || 'pending',
        };
      });
    } catch (_e) {
      return [];
    }
  }

  function clearLiveToolBatch() {
    currentToolBatch = [];
    try {
      localStorage.removeItem(getLiveToolStorageKey());
    } catch (_e) { /* ignore */ }
  }

  function replaceLiveToolBatch(tools) {
    currentToolBatch = Array.isArray(tools)
      ? tools.map(function (t) {
        return {
          toolName: t.toolName || '',
          detail: t.detail || '',
          status: t.status || 'pending',
        };
      })
      : [];
    saveLiveToolBatch();
    return currentToolBatch;
  }

  function stripStatusTag(text) {
    if (!text || typeof text !== 'string') return text;
    return text
      .replace(/<status>\s*(?:complete|incomplete)\s*<\/status>/gi, '')
      .replace(/\s*$/, '');
  }

  function serializeMessageForStorage(m) {
    var c = m.content;
    if (m.role === 'agent' && typeof c === 'string') c = stripStatusTag(c);
    var o = { role: m.role, content: c };
    if (m.id) o.id = m.id;
    if (Array.isArray(m.images) && m.images.length > 0) {
      o.images = m.images.slice();
    }
    return o;
  }

  function normalizeStoredMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var role = raw.role;
    if (role !== 'user' && role !== 'agent') return null;
    var rawContent = typeof raw.content === 'string' ? raw.content : '';
    var content = role === 'agent' ? stripStatusTag(rawContent) : rawContent;
    var o = { role: role, content: content };
    if (raw.id) o.id = raw.id;
    if (Array.isArray(raw.images) && raw.images.length > 0) {
      o.images = raw.images.filter(function (u) { return typeof u === 'string' && u; });
    }
    return o;
  }

  function saveSessionMessages() {
    var toSave = messages.map(function (m) { return serializeMessageForStorage(m); });
    try {
      localStorage.setItem(getStorageKey(), JSON.stringify(toSave));
    } catch (_e) { /* ignore */ }
  }

  function loadLocalMessages() {
    try {
      var stored = localStorage.getItem(getStorageKey());
      if (stored) {
        var parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return [];
        var out = [];
        for (var i = 0; i < parsed.length; i++) {
          var n = normalizeStoredMessage(parsed[i]);
          if (n) out.push(n);
        }
        return out;
      }
    } catch (_e) { /* ignore */ }
    return [];
  }

  function fetchServerMessages(callback) {
    var url = '/api/sessions/' + SESSION_ID + '?_t=' + Date.now();
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var msgs = (data.messages && data.messages.length > 0) ? data.messages : [];
        if (callback) callback(msgs);
      })
      .catch(function () {
        if (callback) callback([]);
      });
  }

  function hasStreamingModelBubble() {
    var last = messages[messages.length - 1];
    return !!(last && last.role === 'agent' && last._streaming);
  }

  function separateToolTraces(serverMsgs) {
    var msgs = [];
    var traces = {};
    for (var i = 0; i < serverMsgs.length; i++) {
      var m = serverMsgs[i];
      if (m.role === 'tool_trace' && m.parentId) {
        if (!traces[m.parentId]) traces[m.parentId] = [];
        traces[m.parentId].push({ toolName: m.toolName || '', detail: m.detail || '', status: m.status || 'pending' });
      } else {
        var cloned = Object.assign({}, m);
        if ((m.role === 'agent' || m.role === 'assistant') && typeof m.content === 'string') {
          cloned.content = stripStatusTag(m.content);
        }
        if (Array.isArray(m.images) && m.images.length > 0) {
          cloned.images = m.images.slice();
        }
        msgs.push(cloned);
      }
    }
    return { msgs: msgs, traces: traces };
  }

  function snapshotTraceTotals(tr) {
    var keys = Object.keys(tr || {}).sort();
    if (!keys.length) return '';
    return keys.map(function (k) { return k + '=' + tr[k].length; }).join(';');
  }

  function sessionPayloadSig(separated) {
    var ids = separated.msgs.map(function (m) { return m.id || ''; }).join(',');
    return separated.msgs.length + '|' + ids + '|' + snapshotTraceTotals(separated.traces);
  }

  function applyServerChatSnapshot(separated, options, isStreaming, wsProcessing) {
    var opts = options || {};
    if (hasStreamingModelBubble() || wsProcessing || isStreaming) return false;
    if (!opts.authoritative && separated.msgs.length < messages.length) return false;

    var sig = sessionPayloadSig(separated);
    if (sig === lastSessionSyncSig && separated.msgs.length === messages.length) {
      return false;
    }

    messages = separated.msgs;
    toolTraces = separated.traces;
    lastSessionSyncSig = sig;
    return true;
  }

  function initSession() {
    messages = loadLocalMessages();
    toolTraces = {};
    currentToolBatch = loadLiveToolBatch();
    return messages;
  }

  function saveMessages() {
    saveSessionMessages();
  }

  function flushToolBatchLocal() {
    clearLiveToolBatch();
  }

  function appendMessage(msg) {
    messages.push(msg);
  }

  function getMessages() {
    return messages;
  }

  function getToolTraces() {
    return toolTraces;
  }

  function getLastMessage() {
    return messages[messages.length - 1] || null;
  }

  function updateLastMessageContent(content) {
    var last = messages[messages.length - 1];
    if (last) last.content = content;
  }

  function markLastMessageStreaming(streaming) {
    var last = messages[messages.length - 1];
    if (!last) return;
    if (streaming) {
      last._streaming = true;
    } else {
      delete last._streaming;
    }
  }

  function getCurrentToolBatch() {
    return currentToolBatch;
  }

  function pushToolBatch(item) {
    currentToolBatch.push(item);
    saveLiveToolBatch();
  }

  function updateToolBatchStatus(toolName, status) {
    for (var i = currentToolBatch.length - 1; i >= 0; i--) {
      if (currentToolBatch[i].toolName === toolName
        && (currentToolBatch[i].status === 'pending' || currentToolBatch[i].status === 'background')) {
        currentToolBatch[i].status = status;
        break;
      }
    }
    saveLiveToolBatch();
  }

  /** 切换会话 ID（前端侧栏切换时调用） */
  function setSessionId(id) {
    SESSION_ID = id || 'default';
    messages = loadLocalMessages();
    toolTraces = {};
    currentToolBatch = loadLiveToolBatch();
    lastSessionSyncSig = '';
  }

  function getActiveId() { return SESSION_ID; }

  return {
    initSession: initSession,
    saveMessages: saveMessages,
    loadLocalMessages: loadLocalMessages,
    fetchServerMessages: fetchServerMessages,
    separateToolTraces: separateToolTraces,
    applyServerChatSnapshot: applyServerChatSnapshot,
    flushToolBatchLocal: flushToolBatchLocal,
    appendMessage: appendMessage,
    getMessages: getMessages,
    getToolTraces: getToolTraces,
    getLastMessage: getLastMessage,
    updateLastMessageContent: updateLastMessageContent,
    markLastMessageStreaming: markLastMessageStreaming,
    getCurrentToolBatch: getCurrentToolBatch,
    pushToolBatch: pushToolBatch,
    updateToolBatchStatus: updateToolBatchStatus,
    loadLiveToolBatch: loadLiveToolBatch,
    replaceLiveToolBatch: replaceLiveToolBatch,
    clearLiveToolBatch: clearLiveToolBatch,
    saveLiveToolBatch: saveLiveToolBatch,
    hasStreamingModelBubble: hasStreamingModelBubble,
    stripStatusTag: stripStatusTag,
    setSessionId: setSessionId,
    getActiveId: getActiveId,
  };
})();
