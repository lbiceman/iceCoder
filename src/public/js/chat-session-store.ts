// @ts-nocheck
/**
 * 会话 Store 模块
 * 职责：session 列表 CRUD（调用 API）、activeSessionId 状态管理
 * 模式：IIFE + window.ChatSessionStore，与现有模块一致
 */

/* exported ChatSessionStore */

export const ChatSessionStore = (() => {

  const DEFAULT_SESSION_ID = 'default';
  let activeSessionId = DEFAULT_SESSION_ID;
  let sessions = [];
  let listeners = [];
  const STORAGE_KEY_PREFIX = 'ice-chat-messages:';
  const STORAGE_KEY_LAST_ACTIVE = 'ice-chat-last-active-session';
  const TITLE_MAX_LEN = 50;
  // 与 src/web/session-title-text.ts 的占位标题保持一致（中英文）
  const PLACEHOLDER_TITLES = {
    '新会话': true,
    '默认会话': true,
    '未命名': true,
    'New chat': true,
    'Default chat': true,
    'Untitled': true,
  };
  let defaultWorkDir = '';
  let localUser = '';
  /** sessionId → workspaceRoot */
  let workspacesBySession = {};
  /** sessionId → Shell 协作是否 active（来自 GET /api/sessions 或 WS 增量更新） */
  let shellCollabActiveBySession = {};
  /** sessionId → { id, name } 当前用户 Agent */
  let agentModeBySession = {};
  /** sessionId → 定时任务会话状态 { taskId, state: current|history|deleted, enabled?, nextRunAt?, lastStatus? } */
  let scheduledTasksBySession = {};
  let runPhaseBySession = {};
  const composerDrafts = {};
  let lastApiActiveSessionId = '';

  function deriveTitleFromPrompt(prompt) {
    const t = (prompt || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length <= TITLE_MAX_LEN) return t;
    return `${t.slice(0, TITLE_MAX_LEN - 1)}…`;
  }

  function onChange(fn) { listeners.push(fn); }
  function offChange(fn) { listeners = listeners.filter((f) =>  f !== fn); }
  function emit() { for (let i = 0; i < listeners.length; i++) { try { listeners[i](); } catch (_e) { /* */ } } }

  function normalizePath(p) {
    return String(p || '').replace(/\\/g, '/').toLowerCase();
  }

  function applySessionsListPayload(data) {
    sessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (typeof data.defaultWorkDir === 'string' && data.defaultWorkDir) {
      defaultWorkDir = data.defaultWorkDir;
    }
    if (typeof data.localUser === 'string') localUser = data.localUser;
    if (data.workspaces && typeof data.workspaces === 'object') {
      workspacesBySession = data.workspaces;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'shellCollabActive')) {
      shellCollabActiveBySession = (data.shellCollabActive && typeof data.shellCollabActive === 'object')
        ? data.shellCollabActive
        : {};
    }
    if (Object.prototype.hasOwnProperty.call(data, 'agentMode')
        && data.agentMode && typeof data.agentMode === 'object'
        && !Array.isArray(data.agentMode)) {
      agentModeBySession = data.agentMode;
    }
    scheduledTasksBySession = (data.scheduledTasks && typeof data.scheduledTasks === 'object'
      && !Array.isArray(data.scheduledTasks)) ? data.scheduledTasks : {};
    if (typeof data.activeSessionId === 'string' && data.activeSessionId) {
      lastApiActiveSessionId = data.activeSessionId;
    }
    if (Array.isArray(data.sessionRunStates) && typeof applySessionRunStates === 'function') {
      applySessionRunStates(data.sessionRunStates);
    }
  }

  function getDefaultWorkDir() { return defaultWorkDir; }

  function getLocalUser() { return localUser; }

  function getSessionWorkspace(sessionId) {
    const root = workspacesBySession[sessionId];
    if (root) return root;
    return defaultWorkDir || '';
  }

  function isDefaultWorkspace(sessionId) {
    const root = getSessionWorkspace(sessionId);
    if (!root || !defaultWorkDir) return true;
    return normalizePath(root) === normalizePath(defaultWorkDir);
  }

  /** 更新单个会话的工作目录缓存（WS / 切换会话后） */
  function setSessionWorkspace(sessionId, payload) {
    if (!sessionId || !payload) return;
    if (typeof payload.defaultWorkDir === 'string' && payload.defaultWorkDir) {
      defaultWorkDir = payload.defaultWorkDir;
    }
    if (typeof payload.workspaceRoot === 'string' && payload.workspaceRoot) {
      workspacesBySession[sessionId] = payload.workspaceRoot;
    } else if (defaultWorkDir) {
      workspacesBySession[sessionId] = defaultWorkDir;
    }
    emit();
  }

  function removeSessionWorkspace(sessionId) {
    if (!sessionId || !workspacesBySession[sessionId]) return;
    delete workspacesBySession[sessionId];
  }

  /**
   * 定时任务会话状态；普通会话返回 null。
   * 列表接口没带状态（读任务失败）但会话带标记时返回 { taskId, state: 'unknown' }。
   */
  function getScheduledTaskSession(sessionId) {
    const st = scheduledTasksBySession[sessionId];
    if (st) return st;
    const s = sessions.find((x) => x.id === sessionId);
    return s && s.scheduledTaskId ? { taskId: s.scheduledTaskId, state: 'unknown' } : null;
  }

  function getShellCollabActive(sessionId) {
    return shellCollabActiveBySession[sessionId] === true;
  }

  /** WS connected / session_switched / shell_collab_* 增量更新 */
  function setShellCollabActive(sessionId, active) {
    if (!sessionId) return;
    if (active) shellCollabActiveBySession[sessionId] = true;
    else delete shellCollabActiveBySession[sessionId];
    emit();
  }

  function applyShellCollabActiveMap(map) {
    if (!map || typeof map !== 'object') return;
    shellCollabActiveBySession = map;
    emit();
  }

  function getAgentMode(sessionId) {
    const row = agentModeBySession[sessionId];
    return row && row.id ? row : null;
  }

  function setAgentMode(sessionId, agent) {
    if (!sessionId) return;
    if (agent && agent.id) agentModeBySession[sessionId] = { id: agent.id, name: agent.name || agent.id };
    else delete agentModeBySession[sessionId];
    emit();
  }

  function applyAgentModeMap(map) {
    if (!map || typeof map !== 'object') return;
    agentModeBySession = map;
    emit();
  }

  function applySessionRunState(sessionId, phase, _stopReason) {
    if (!sessionId) return;
    if (!phase || phase === 'idle') delete runPhaseBySession[sessionId];
    else runPhaseBySession[sessionId] = phase;
    emit();
  }

  function applySessionRunStates(list) {
    runPhaseBySession = {};
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (row && row.sessionId && row.phase && row.phase !== 'idle') {
          runPhaseBySession[row.sessionId] = row.phase;
        }
      }
    }
    emit();
  }

  function getRunPhase(sessionId) {
    return runPhaseBySession[sessionId] || '';
  }

  function acknowledgeRunPhase(sessionId) {
    const p = runPhaseBySession[sessionId];
    if (p !== 'done' && p !== 'error') return;
    delete runPhaseBySession[sessionId];
    emit();
    if (window.ChatWebSocket && typeof window.ChatWebSocket.send === 'function') {
      window.ChatWebSocket.send({ type: 'ack_session_run', sessionId });
    }
  }

  function getComposerDraft(sessionId) {
    return composerDrafts[sessionId] || null;
  }

  function setComposerDraft(sessionId, draft) {
    if (!sessionId) return;
    if (!draft) delete composerDrafts[sessionId];
    else composerDrafts[sessionId] = draft;
  }

  function readLastActiveSessionIdFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_LAST_ACTIVE);
      return stored || '';
    } catch (_e) {
      return '';
    }
  }

  function isRemoteTokenEntry() {
    try {
      return !!new URLSearchParams(window.location.search || '').get('token');
    } catch (_e) {
      return false;
    }
  }

  function persistLastActiveSessionId(sessionId) {
    if (!sessionId) return;
    try {
      localStorage.setItem(STORAGE_KEY_LAST_ACTIVE, sessionId);
    } catch (_e) { /* ignore */ }
  }

  function getActiveSessionId() { return activeSessionId; }

  /** 与服务端 activeSessionId 对齐（不重发 switch_session） */
  function setActiveSessionId(sessionId) {
    const id = sessionId || 'default';
    if (id === activeSessionId) return;
    activeSessionId = id;
    persistLastActiveSessionId(id);
    emit();
  }

  const SWITCH_TIMEOUT_MS = 10000;

  function pickMostRecentSessionId() {
    if (!sessions.length) return DEFAULT_SESSION_ID;
    const sorted = sessions.slice().sort((a, b) =>  (b.updatedAt || 0) - (a.updatedAt || 0));
    return sorted[0].id;
  }

  /** 解析初始选中：扫码进列表第一项；本地为最近工作 > API 推荐 > 内存 active > updatedAt 最近。 */
  function resolveInitialActiveSessionId(apiActiveId) {
    if (isRemoteTokenEntry()) {
      if (sessions.length) return sessions[0].id;
      return DEFAULT_SESSION_ID;
    }
    const stored = readLastActiveSessionIdFromStorage();
    let candidate = stored || apiActiveId || activeSessionId || DEFAULT_SESSION_ID;
    if (!sessions.some((s) =>  s.id === candidate)) {
      candidate = pickMostRecentSessionId();
    }
    return candidate;
  }

  /**
   * 拉取会话列表（GET /api/sessions）
   * @param {function(Array, string=)} callback (sessions, resolvedActiveId)
   */
  function fetchSessions(callback) {
    fetch('/api/sessions')
      .then((res) =>  res.json())
      .then((data) => {
        applySessionsListPayload(data || {});
        if (callback) callback(sessions, activeSessionId);
        emit();
      })
      .catch(() => {
        if (callback) callback(sessions, activeSessionId);
      });
  }

  /**
   * 首屏/重启：对齐最近会话并加载消息（WS 已连则 switch_session，否则仅拉 REST）。
   * @param {function(string)} onReady
   */
  function bootstrapInitialSession(onReady) {
    fetchSessions(() => {
      const id = resolveInitialActiveSessionId(lastApiActiveSessionId);
      activeSessionId = id;
      persistLastActiveSessionId(id);

      function complete(runningTurn, bgTasks, runtime) {
        if (window.ChatPage && typeof window.ChatPage.onSessionSwitched === 'function') {
          window.ChatPage.onSessionSwitched(id, runningTurn, { bgTasks, ...(runtime || {}) });
        } else if (window.ChatSession && typeof window.ChatSession.setSessionId === 'function') {
          window.ChatSession.setSessionId(id);
          if (typeof window.ChatSession.fetchServerMessages === 'function') {
            window.ChatSession.fetchServerMessages(() => {
              emit();
              if (onReady) onReady(id);
            });
            return;
          }
        }
        emit();
        if (onReady) onReady(id);
      }

      const ws = window.ChatWebSocket;
      const wsSend = ws && typeof ws.send === 'function' ? ws.send.bind(ws) : null;
      if (ws && typeof ws.isConnected === 'function' && ws.isConnected() && wsSend) {
        switchSession(id, wsSend, (ok, runningTurn, _workspace, _degraded, bgTasks, runtime) => {
          complete(ok ? runningTurn : undefined, bgTasks, runtime);
        });
        return;
      }

      if (window.ChatSession && typeof window.ChatSession.setSessionId === 'function') {
        window.ChatSession.setSessionId(id);
      }
      complete();
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
      .then((res) =>  res.json())
      .then((data) => {
        if (data.success && data.session) {
          sessions.unshift(data.session);
          if (defaultWorkDir) workspacesBySession[data.session.id] = defaultWorkDir;
          emit();
          if (callback) callback(data.session);
        }
      })
      .catch(() => { if (callback) callback(null); });
  }

  /**
   * 重命名会话（PATCH /api/sessions/:id）
   */
  function patchSession(sessionId, patch) {
    const idx = sessions.findIndex((s) =>  s.id === sessionId);
    if (idx < 0) return;
    if (patch.title) sessions[idx].title = patch.title;
    emit();
  }

  /**
   * 第一条有文字的用户消息时，把占位标题换成这段文字（与服务端一致，即时刷新侧栏）
   */
  function maybeAutoTitleFromPrompt(sessionId, prompt) {
    const idx = sessions.findIndex((s) =>  s.id === sessionId);
    if (idx < 0) return;
    if (!PLACEHOLDER_TITLES[sessions[idx].title]) return;
    const title = deriveTitleFromPrompt(prompt);
    if (!title || PLACEHOLDER_TITLES[title]) return;
    sessions[idx].title = title;
    emit();
    renameSession(sessionId, title);
  }

  function renameSession(sessionId, title, callback) {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
      .then((res) =>  res.json())
      .then((data) => {
        if (data.success && data.session) {
          const idx = sessions.findIndex((s) =>  s.id === sessionId);
          if (idx >= 0) sessions[idx] = data.session;
          emit();
          if (callback) callback(data.session);
        }
      })
      .catch(() => { if (callback) callback(null); });
  }

  /**
   * 置顶 / 取消置顶。pinnedAt 写入 data/sessions/index.json。
   * 已置顶再置顶不改时间，保证先置顶的仍在上面。
   */
  function setSessionPinned(sessionId, pinned, callback) {
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx < 0) {
      if (callback) callback(false, null);
      return;
    }
    const prevAt = sessions[idx].pinnedAt;
    if (pinned) {
      if (typeof prevAt !== 'number') sessions[idx].pinnedAt = Date.now();
    } else if (typeof prevAt === 'number') {
      delete sessions[idx].pinnedAt;
    }
    emit();
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !!pinned }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then((result) => {
        const at = sessions.findIndex((s) => s.id === sessionId);
        if (!result.ok || !result.data.success || !result.data.session) {
          if (at >= 0) {
            if (typeof prevAt === 'number') sessions[at].pinnedAt = prevAt;
            else delete sessions[at].pinnedAt;
          }
          emit();
          if (callback) callback(false, null);
          return;
        }
        if (at >= 0) sessions[at] = result.data.session;
        emit();
        if (callback) callback(true, result.data.session);
      })
      .catch(() => {
        const at = sessions.findIndex((s) => s.id === sessionId);
        if (at >= 0) {
          if (typeof prevAt === 'number') sessions[at].pinnedAt = prevAt;
          else delete sessions[at].pinnedAt;
        }
        emit();
        if (callback) callback(false, null);
      });
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
      persistLastActiveSessionId(activeSessionId);
      emit();
      if (callback) callback(true);
      return;
    }
    if (window.ChatWebSocket && typeof window.ChatWebSocket.isConnected === 'function'
        && !window.ChatWebSocket.isConnected()) {
      activeSessionId = sessionId;
      persistLastActiveSessionId(activeSessionId);
      emit();
      if (callback) callback(true);
      return;
    }
    let settled = false;
    let lastRunningTurn = null;
    let lastWorkspace = null;
    let lastBgTasks = null;
    let lastRuntime = null;
    let sendAttempts = 0;
    const maxSendAttempts = 5;

    function finish(ok, degraded) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (window.ChatWebSocket) window.ChatWebSocket.off('session_switched', handler);
      if (callback) callback(!!ok, lastRunningTurn, lastWorkspace, !!degraded, lastBgTasks, lastRuntime);
    }

    function applySwitchPayload(data) {
      activeSessionId = data.sessionId || sessionId;
      persistLastActiveSessionId(activeSessionId);
      if (data.runningTurn) lastRunningTurn = data.runningTurn;
      if (Array.isArray(data.bgTasks)) lastBgTasks = data.bgTasks;
      lastRuntime = {
        canRestore: data.canRestore === true,
        checkpointMessageIds: Array.isArray(data.checkpointMessageIds) ? data.checkpointMessageIds : [],
        harnessState: data.harnessState || '',
      };
      if (data.workspaceRoot || data.defaultWorkDir) {
        lastWorkspace = {
          sessionId: activeSessionId,
          workspaceRoot: data.workspaceRoot,
          defaultWorkDir: data.defaultWorkDir,
        };
        setSessionWorkspace(activeSessionId, lastWorkspace);
      } else {
        emit();
      }
      if (typeof data.shellCollabActive === 'boolean') {
        setShellCollabActive(activeSessionId, data.shellCollabActive);
      }
      if (Object.prototype.hasOwnProperty.call(data, 'agentMode')) {
        setAgentMode(activeSessionId, data.agentMode);
      }
    }

    function fallbackLocalSwitch(degraded) {
      activeSessionId = sessionId;
      persistLastActiveSessionId(activeSessionId);
      emit();
      finish(true, degraded);
      if (wsSend) wsSend({ type: 'switch_session', sessionId });
    }

    const handler = function (data) {
      if (!data) return;
      if (data.ok) {
        if (data.sessionId && data.sessionId !== sessionId) return;
        applySwitchPayload(data);
        finish(true, false);
        return;
      }
      if (data.reason === 'flush_failed') {
        finish(false, false);
        return;
      }
      fallbackLocalSwitch(true);
    };

    function trySendSwitch() {
      sendAttempts += 1;
      if (wsSend({ type: 'switch_session', sessionId })) return;
      if (sendAttempts < maxSendAttempts) {
        setTimeout(trySendSwitch, 80 * sendAttempts);
        return;
      }
      fallbackLocalSwitch(true);
    }

    const timer = setTimeout(() => {
      fallbackLocalSwitch(true);
    }, SWITCH_TIMEOUT_MS);

    if (window.ChatWebSocket) window.ChatWebSocket.on('session_switched', handler);
    trySendSwitch();
  }

  function pickFallbackSessionId(excludeId) {
    for (let i = 0; i < sessions.length; i++) {
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
    let switchedTo = null;

    function doDelete() {
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
        .then((res) => { return res.json().then((data) =>  ({ ok: res.ok, data })); })
        .then((result) => {
          if (!result.ok || !result.data.success) {
            if (callback) callback(false, null);
            return;
          }
          sessions = sessions.filter((s) =>  s.id !== sessionId);
          removeSessionWorkspace(sessionId);
          if (shellCollabActiveBySession[sessionId]) {
            delete shellCollabActiveBySession[sessionId];
          }
          if (agentModeBySession[sessionId]) {
            delete agentModeBySession[sessionId];
          }
          if (runPhaseBySession[sessionId]) delete runPhaseBySession[sessionId];
          if (composerDrafts[sessionId]) delete composerDrafts[sessionId];
          try { localStorage.removeItem(STORAGE_KEY_PREFIX + sessionId); } catch (_e) { /* */ }
          try {
            if (window.ChatExecutionFlowStore
              && typeof window.ChatExecutionFlowStore.clear === 'function') {
              window.ChatExecutionFlowStore.clear(sessionId);
            }
          } catch (_e) { /* */ }
          try {
            if (window.ChatPage && typeof window.ChatPage.clearShellDockCache === 'function') {
              window.ChatPage.clearShellDockCache(sessionId);
            }
          } catch (_e) { /* */ }
          emit();
          if (callback) callback(true, switchedTo ? { switchedTo } : null);
        })
        .catch(() => { if (callback) callback(false, null); });
    }

    function proceedAfterSwitch(targetId) {
      switchedTo = targetId;
      doDelete();
    }

    if (sessionId !== activeSessionId) {
      doDelete();
      return;
    }

    const fallback = pickFallbackSessionId(sessionId);
    if (fallback) {
      switchSession(fallback, wsSend, (ok) => {
        if (!ok) {
          if (callback) callback(false, null);
          return;
        }
        proceedAfterSwitch(fallback);
      });
      return;
    }

    createSession('新会话', (session) => {
      if (!session) {
        if (callback) callback(false, null);
        return;
      }
      switchSession(session.id, wsSend, (ok) => {
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
    getActiveSessionId,
    setActiveSessionId,
    fetchSessions,
    bootstrapInitialSession,
    createSession,
    patchSession,
    maybeAutoTitleFromPrompt,
    renameSession,
    setSessionPinned,
    deleteSession,
    switchSession,
    getSessions,
    getDefaultWorkDir,
    getLocalUser,
    getSessionWorkspace,
    isDefaultWorkspace,
    setSessionWorkspace,
    getScheduledTaskSession,
    getShellCollabActive,
    setShellCollabActive,
    applyShellCollabActiveMap,
    getAgentMode,
    setAgentMode,
    applyAgentModeMap,
    applySessionRunState,
    applySessionRunStates,
    getRunPhase,
    acknowledgeRunPhase,
    getComposerDraft,
    setComposerDraft,
    onChange,
    offChange,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatSessionStore = ChatSessionStore;
}
