/**
 * WebSocket 通信模块
 * 负责：连接管理、消息路由、心跳、重连、状态同步
 */

/* exported ChatWebSocket */

window.ChatWebSocket = (function () {
  'use strict';

  var chatWs = null;
  var wsProcessing = false;
  /** 用户主动 stop 后置为 true；阻止 'stream' chunk 把 wsProcessing 重置为 true，直到下次发新消息 */
  var userStoppedFlag = false;
  var lastToolProgressHint = '';
  var wsReconnectTimer = null;
  var wsReconnectAttempts = 0;
  var wsHeartbeatTimer = null;
  var wsSyncTimer = null;
  var wsConnectTimeout = null;

  var remoteToken = null;

  var handlers = {};

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
      try { chatWs.close(); } catch (_e) { /* ignore */ }
    }
    if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
    if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }

    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + window.location.host + '/api/chat/ws';
    if (remoteToken) {
      wsUrl += '?token=' + encodeURIComponent(remoteToken);
    }

    chatWs = new WebSocket(wsUrl);

    wsConnectTimeout = setTimeout(function () {
      wsConnectTimeout = null;
      if (chatWs && chatWs.readyState === WebSocket.CONNECTING) {
        try { chatWs.close(); } catch (_e) { /* ignore */ }
      }
    }, 10000);

    chatWs.onopen = function () {
      if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }
      wsReconnectAttempts = 0;
      emit('open', {});
    };

    chatWs.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        handleMessage(data);
      } catch (_err) { /* ignore */ }
    };

    chatWs.onclose = function () {
      if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }
      wsProcessing = false;
      emit('close', {});
      scheduleReconnect();
    };

    chatWs.onerror = function () { /* onclose handles it */ };

    wsHeartbeatTimer = setInterval(function () {
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
  }

  function handleMessage(data) {
    switch (data.type) {
      case 'connected':
        emit('connected', data || {});
        break;
      case 'session_updated':
        emit('session_updated', data || {});
        break;
      case 'stream':
        if (!wsProcessing && !userStoppedFlag) wsProcessing = true;
        emit('stream', { delta: data.delta || '' });
        break;
      case 'stream_end':
        emit('stream_end', {});
        break;
      case 'response':
        emit('response', { content: data.content || '' });
        break;
      case 'step':
        emit('step', { step: data.step });
        break;
      case 'status':
        if (data.status === 'processing') {
          if (!userStoppedFlag) wsProcessing = true;
        } else {
          wsProcessing = false;
          userStoppedFlag = false;
        }
        emit('status', { status: data.status });
        break;
      case 'error':
        emit('error', { message: data.message });
        break;
      case 'info':
        emit('info', { message: data.message });
        break;
      case 'memory_notice':
        emit('memory_notice', { notices: data.notices });
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
        emit('confirm', { confirmId: data.confirmId, toolName: data.toolName, args: data.args });
        break;
      case 'confirm_resolved':
        emit('confirm_resolved', {
          confirmId: data.confirmId || '',
          toolName: data.toolName || '',
          approved: !!data.approved,
          reason: data.reason || 'reply',
        });
        break;
      case 'confirm_timeout':
        emit('confirm_timeout', { confirmId: data.confirmId || '', toolName: data.toolName || '' });
        break;
      case 'tokenUsage':
        emit('tokenUsage', {
          inputTokens: data.inputTokens || 0,
          outputTokens: data.outputTokens || 0,
          effectiveUsed: data.effectiveUsed,
          contextWindow: data.contextWindow,
          totalInputTokens: data.totalInputTokens,
          totalOutputTokens: data.totalOutputTokens,
        });
        break;
      case 'session_switched':
        emit('session_switched', data);
        break;
      case 'workspace_updated':
        emit('workspace_updated', data);
        break;
      case 'active_session':
        emit('active_session', data);
        break;
      case 'tool_output':
        emit('tool_output', { toolName: data.toolName || '', content: data.content || '' });
        break;
      case 'pong':
        break;
      case 'pulse':
        emit('pulse', { hint: lastToolProgressHint || '处理中' });
        break;
      case 'bg_task_update':
        emit('bg_task_update', {
          sessionId: data.sessionId || '',
          timestamp: data.timestamp || '',
          tasks: Array.isArray(data.tasks) ? data.tasks : [],
        });
        break;
    }
  }

  function send(msg) {
    if (msg && typeof msg === 'object' && msg.type === 'message') {
      userStoppedFlag = false;
    }
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify(msg));
    }
  }

  function sendMessage(text) {
    send({ type: 'message', content: text });
  }

  function sendStop() {
    userStoppedFlag = true;
    wsProcessing = false;
    send({ type: 'stop' });
  }

  function sendConfirmReply(approved, confirmId) {
    var payload = { type: 'confirm_reply', approved: approved };
    if (confirmId) payload.confirmId = confirmId;
    send(payload);
  }

  function scheduleReconnect() {
    stopSyncPolling();
    if (wsReconnectTimer) return;
    var delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(function () {
      wsReconnectTimer = null;
      connect(remoteToken);
    }, delay);
  }

  function startSyncPolling() {
    stopSyncPolling();
    wsSyncTimer = setInterval(function () {
      if (!wsProcessing) {
        emit('sync', {});
      }
    }, 5000);
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

  function setProcessing(v) {
    wsProcessing = v;
  }

  function isProcessing() {
    return wsProcessing;
  }

  function setLastToolProgressHint(hint) {
    lastToolProgressHint = hint || '';
  }

  return {
    connect: connect,
    disconnect: disconnect,
    send: send,
    sendMessage: sendMessage,
    sendStop: sendStop,
    sendConfirmReply: sendConfirmReply,
    on: on,
    off: off,
    isConnected: isConnected,
    isProcessing: isProcessing,
    setProcessing: setProcessing,
    startSyncPolling: startSyncPolling,
    stopSyncPolling: stopSyncPolling,
    setLastToolProgressHint: setLastToolProgressHint,
  };
})();
