/**
 * 会话 Store 模块
 * 职责：session 列表 CRUD（调用 API）、activeSessionId 状态管理
 * 模式：IIFE + window.ChatSessionStore，与现有模块一致
 */

/* exported ChatSessionStore */

window.ChatSessionStore = (function () {
  'use strict';

  var DEFAULT_SESSION_ID = 'default';
  var activeSessionId = DEFAULT_SESSION_ID;
  var sessions = [];
  var listeners = [];
  var STORAGE_KEY_PREFIX = 'ice-chat-messages:';
  var TITLE_MAX_LEN = 20;
  var PLACEHOLDER_TITLES = { '新会话': true, '默认会话': true, '未命名': true };

  function deriveTitleFromPrompt(prompt) {
    var t = (prompt || '').replace(/\s+/g, ' ').trim();
    if (!t) return '未命名';
    if (t.length <= TITLE_MAX_LEN) return t;
    return t.slice(0, TITLE_MAX_LEN - 1) + '…';
  }

  function onChange(fn) { listeners.push(fn); }
  function offChange(fn) { listeners = listeners.filter(function (f) { return f !== fn; }); }
  function emit() { for (var i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (_e) { /* */ } } }

  function getActiveSessionId() { return activeSessionId; }

  /** 与服务端 activeSessionId 对齐（不重发 switch_session） */
  function setActiveSessionId(sessionId) {
    var id = sessionId || 'default';
    if (id === activeSessionId) return;
    activeSessionId = id;
    emit();
  }

  var SWITCH_TIMEOUT_MS = 10000;

  /**
   * 拉取会话列表（GET /api/sessions）
   */
  function fetchSessions(callback) {
    fetch('/api/sessions')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        sessions = Array.isArray(data.sessions) ? data.sessions : [];
        if (callback) callback(sessions);
        emit();
      })
      .catch(function () {
        if (callback) callback(sessions);
      });
  }

  /**
   * 创建新会话（POST /api/sessions）
   */
  function createSession(title, callback) {
    fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || '新会话' }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.success && data.session) {
          sessions.unshift(data.session);
          emit();
          if (callback) callback(data.session);
        }
      })
      .catch(function () { if (callback) callback(null); });
  }

  /**
   * 重命名会话（PATCH /api/sessions/:id）
   */
  function patchSession(sessionId, patch) {
    var idx = sessions.findIndex(function (s) { return s.id === sessionId; });
    if (idx < 0) return;
    if (patch.title) sessions[idx].title = patch.title;
    emit();
  }

  /**
   * 首条用户消息时，将占位标题替换为提示词截取（与服务端一致，即时刷新侧栏）
   */
  function maybeAutoTitleFromPrompt(sessionId, prompt) {
    var idx = sessions.findIndex(function (s) { return s.id === sessionId; });
    if (idx < 0) return;
    if (!PLACEHOLDER_TITLES[sessions[idx].title]) return;
    var title = deriveTitleFromPrompt(prompt);
    sessions[idx].title = title;
    emit();
    renameSession(sessionId, title);
  }

  function renameSession(sessionId, title, callback) {
    fetch('/api/sessions/' + encodeURIComponent(sessionId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.success && data.session) {
          var idx = sessions.findIndex(function (s) { return s.id === sessionId; });
          if (idx >= 0) sessions[idx] = data.session;
          emit();
          if (callback) callback(data.session);
        }
      })
      .catch(function () { if (callback) callback(null); });
  }

  /**
   * 切换活跃会话
   * 通过 WS 发送 switch_session，等待 session_switched 回复
   */
  function switchSession(sessionId, wsSend, callback) {
    if (sessionId === activeSessionId) {
      if (callback) callback(true);
      return;
    }
    if (!wsSend) {
      activeSessionId = sessionId;
      emit();
      if (callback) callback(true);
      return;
    }
    if (window.ChatWebSocket && typeof window.ChatWebSocket.isConnected === 'function'
        && !window.ChatWebSocket.isConnected()) {
      activeSessionId = sessionId;
      emit();
      if (callback) callback(true);
      return;
    }
    var settled = false;
    var lastRunningTurn = null;
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (window.ChatWebSocket) window.ChatWebSocket.off('session_switched');
      if (callback) callback(!!ok, lastRunningTurn);
    }
    var handler = function (data) {
      if (!data) return;
      if (data.ok) {
        activeSessionId = data.sessionId || sessionId;
        if (data.runningTurn) lastRunningTurn = data.runningTurn;
        emit();
      }
      finish(!!data.ok);
    };
    var timer = setTimeout(function () { finish(false); }, SWITCH_TIMEOUT_MS);
    if (window.ChatWebSocket) window.ChatWebSocket.on('session_switched', handler);
    wsSend({ type: 'switch_session', sessionId: sessionId });
  }

  function pickFallbackSessionId(excludeId) {
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id !== excludeId) return sessions[i].id;
    }
    return null;
  }

  /**
   * 删除会话（DELETE /api/sessions/:id，含 default）
   * @param {function(boolean, { switchedTo?: string }|null)} callback
   */
  function deleteSession(sessionId, wsSend, callback) {
    if (!sessionId) {
      if (callback) callback(false, null);
      return;
    }
    var switchedTo = null;

    function doDelete() {
      fetch('/api/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          if (!result.ok || !result.data.success) {
            if (callback) callback(false, null);
            return;
          }
          sessions = sessions.filter(function (s) { return s.id !== sessionId; });
          try { localStorage.removeItem(STORAGE_KEY_PREFIX + sessionId); } catch (_e) { /* */ }
          emit();
          if (callback) callback(true, switchedTo ? { switchedTo: switchedTo } : null);
        })
        .catch(function () { if (callback) callback(false, null); });
    }

    function proceedAfterSwitch(targetId) {
      switchedTo = targetId;
      doDelete();
    }

    if (sessionId !== activeSessionId) {
      doDelete();
      return;
    }

    var fallback = pickFallbackSessionId(sessionId);
    if (fallback) {
      switchSession(fallback, wsSend, function (ok) {
        if (!ok) {
          if (callback) callback(false, null);
          return;
        }
        proceedAfterSwitch(fallback);
      });
      return;
    }

    createSession('新会话', function (session) {
      if (!session) {
        if (callback) callback(false, null);
        return;
      }
      switchSession(session.id, wsSend, function (ok) {
        if (!ok) {
          if (callback) callback(false, null);
          return;
        }
        proceedAfterSwitch(session.id);
      });
    });
  }

  /**
   * 获取本地缓存的会话列表
   */
  function getSessions() { return sessions; }

  return {
    getActiveSessionId: getActiveSessionId,
    setActiveSessionId: setActiveSessionId,
    fetchSessions: fetchSessions,
    createSession: createSession,
    patchSession: patchSession,
    maybeAutoTitleFromPrompt: maybeAutoTitleFromPrompt,
    renameSession: renameSession,
    deleteSession: deleteSession,
    switchSession: switchSession,
    getSessions: getSessions,
    onChange: onChange,
    offChange: offChange,
  };
})();
