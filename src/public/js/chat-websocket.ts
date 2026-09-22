// @ts-nocheck
/**
 * WebSocket 通信模块
 * 负责：连接管理、消息路由、心跳、重连、状态同步
 */

/* exported ChatWebSocket */

export const ChatWebSocket = (() => {

  let chatWs = null;
  let processingBySession = {};
  let userStoppedBySession = {};
  let harnessCanRestore = true;
  let checkpointMessageIds = [];

  function getViewportSessionId() {
    if (window.ChatSessionStore && typeof window.ChatSessionStore.getActiveSessionId === 'function') {
      return window.ChatSessionStore.getActiveSessionId() || '';
    }
    if (window.ChatSession && typeof window.ChatSession.getActiveId === 'function') {
      return window.ChatSession.getActiveId() || '';
    }
    return '';
  }

  function isForeignSessionEvent(data) {
    if (!data || !data.sessionId) return false;
    return data.sessionId !== getViewportSessionId();
  }

  const TASK_PAINT_TYPES = {
    stream: 1,
    reasoning_stream: 1,
    stream_end: 1,
    response: 1,
    step: 1,
    status: 1,
    pulse: 1,
    tokenUsage: 1,
    confirm: 1,
    confirm_resolved: 1,
    confirm_timeout: 1,
    tool_output: 1,
    memory_notice: 1,
    harness_state: 1,
    error: 1,
    info: 1,
    runtime_restored: 1,
    message_deleted: 1,
    checkpoint_captured: 1,
  };

  function applySessionRunStates(list) {
    if (!window.ChatSessionStore || typeof window.ChatSessionStore.applySessionRunStates !== 'function') return;
    window.ChatSessionStore.applySessionRunStates(list);
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      if (!row || !row.sessionId) continue;
      processingBySession[row.sessionId] = row.phase === 'running';
    }
  }

  function applySessionRunState(data) {
    if (!data || !data.sessionId) return;
    const phase = data.phase || 'idle';
    processingBySession[data.sessionId] = phase === 'running';
    if (phase !== 'running') userStoppedBySession[data.sessionId] = false;
    if (window.ChatSessionStore && typeof window.ChatSessionStore.applySessionRunState === 'function') {
      window.ChatSessionStore.applySessionRunState(data.sessionId, phase, data.stopReason);
    }
    if ((phase === 'done' || phase === 'error') && data.sessionId !== getViewportSessionId()) {
      if (window.ChatPetBridge && typeof window.ChatPetBridge.notifyBackgroundTaskDone === 'function') {
        window.ChatPetBridge.notifyBackgroundTaskDone({
          sessionId: data.sessionId,
          success: phase === 'done',
        });
      }
    }
  }

  function applyCheckpointMessageIds(ids) {
    if (!Array.isArray(ids)) return;
    checkpointMessageIds = ids.slice();
    emit('checkpoint_message_ids', { ids: checkpointMessageIds });
  }
  let lastToolProgressHint = '';
  let wsReconnectTimer = null;
  let wsReconnectAttempts = 0;
  let wsHeartbeatTimer = null;
  let wsSyncTimer = null;
  let wsConnectTimeout = null;

  let remoteToken = null;

  const handlers = {};

  function on(type, fn) {
    handlers[type] = fn;
  }

  function off(type) {
    delete handlers[type];
  }

  function emit(type, data) {
    if (handlers[type]) handlers[type](data);
  }

  function connect(token) {
    remoteToken = token || null;
    if (chatWs) {
      if (chatWs.readyState === WebSocket.OPEN || chatWs.readyState === WebSocket.CONNECTING) {
        return;
      }
      try { chatWs.close(); } catch (_e) { /* ignore */ }
      chatWs = null;
    }
    if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
    if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/api/chat/ws`;
    if (remoteToken) {
      wsUrl += `?token=${encodeURIComponent(remoteToken)}`;
    }

    chatWs = new WebSocket(wsUrl);

    wsConnectTimeout = setTimeout(() => {
      wsConnectTimeout = null;
      if (chatWs && chatWs.readyState === WebSocket.CONNECTING) {
        try { chatWs.close(); } catch (_e) { /* ignore */ }
      }
    }, 10000);

    chatWs.onopen = () => {
      if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }
      wsReconnectAttempts = 0;
      emit('open', {});
    };

    chatWs.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        handleMessage(data);
      } catch (_err) { /* ignore */ }
    };

    chatWs.onclose = () => {
      if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }
      processingBySession = {};
      userStoppedBySession = {};
      emit('close', {});
      scheduleReconnect();
    };

    chatWs.onerror = () => { /* onclose handles it */ };

    wsHeartbeatTimer = setInterval(() => {
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
  }

  function shouldEmitTaskEvent(data) {
    if (!data || !TASK_PAINT_TYPES[data.type]) return true;
    if (!data.sessionId) {
      // 连接本地 info/error（用法提示、未订阅）仍展示；其它任务向包必须带 sid
      return data.type === 'info' || data.type === 'error';
    }
    return data.sessionId === getViewportSessionId();
  }

  function handleMessage(data) {
    if (data.type === 'session_run_state') {
      applySessionRunState(data);
      return;
    }
    if (TASK_PAINT_TYPES[data.type] && !shouldEmitTaskEvent(data)) {
      if (data.type === 'status' && data.sessionId) {
        if (data.status === 'processing') processingBySession[data.sessionId] = true;
        else processingBySession[data.sessionId] = false;
      }
      return;
    }
    const sid = data.sessionId || '';
    const viewportSid = getViewportSessionId();
    const stopped = !!userStoppedBySession[sid || viewportSid];
    switch (data.type) {
      case 'connected':
        if (typeof data.canRestore === 'boolean') harnessCanRestore = data.canRestore;
        applyCheckpointMessageIds(data.checkpointMessageIds);
        if (Array.isArray(data.sessionRunStates)) applySessionRunStates(data.sessionRunStates);
        emit('connected', data || {});
        break;
      case 'session_updated':
        emit('session_updated', data || {});
        break;
      case 'sessions_index_updated':
        emit('sessions_index_updated', data || {});
        break;
      case 'user_message_appended':
        emit('user_message_appended', {
          sessionId: data.sessionId || '',
          message: data.message || null,
        });
        break;
      case 'stream':
        if (!processingBySession[sid || viewportSid] && !stopped) {
          processingBySession[sid || viewportSid] = true;
        }
        emit('stream', { delta: data.delta || '', sessionId: sid });
        break;
      case 'reasoning_stream':
        if (!processingBySession[sid || viewportSid] && !stopped) {
          processingBySession[sid || viewportSid] = true;
        }
        emit('reasoning_stream', { delta: data.delta || '', sessionId: sid });
        break;
      case 'stream_end':
        emit('stream_end', { sessionId: sid });
        break;
      case 'response':
        emit('response', { content: data.content || '', sessionId: sid });
        break;
      case 'step':
        emit('step', { step: data.step, sessionId: sid });
        break;
      case 'status':
        if (data.status === 'processing') {
          if (!stopped) processingBySession[sid || viewportSid] = true;
        } else {
          processingBySession[sid || viewportSid] = false;
          userStoppedBySession[sid || viewportSid] = false;
        }
        emit('status', { status: data.status, sessionId: sid });
        break;
      case 'error':
        if (data.sessionId && data.sessionId !== viewportSid) break;
        emit('error', { message: data.message, sessionId: sid });
        break;
      case 'info':
        if (data.sessionId && data.sessionId !== viewportSid) break;
        emit('info', { message: data.message, sessionId: sid });
        break;
      case 'also_note_appended':
        emit('also_note_appended', {
          sessionId: data.sessionId || '',
          message: data.message || null,
        });
        break;
      case 'also_rejected':
        emit('also_rejected', {
          sessionId: data.sessionId || '',
          message: data.message || '',
        });
        break;
      case 'task_queue_updated':
        emit('task_queue_updated', {
          sessionId: data.sessionId || '',
          items: Array.isArray(data.items) ? data.items : [],
        });
        break;
      case 'memory_notice':
        emit('memory_notice', { notices: data.notices, sessionId: sid });
        break;
      case 'mcp_ready':
        emit('mcp_ready', {
          ok: data.ok !== false,
          toolCount: typeof data.toolCount === 'number' ? data.toolCount : 0,
          readyServers: typeof data.readyServers === 'number' ? data.readyServers : 0,
          errorMessage: data.errorMessage,
        });
        break;
      case 'tunnel_ready':
        emit('tunnel_ready', { url: data.url || '' });
        break;
      case 'confirm':
        emit('confirm', {
          confirmId: data.confirmId,
          toolName: data.toolName,
          args: data.args,
          confirmKind: data.confirmKind,
          shellMandatory: data.shellMandatory,
          sessionId: sid,
        });
        break;
      case 'confirm_resolved':
        emit('confirm_resolved', {
          confirmId: data.confirmId || '',
          toolName: data.toolName || '',
          approved: !!data.approved,
          reason: data.reason || 'reply',
          sessionId: sid,
        });
        break;
      case 'confirm_timeout':
        emit('confirm_timeout', {
          confirmId: data.confirmId || '',
          toolName: data.toolName || '',
          sessionId: sid,
        });
        break;
      case 'tokenUsage':
        emit('tokenUsage', {
          inputTokens: data.inputTokens || 0,
          outputTokens: data.outputTokens || 0,
          effectiveUsed: data.effectiveUsed,
          contextWindow: data.contextWindow,
          totalInputTokens: data.totalInputTokens,
          totalOutputTokens: data.totalOutputTokens,
          messageId: data.messageId || '',
          usedModel: typeof data.usedModel === 'string' ? data.usedModel : '',
          sessionId: sid,
        });
        break;
      case 'session_switched':
        emit('session_switched', data);
        break;
      case 'shell_collab_entered':
        emit('shell_collab_entered', data || {});
        break;
      case 'shell_collab_resumed':
        emit('shell_collab_resumed', data || {});
        break;
      case 'plan_mode_entered':
        emit('plan_mode_entered', data || {});
        break;
      case 'plan_mode_exited':
        emit('plan_mode_exited', data || {});
        break;
      case 'session_cleared':
        emit('session_cleared', data || {});
        break;
      case 'workspace_updated':
        emit('workspace_updated', data);
        break;
      case 'active_session':
        emit('active_session', data);
        break;
      case 'tool_output':
        emit('tool_output', {
          toolCallId: data.toolCallId || '',
          toolName: data.toolName || '',
          content: data.content || '',
          sessionId: sid,
        });
        break;
      case 'pong':
        break;
      case 'pulse':
        emit('pulse', { hint: lastToolProgressHint || '处理中', sessionId: sid });
        break;
      case 'bg_task_update':
        emit('bg_task_update', {
          sessionId: data.sessionId || '',
          timestamp: data.timestamp || '',
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
        });
        break;
      case 'bg_task_stop_result':
        emit('bg_task_stop_result', {
          ok: !!data.ok,
          taskId: data.taskId || '',
          sessionId: data.sessionId || '',
          error: data.error || '',
        });
        break;
      case 'harness_state':
        if (typeof data.canRestore === 'boolean') harnessCanRestore = data.canRestore;
        if (Array.isArray(data.checkpointMessageIds)) {
          applyCheckpointMessageIds(data.checkpointMessageIds);
        }
        emit('harness_state', {
          state: data.state || 'idle',
          canRestore: harnessCanRestore,
          sessionId: data.sessionId || '',
          checkpointMessageIds,
        });
        break;
      case 'checkpoint_captured':
        if (data.messageId && !checkpointMessageIds.includes(data.messageId)) {
          checkpointMessageIds.push(data.messageId);
          emit('checkpoint_message_ids', { ids: checkpointMessageIds.slice() });
        }
        break;
      case 'checkpoint_capture_failed':
        emit('checkpoint_capture_failed', {
          messageId: data.messageId || '',
          error: data.error || '',
        });
        break;
      case 'runtime_restored':
        processingBySession[sid || viewportSid] = false;
        userStoppedBySession[sid || viewportSid] = false;
        if (Array.isArray(data.checkpointMessageIds)) {
          applyCheckpointMessageIds(data.checkpointMessageIds);
        }
        emit('runtime_restored', data || {});
        break;
      case 'restore_failed':
        emit('restore_failed', { error: data.error || '回滚失败。' });
        break;
      case 'message_deleted':
        if (Array.isArray(data.checkpointMessageIds)) {
          applyCheckpointMessageIds(data.checkpointMessageIds);
        }
        emit('message_deleted', data || {});
        break;
      case 'delete_message_failed':
        emit('delete_message_failed', {
          error: data.error || '删除失败。',
          code: data.code || '',
        });
        break;
    }
  }

  function send(msg) {
    if (msg && typeof msg === 'object' && msg.type === 'message') {
      userStoppedBySession[getViewportSessionId()] = false;
    }
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function sendRestoreRuntime(messageId) {
    return send({ type: 'restore_runtime', messageId });
  }

  function sendDeleteUserMessage(messageId) {
    return send({ type: 'delete_user_message', messageId });
  }

  function canRestoreRuntime() {
    return harnessCanRestore && !isProcessing();
  }

  function canDeleteUserMessage() {
    return harnessCanRestore && !isProcessing();
  }

  function parseReasoningEffort(raw) {
    if (typeof raw !== 'string') return null;
    const token = raw.trim().toLowerCase();
    return /^[a-z][\w.-]{0,31}$/.test(token) ? token : null;
  }

  function resolveReasoningEffort(opts) {
    const fromOpts = opts && parseReasoningEffort(opts.reasoningEffort);
    if (fromOpts) return fromOpts;
    if (window.ChatReasoningStepper && typeof window.ChatReasoningStepper.getLevel === 'function') {
      return parseReasoningEffort(window.ChatReasoningStepper.getLevel());
    }
    return null;
  }

  function sendMessage(text, opts) {
    const payload = { type: 'message', content: text };
    opts = opts || {};
    if (opts.messageId) payload.messageId = opts.messageId;
    if (opts.images && opts.images.length > 0) payload.images = opts.images;
    if (opts.referencePaths && opts.referencePaths.length > 0) payload.referencePaths = opts.referencePaths;
    if (opts.skills && opts.skills.length > 0) payload.skills = opts.skills;
    if (typeof opts.queueInsertIndex === 'number') payload.queueInsertIndex = opts.queueInsertIndex;
    if (opts.source) payload.source = opts.source;
    if (opts.command) payload.command = opts.command;
    const reasoningEffort = resolveReasoningEffort(opts);
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort;
    const sent = send(payload);
    if (sent) processingBySession[getViewportSessionId()] = true;
    return sent;
  }

  function sendStop() {
    const id = getViewportSessionId();
    userStoppedBySession[id] = true;
    processingBySession[id] = false;
    send({ type: 'stop' });
  }

  function sendConfirmReply(approved, confirmId) {
    const payload = { type: 'confirm_reply', approved };
    if (confirmId) payload.confirmId = confirmId;
    send(payload);
  }

  function scheduleReconnect() {
    stopSyncPolling();
    if (wsReconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connect(remoteToken);
    }, delay);
  }

  function getSyncIntervalMs() {
    try {
      if (document.documentElement.getAttribute('data-shell') === 'mobile') return 15000;
    } catch (_e) { /* ignore */ }
    return 5000;
  }

  function startSyncPolling() {
    stopSyncPolling();
    wsSyncTimer = setInterval(() => {
      if (!isProcessing()) {
        emit('sync', {});
      }
    }, getSyncIntervalMs());
  }

  function stopSyncPolling() {
    if (wsSyncTimer) { clearInterval(wsSyncTimer); wsSyncTimer = null; }
  }

  function disconnect() {
    stopSyncPolling();
    if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (chatWs) {
      try { chatWs.close(); } catch (_e) { /* ignore */ }
      chatWs = null;
    }
  }

  function isConnected() {
    return !!(chatWs && chatWs.readyState === WebSocket.OPEN);
  }

  function setProcessing(v, sessionId) {
    processingBySession[sessionId || getViewportSessionId()] = !!v;
  }

  function isProcessing(sessionId) {
    return !!processingBySession[sessionId || getViewportSessionId()];
  }

  function setLastToolProgressHint(hint) {
    lastToolProgressHint = hint || '';
  }

  return {
    connect,
    disconnect,
    send,
    sendMessage,
    sendStop,
    sendConfirmReply,
    sendRestoreRuntime,
    sendDeleteUserMessage,
    canRestoreRuntime,
    canDeleteUserMessage,
    on,
    off,
    isConnected,
    isProcessing,
    setProcessing,
    startSyncPolling,
    stopSyncPolling,
    setLastToolProgressHint,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatWebSocket = ChatWebSocket;
}
