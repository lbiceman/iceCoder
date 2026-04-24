/**
 * 聊天页面模块。
 * 渲染聊天界面，包含消息输入、文件上传、SSE 流式传输、
 * 流水线进度条和阶段状态标签。
 */

/* exported ChatPage */

window.ChatPage = (function () {
  'use strict';

  // ---- Constants ----
  var SUPPORTED_EXTENSIONS = []; // 不限制，允许所有格式
  var supportedPattern = null;
  var STAGE_NAMES = [
    'Requirement Analysis',
    'Design',
    'Task Generation',
    'Code Writing',
    'Testing',
    'Requirement Verification'
  ];

  // ---- localStorage keys ----
  var STORAGE_KEY_MESSAGES = 'ice-chat-messages';
  var STORAGE_KEY_SESSIONS = 'ice-chat-sessions';   // [{id, title, updatedAt}]
  var STORAGE_KEY_ACTIVE = 'ice-chat-active-session'; // 当前会话 id

  // ---- State ----
  var container = null;
  var messages = [];       // { role: 'user'|'agent', content: string }
  var uploadedFile = null; // { fileId, filename, size } or null
  var currentExecutionId = null;
  var stages = [];         // { name, status }
  var agentResponseBuffer = ''; // accumulates streaming chunks
  var isStreaming = false;      // 是否正在流式传输
  var currentSessionId = null;  // 当前会话 ID

  // ---- 远程模式（仅控制 UI 差异，通信方式统一用 WebSocket） ----
  var remoteMode = false;       // 是否为远程控制模式（带 token）
  var remoteToken = null;       // 远程 token（移动端扫码用）

  // ---- WebSocket（PC 和移动端统一） ----
  var chatWs = null;            // WebSocket 连接
  var wsProcessing = false;     // 是否正在处理消息
  var wsReconnectTimer = null;
  var wsReconnectAttempts = 0;
  var wsHeartbeatTimer = null;
  var wsSyncTimer = null;       // 定期轮询同步
  var wsConnectTimeout = null;

  // ---- 上下文用量跟踪 ----
  var maxContextTokens = 0;     // 当前模型最大上下文
  var usedInputTokens = 0;      // 累计输入 token
  var usedOutputTokens = 0;     // 累计输出 token
  var modelName = '';            // 当前模型名称

  // ---- 会话历史管理 ----

  function generateSessionId() {
    return 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ---- 服务端会话存储（PC 和移动端同步） ----

  /** 从服务端加载会话列表 */
  function loadSessionList() {
    // 返回缓存（同步），异步刷新
    try {
      var stored = localStorage.getItem(STORAGE_KEY_SESSIONS);
      if (stored) return JSON.parse(stored);
    } catch (_e) { /* ignore */ }
    return [];
  }

  function saveSessionList(sessions) {
    try {
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
    } catch (_e) { /* ignore */ }
  }

  /** 从服务端拉取会话列表并更新本地缓存 */
  function fetchSessionList(callback) {
    fetch('/api/sessions?_t=' + Date.now())
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.sessions) {
          saveSessionList(data.sessions);
          if (callback) callback(data.sessions);
        }
      })
      .catch(function () { /* ignore, use local cache */ });
  }

  function getActiveSessionId() {
    return localStorage.getItem(STORAGE_KEY_ACTIVE) || null;
  }

  function setActiveSessionId(id) {
    localStorage.setItem(STORAGE_KEY_ACTIVE, id);
  }

  /** 保存消息到服务端 + 本地缓存 */
  function saveSessionMessages(sessionId, msgs) {
    var toSave = msgs.map(function (m) { return { role: m.role, content: m.content }; });
    // 本地缓存
    try {
      localStorage.setItem('ice-chat-sess-' + sessionId, JSON.stringify(toSave));
    } catch (_e) { /* ignore */ }
    // 异步同步到服务端
    var title = extractSessionTitle(msgs);
    fetch('/api/sessions/' + encodeURIComponent(sessionId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: toSave, title: title }),
    }).catch(function () { /* ignore */ });
  }

  /** 从本地缓存加载消息（同步） */
  function loadSessionMessages(sessionId) {
    try {
      var stored = localStorage.getItem('ice-chat-sess-' + sessionId);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_e) { /* ignore */ }
    return [];
  }

  /** 从服务端加载消息（异步） */
  function fetchSessionMessages(sessionId, callback) {
    // 加 _t 防止移动端浏览器缓存 GET 请求
    var url = '/api/sessions/' + encodeURIComponent(sessionId) + '?_t=' + Date.now();
    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var msgs = (data.messages && data.messages.length > 0) ? data.messages : [];
        if (msgs.length > 0) {
          try {
            localStorage.setItem('ice-chat-sess-' + sessionId, JSON.stringify(msgs));
          } catch (_e) { /* ignore */ }
        }
        if (callback) callback(msgs);
      })
      .catch(function () {
        // 网络失败，用本地缓存
        var local = loadSessionMessages(sessionId);
        if (callback) callback(local);
      });
  }

  function deleteSessionStorage(sessionId) {
    localStorage.removeItem('ice-chat-sess-' + sessionId);
    fetch('/api/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' })
      .catch(function () { /* ignore */ });
  }

  /** 从消息列表中提取会话标题（取第一条用户消息的前 30 个字符） */
  function extractSessionTitle(msgs) {
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].role === 'user' && msgs[i].content) {
        var text = msgs[i].content.replace(/\[file\][^\n]*/g, '').trim();
        if (text) return text.length > 30 ? text.substring(0, 30) + '…' : text;
      }
    }
    return '新对话';
  }

  /** 更新当前会话在 session list 中的元数据 */
  function updateCurrentSessionMeta() {
    if (!currentSessionId) return;
    var sessions = loadSessionList();
    var found = false;
    for (var i = 0; i < sessions.length; i++) {
      if (sessions[i].id === currentSessionId) {
        sessions[i].title = extractSessionTitle(messages);
        sessions[i].updatedAt = Date.now();
        found = true;
        break;
      }
    }
    if (!found) {
      sessions.unshift({ id: currentSessionId, title: extractSessionTitle(messages), updatedAt: Date.now() });
    }
    saveSessionList(sessions);
  }

  /** 初始化或恢复会话 */
  function initSession() {
    var activeId = getActiveSessionId();
    if (activeId) {
      currentSessionId = activeId;
      messages = loadSessionMessages(activeId);
      // 异步从服务端拉取最新消息
      fetchSessionMessages(activeId, function (serverMsgs) {
        if (serverMsgs.length > messages.length) {
          messages = serverMsgs;
          renderMessages();
        }
      });
      fetchSessionList(function () { renderHistory(); });
    } else {
      // 没有本地会话 — 从服务端拉取，优先加载 PC 端活跃会话
      fetch('/api/sessions?_t=' + Date.now())
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var serverSessions = data.sessions || [];
          var serverActiveId = data.activeSessionId || null;
          saveSessionList(serverSessions);

          // 优先使用服务端记录的 PC 端活跃会话
          var targetId = serverActiveId;

          // 如果没有活跃会话，找有实际内容的
          if (!targetId && serverSessions.length > 0) {
            for (var i = 0; i < serverSessions.length; i++) {
              if (serverSessions[i].title && serverSessions[i].title !== '新对话') {
                targetId = serverSessions[i].id;
                break;
              }
            }
            if (!targetId) targetId = serverSessions[0].id;
          }

          if (targetId) {
            currentSessionId = targetId;
            setActiveSessionId(targetId);
            fetchSessionMessages(targetId, function (serverMsgs) {
              messages = serverMsgs;
              renderMessages();
              renderHistory();
            });
          } else {
            currentSessionId = generateSessionId();
            setActiveSessionId(currentSessionId);
            var oldMsgs = loadMessages();
            if (oldMsgs.length > 0) {
              messages = oldMsgs;
              saveSessionMessages(currentSessionId, messages);
              updateCurrentSessionMeta();
              localStorage.removeItem(STORAGE_KEY_MESSAGES);
            }
            renderMessages();
          }
          renderHistory();
        })
        .catch(function () {
          currentSessionId = generateSessionId();
          setActiveSessionId(currentSessionId);
          messages = [];
          renderMessages();
        });
    }
  }

  /** 新建聊天：保存当前会话，创建新会话 */
  function startNewChat() {
    if (isStreaming) return;
    if (currentSessionId && messages.length > 0) {
      saveSessionMessages(currentSessionId, messages);
      updateCurrentSessionMeta();
    }
    currentSessionId = generateSessionId();
    setActiveSessionId(currentSessionId);
    messages = [];
    stages = [];
    currentExecutionId = null;
    resetTokenUsage();
    if (elPipelinePanel) elPipelinePanel.classList.add('hidden');
    renderMessages();
    renderHistory();
    if (elInput) elInput.focus();
  }

  /** 切换到指定会话 */
  function switchToSession(sessionId) {
    if (isStreaming) return;
    if (sessionId === currentSessionId) return;
    if (currentSessionId && messages.length > 0) {
      saveSessionMessages(currentSessionId, messages);
      updateCurrentSessionMeta();
    }
    currentSessionId = sessionId;
    setActiveSessionId(sessionId);
    messages = loadSessionMessages(sessionId);
    stages = [];
    currentExecutionId = null;
    resetTokenUsage();
    if (elPipelinePanel) elPipelinePanel.classList.add('hidden');
    renderMessages();
    renderHistory();
    // 异步从服务端拉取最新消息
    fetchSessionMessages(sessionId, function (serverMsgs) {
      if (serverMsgs.length > 0) {
        messages = serverMsgs;
        renderMessages();
      }
    });
  }

  /** 删除指定会话 */
  function deleteSession(sessionId) {
    var sessions = loadSessionList();
    sessions = sessions.filter(function (s) { return s.id !== sessionId; });
    saveSessionList(sessions);
    deleteSessionStorage(sessionId);
    if (sessionId === currentSessionId) {
      if (sessions.length > 0) {
        switchToSession(sessions[0].id);
      } else {
        startNewChat();
      }
    } else {
      renderHistory();
    }
  }

  // ---- DOM refs for history sidebar ----
  var elHistoryPanel, elHistoryList;

  // ---- 持久化 ----

  function saveMessages() {
    if (!currentSessionId) return;
    try {
      var toSave = messages.map(function (m) { return { role: m.role, content: m.content }; });
      localStorage.setItem('ice-chat-sess-' + currentSessionId, JSON.stringify(toSave));
    } catch (_e) { /* ignore */ }
  }

  function loadMessages() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY_MESSAGES);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_e) { /* ignore */ }
    return [];
  }

  function clearMessages() {
    messages = [];
    saveMessages();
  }

  // ---- DOM refs (set during render) ----
  var elMessages, elInput, elSendBtn, elFileBtn, elFileInput;
  var elFileStatus, elFileName, elFileRemove;
  var elPipelinePanel, elProgressFill, elStagesContainer;

  // ---- 辅助函数 ----

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function getFileExtension(filename) {
    var dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  }

  function isSupportedFile(filename) {
    // 不限制文件格式，允许用户上传任何文件，解析不了的由后端返回提示
    return true;
  }

  /**
   * 从后端获取 FileParser 支持的文件格式列表（仅用于信息展示，不限制上传）。
   */
  function fetchSupportedFormats() {
    fetch('/api/chat/supported-formats')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.extensions && data.extensions.length > 0) {
          SUPPORTED_EXTENSIONS = data.extensions;
        }
      })
      .catch(function () { /* ignore */ });
  }

  function scrollToBottom() {
    if (elMessages) {
      elMessages.scrollTop = elMessages.scrollHeight;
    }
  }

  /** 判断用户是否在聊天底部附近（100px 阈值） */
  function isNearBottom() {
    if (!elMessages) return true;
    var threshold = 100;
    return elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < threshold;
  }

  /** 仅在用户处于底部附近时才滚动到底部 */
  function scrollToBottomIfNeeded() {
    if (isNearBottom()) {
      scrollToBottom();
    }
  }

  // ---- Thinking 指示器（含轮次显示） ----

  var currentTurnCount = 0; // 当前轮次计数（不写入 messages）

  function showThinking(withFile) {
    currentTurnCount = 0;
    var el = document.createElement('div');
    el.className = 'message agent thinking';
    el.setAttribute('id', 'thinking-indicator');

    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = 'Agent';
    el.appendChild(label);

    var content = document.createElement('div');
    content.className = 'thinking-content';
    var thinkText = withFile ? 'Parsing file & Thinking' : 'Thinking';
    content.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span> ' + thinkText;
    el.appendChild(content);

    var turnEl = document.createElement('div');
    turnEl.setAttribute('id', 'turn-counter');
    turnEl.className = 'turn-counter';
    turnEl.style.cssText = 'font-size:12px;color:#888;margin-top:4px;';
    el.appendChild(turnEl);

    elMessages.appendChild(el);
    scrollToBottom();
  }

  /** 更新 thinking 指示器下方的轮次显示 */
  function updateTurnCounter(turn) {
    if (turn > currentTurnCount) {
      currentTurnCount = turn;
    }
    var el = document.getElementById('turn-counter');
    if (el) {
      el.textContent = '第 ' + currentTurnCount + ' 轮';
    }
    if (!document.getElementById('thinking-indicator') && currentTurnCount > 0) {
      showThinking(false);
      var counter = document.getElementById('turn-counter');
      if (counter) counter.textContent = '第 ' + currentTurnCount + ' 轮';
    }
  }

  function removeThinking() {
    currentTurnCount = 0;
    var el = document.getElementById('thinking-indicator');
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  // ---- 渲染 ----

  /** 渲染消息到 DOM（不触发保存，用于只读同步） */
  function renderMessagesOnly(shouldScroll) {
    elMessages.innerHTML = '';
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var el = document.createElement('div');
      el.className = 'message ' + msg.role;

      var label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = msg.role === 'user' ? 'You' : 'Agent';
      el.appendChild(label);

      var content = document.createElement('div');
      content.textContent = msg.content;
      el.appendChild(content);

      elMessages.appendChild(el);
    }
    // shouldScroll 未传参时默认滚动（兼容其他调用方）
    if (shouldScroll !== false) {
      scrollToBottom();
    }
  }

  function renderMessages() {
    renderMessagesOnly();
    saveMessages();
  }

  function appendAgentChunk(text) {
    agentResponseBuffer += text;

    // 更新最后一条智能体消息或创建新的
    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'agent' && lastMsg._streaming) {
      lastMsg.content = agentResponseBuffer;
    } else {
      // 新建流式消息，先 renderMessages 确保 DOM 顺序正确
      messages.push({ role: 'agent', content: agentResponseBuffer, _streaming: true });
      renderMessages();
      // 给最后一个 agent 消息元素加标记
      var allMsgEls = elMessages.querySelectorAll('.message.agent');
      var newEl = allMsgEls[allMsgEls.length - 1];
      if (newEl) newEl.setAttribute('id', 'streaming-msg');
      scrollToBottom();
      return;
    }

    // 增量更新：找到标记的流式消息元素
    var streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      var contentEl = streamEl.lastChild;
      if (contentEl) contentEl.textContent = agentResponseBuffer;
    } else {
      // 回退：完整重新渲染
      renderMessages();
    }
    scrollToBottom();
  }

  function finalizeAgentResponse() {
    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg._streaming) {
      delete lastMsg._streaming;
    }
    agentResponseBuffer = '';
    // 清除流式消息 DOM 标记
    var streamEl = document.getElementById('streaming-msg');
    if (streamEl) streamEl.removeAttribute('id');
    setStreamingState(false);
    saveMessages();
  }

  // ---- 发送/停止按钮状态切换 ----

  function setStreamingState(streaming) {
    isStreaming = streaming;
    if (!elSendBtn) return;

    if (streaming) {
      elSendBtn.innerHTML = '<span class="icon-stop"></span>';
      elSendBtn.title = 'Stop';
      elSendBtn.classList.add('btn-stop');
      elInput.disabled = true;
    } else {
      elSendBtn.innerHTML = '<span class="icon-send"></span>';
      elSendBtn.title = 'Send';
      elSendBtn.classList.remove('btn-stop');
      elInput.disabled = false;
    }
  }

  function handleStop() {
    // 通过 WebSocket 通知后端停止
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'stop' }));
    }

    // 结束当前响应
    removeThinking();
    if (agentResponseBuffer) {
      // 保留已接收的部分内容，标记为已停止
      var lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg._streaming) {
        lastMsg.content = agentResponseBuffer + '\n\n[已停止]';
        delete lastMsg._streaming;
      }
    }
    agentResponseBuffer = '';
    setStreamingState(false);
    renderMessages();
    saveMessages();
  }

  // ---- 流水线进度 ----

  function initStages() {
    stages = STAGE_NAMES.map(function (name) {
      return { name: name, status: 'pending' };
    });
    renderStages();
    updateProgressBar();
    elPipelinePanel.classList.remove('hidden');
  }

  function renderStages() {
    elStagesContainer.innerHTML = '';
    for (var i = 0; i < stages.length; i++) {
      var s = stages[i];
      var el = document.createElement('span');
      el.className = 'stage-label ' + s.status;
      el.textContent = s.name + ' — ' + s.status;
      el.setAttribute('data-stage', s.name);

      if (s.status === 'completed') {
        (function (stageName) {
          el.title = 'Click to view report';
          el.addEventListener('click', function () {
            viewStageReport(stageName);
          });
        })(s.name);
      }

      elStagesContainer.appendChild(el);
    }
  }

  function updateProgressBar() {
    var completed = 0;
    for (var i = 0; i < stages.length; i++) {
      if (stages[i].status === 'completed') completed++;
    }
    var pct = stages.length > 0 ? Math.round((completed / stages.length) * 100) : 0;
    elProgressFill.style.width = pct + '%';
  }

  function updateStageStatus(stageName, status) {
    for (var i = 0; i < stages.length; i++) {
      if (stages[i].name === stageName) {
        stages[i].status = status;
        break;
      }
    }
    renderStages();
    updateProgressBar();
  }

  function viewStageReport(stageName) {
    if (!currentExecutionId) return;
    // 规范化阶段名称用于 API（小写，连字符分隔）
    var stageKey = stageName.toLowerCase().replace(/\s+/g, '-');
    var url = '/api/pipeline/' + encodeURIComponent(currentExecutionId) + '/report/' + encodeURIComponent(stageKey);

    fetch(url)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          messages.push({ role: 'agent', content: '[Report] ' + data.error });
        } else {
          var summary = data.result && data.result.summary ? data.result.summary : JSON.stringify(data.result, null, 2);
          messages.push({ role: 'agent', content: '[' + stageName + ' Report]\n' + summary });
        }
        renderMessages();
      })
      .catch(function () {
        messages.push({ role: 'agent', content: '[Report] Failed to load report for ' + stageName });
        renderMessages();
      });
  }

  // ---- 文件上传 ----

  function handleFileSelect(file) {
    if (!file) return;

    // 上传到服务器
    var formData = new FormData();
    formData.append('file', file);

    elFileStatus.classList.remove('hidden');
    elFileName.textContent = file.name + ' (uploading…)';

    fetch('/api/chat/upload', {
      method: 'POST',
      body: formData
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          elFileName.textContent = file.name + ' (failed)';
          messages.push({ role: 'agent', content: 'Upload failed: ' + data.error });
          renderMessages();
          uploadedFile = null;
        } else {
          uploadedFile = { fileId: data.fileId, filename: data.filename, size: data.size };
          elFileName.textContent = data.filename + ' (' + formatSize(data.size) + ') — 发送时将自动解析';
        }
      })
      .catch(function () {
        elFileName.textContent = file.name + ' (failed)';
        uploadedFile = null;
      });
  }

  function removeUploadedFile() {
    uploadedFile = null;
    if (elFileStatus) elFileStatus.classList.add('hidden');
    if (elFileName) elFileName.textContent = '';
    if (elFileInput) elFileInput.value = '';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---- 统一 WebSocket 通信（PC 和移动端共用） ----

  function connectChatWs() {
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
      updateNavStatus(true);
      syncMessages();
      startSyncPolling();
    };

    chatWs.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        handleWsMessage(data);
      } catch (_err) { /* ignore */ }
    };

    chatWs.onclose = function () {
      if (wsConnectTimeout) { clearTimeout(wsConnectTimeout); wsConnectTimeout = null; }
      wsProcessing = false;
      setStreamingState(false);
      updateNavStatus(false);
      scheduleWsReconnect();
    };

    chatWs.onerror = function () { /* onclose handles it */ };

    wsHeartbeatTimer = setInterval(function () {
      if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
  }

  function syncMessages() {
    if (!currentSessionId) return;
    if (wsProcessing || isStreaming) return;
    fetchSessionMessages(currentSessionId, function (serverMsgs) {
      if (serverMsgs && serverMsgs.length > 0 && serverMsgs.length !== messages.length) {
        var wasNearBottom = isNearBottom();
        messages = serverMsgs;
        renderMessagesOnly(wasNearBottom);
      }
    });
  }

  function startSyncPolling() {
    stopSyncPolling();
    wsSyncTimer = setInterval(function () {
      if (!wsProcessing && !isStreaming) {
        syncMessages();
      }
    }, 5000);
  }

  function stopSyncPolling() {
    if (wsSyncTimer) { clearInterval(wsSyncTimer); wsSyncTimer = null; }
  }

  function scheduleWsReconnect() {
    stopSyncPolling();
    if (wsReconnectTimer) return;
    var delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(function () {
      wsReconnectTimer = null;
      connectChatWs();
    }, delay);
  }

  function handleWsMessage(data) {
    switch (data.type) {
      case 'connected':
        break;
      case 'response':
        removeThinking();
        finalizeAgentResponse();
        messages.push({ role: 'agent', content: data.content });
        renderMessages();
        break;
      case 'step':
        handleWsStep(data.step);
        break;
      case 'status':
        wsProcessing = data.status === 'processing';
        setStreamingState(wsProcessing);
        break;
      case 'error':
        removeThinking();
        messages.push({ role: 'agent', content: '[err] ' + data.message });
        renderMessages();
        break;
      case 'info':
        // info 消息（如工具调用次数）不写入聊天记录，仅在控制台记录
        console.log('[info]', data.message);
        break;
      case 'confirm':
        handleWsConfirm(data.toolName, data.args);
        break;
      case 'tokenUsage':
        updateTokenUsage(data.inputTokens || 0, data.outputTokens || 0);
        break;
      case 'pong':
        break;
    }
  }

  function handleWsStep(step) {
    if (!step) return;
    // 更新 token 用量（仅更新状态栏，不写入聊天记录）
    if (step.totalTokenUsage) {
      usedInputTokens = step.totalTokenUsage.inputTokens || 0;
      usedOutputTokens = step.totalTokenUsage.outputTokens || 0;
      renderContextBar();
    }
    // 更新轮次指示器（不写入 messages，仅 UI 展示）
    if (step.iteration) {
      updateTurnCounter(step.iteration);
    }
  }

  function handleWsConfirm(toolName, args) {
    removeThinking();
    var argsText = args ? JSON.stringify(args) : '';
    var ok = window.confirm('AI 请求执行危险操作：\n\n工具: ' + toolName + '\n参数: ' + argsText + '\n\n是否允许？');
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'confirm_reply', approved: ok }));
    }
    messages.push({ role: 'agent', content: ok ? '[ok] 用户已确认: ' + toolName : '[denied] 用户已拒绝: ' + toolName });
    renderMessages();
  }

  function sendWsMessage(text) {
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
      messages.push({ role: 'agent', content: '[err] 未连接，无法发送' });
      renderMessages();
      return;
    }
    chatWs.send(JSON.stringify({ type: 'message', content: text, sessionId: currentSessionId }));
  }

  // ---- 命令面板 ----

  // ~ 开头：本地命令（不发送到服务器）
  // / 开头：服务端命令（发送到服务器执行）
  var PC_LOCAL_COMMANDS = [
    { name: 'new', description: '新建聊天', prefix: '~' },
    { name: 'history', description: '显示/隐藏历史记录', prefix: '~' },
    { name: 'clear', description: '清空当前聊天记录', prefix: '~' },
    { name: 'open', description: '打开文件管理器，浏览电脑文件', prefix: '~' },
    { name: 'scan', description: '手机扫码连接，远程控制', prefix: '~' }
  ];

  var REMOTE_LOCAL_COMMANDS = [
    { name: 'new', description: '新建聊天', prefix: '~' },
    { name: 'history', description: '显示/隐藏历史记录', prefix: '~' },
    { name: 'clear', description: '清空当前聊天记录', prefix: '~' },
    { name: 'open', description: '打开文件管理器，浏览电脑文件', prefix: '~' }
  ];

  function getLocalCommands() {
    return remoteMode ? REMOTE_LOCAL_COMMANDS : PC_LOCAL_COMMANDS;
  }

  var LOCAL_COMMANDS = PC_LOCAL_COMMANDS; // 初始值，render 时会更新

  var SLASH_COMMANDS = [
    { name: 'pipeline', description: '启动开发流水线（需要先上传文件）', prefix: '/' }
  ];

  var ALL_COMMANDS = LOCAL_COMMANDS.concat(SLASH_COMMANDS);

  var elCmdDropdown = null;
  var cmdSelectedIndex = 0;
  var cmdVisible = false;
  var cmdFiltered = [];
  var cmdActivePrefix = ''; // 当前激活的前缀 ~ 或 /

  function createCmdDropdown() {
    var el = document.createElement('div');
    el.className = 'cmd-dropdown hidden';
    el.setAttribute('id', 'cmd-dropdown');
    return el;
  }

  function showCmdDropdown(prefix, filter) {
    if (!elCmdDropdown) return;
    cmdActivePrefix = prefix;
    var query = (filter || '').toLowerCase();
    var source = prefix === '/' ? SLASH_COMMANDS : getLocalCommands();
    cmdFiltered = source.filter(function (cmd) {
      return cmd.name.toLowerCase().indexOf(query) >= 0;
    });
    if (cmdFiltered.length === 0) {
      hideCmdDropdown();
      return;
    }
    cmdSelectedIndex = 0;
    renderCmdDropdown();
    elCmdDropdown.classList.remove('hidden');
    cmdVisible = true;
  }

  function hideCmdDropdown() {
    if (!elCmdDropdown) return;
    elCmdDropdown.classList.add('hidden');
    cmdVisible = false;
    cmdFiltered = [];
    cmdActivePrefix = '';
  }

  function renderCmdDropdown() {
    if (!elCmdDropdown) return;
    elCmdDropdown.innerHTML = '';
    for (var i = 0; i < cmdFiltered.length; i++) {
      var item = document.createElement('div');
      item.className = 'cmd-item' + (i === cmdSelectedIndex ? ' active' : '');
      item.setAttribute('data-index', i);
      var prefix = cmdFiltered[i].prefix || cmdActivePrefix;
      item.innerHTML =
        '<span class="cmd-name">' + prefix + cmdFiltered[i].name + '</span>' +
        '<span class="cmd-desc">' + cmdFiltered[i].description + '</span>';
      (function (idx) {
        item.addEventListener('mouseenter', function () {
          cmdSelectedIndex = idx;
          renderCmdDropdown();
        });
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          selectCmd(idx);
        });
        // 移动端触摸支持
        item.addEventListener('touchend', function (e) {
          e.preventDefault();
          selectCmd(idx);
        });
      })(i);
      elCmdDropdown.appendChild(item);
    }
  }

  function selectCmd(index) {
    if (index < 0 || index >= cmdFiltered.length) return;
    var cmd = cmdFiltered[index];
    var prefix = cmd.prefix || cmdActivePrefix;
    elInput.value = prefix + cmd.name;
    hideCmdDropdown();
    elInput.focus();
  }

  function handleCmdInput() {
    var val = elInput.value;
    if (val.indexOf('/') === 0) {
      var filter = val.slice(1);
      showCmdDropdown('/', filter);
    } else if (val.indexOf('~') === 0) {
      var filter = val.slice(1);
      showCmdDropdown('~', filter);
    } else {
      hideCmdDropdown();
    }
  }

  function handleCmdKeydown(e) {
    if (!cmdVisible) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdSelectedIndex = (cmdSelectedIndex + 1) % cmdFiltered.length;
      renderCmdDropdown();
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdFiltered.length) % cmdFiltered.length;
      renderCmdDropdown();
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      selectCmd(cmdSelectedIndex);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideCmdDropdown();
      return true;
    }
    return false;
  }

  // ---- 发送消息 ----

  function handleSend() {
    // 如果正在流式传输，点击按钮执行停止
    if (isStreaming) {
      handleStop();
      return;
    }

    var text = elInput.value.trim();
    if (!text && !uploadedFile) return;

    // 处理 ~clear 命令：清空聊天记录（本地命令，不发送）
    if (text === '~clear') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      clearMessages();
      renderMessages();
      return;
    }

    // 处理 ~new 命令：新建聊天
    if (text === '~new') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      startNewChat();
      return;
    }

    // 处理 ~history 命令：切换历史面板
    if (text === '~history') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      toggleHistory();
      return;
    }

    // 处理 ~scan 命令：生成远程控制二维码
    if (text === '~scan' && !remoteMode) {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      showQrCode();
      return;
    }

    // 处理 ~open 命令：发送给 LLM，但不在聊天框显示
    if (text === '~open') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      showThinking(false);
      sendWsMessage('~open');
      return;
    }

    // 统一通过 WebSocket 发送（PC 和移动端共用）
    var displayParts = [];
    if (text) displayParts.push(text);
    if (uploadedFile) displayParts.push('[file] ' + uploadedFile.filename);
    if (displayParts.length > 0) {
      messages.push({ role: 'user', content: displayParts.join('\n') });
    }
    renderMessages();
    elInput.value = '';
    autoResizeInput();
    hideCmdDropdown();
    showThinking(!!uploadedFile);

    // 如果有文件，先上传，再把 fileId 附加到消息中
    var msgText = text || '';
    if (uploadedFile) {
      msgText = (msgText ? msgText + '\n' : '') + '[file:' + uploadedFile.fileId + '] ' + uploadedFile.filename;
    }
    removeUploadedFile();

    sendWsMessage(msgText);
  }

  // ---- 历史记录侧边栏渲染 ----

  function renderHistory() {
    if (!elHistoryList) return;
    var sessions = loadSessionList();
    elHistoryList.innerHTML = '';

    if (sessions.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '暂无历史记录';
      elHistoryList.appendChild(empty);
      return;
    }

    // 按更新时间倒序
    sessions.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

    for (var i = 0; i < sessions.length; i++) {
      (function (sess) {
        var item = document.createElement('div');
        item.className = 'history-item' + (sess.id === currentSessionId ? ' active' : '');

        var title = document.createElement('span');
        title.className = 'history-title';
        title.textContent = sess.title || '新对话';
        title.title = sess.title || '新对话';
        item.appendChild(title);

        var del = document.createElement('button');
        del.className = 'history-delete';
        del.innerHTML = '&times;';
        del.title = '删除';
        del.addEventListener('mousedown', function (e) {
          e.preventDefault();
          e.stopPropagation();
        });
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          deleteSession(sess.id);
        });
        item.appendChild(del);

        item.addEventListener('click', function () {
          switchToSession(sess.id);
        });

        elHistoryList.appendChild(item);
      })(sessions[i]);
    }
  }

  function toggleHistory() {
    if (!elHistoryPanel) return;
    elHistoryPanel.classList.toggle('open');
    renderHistory();
  }

  // ---- 输入框自动调整大小 ----

  function autoResizeInput() {
    if (!elInput) return;
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(elInput.scrollHeight, 120) + 'px';
  }

  // ---- 上下文用量显示 ----

  /** 更新导航栏连接状态 */
  function updateNavStatus(connected) {
    var dot = document.getElementById('status-dot');
    if (dot) {
      dot.classList.toggle('connected', connected);
      dot.classList.toggle('disconnected', !connected);
      dot.title = connected ? '已连接' : '未连接';
    }
  }

  var elContextBar = null;

  function fetchModelContext() {
    fetch('/api/config')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var providers = data.providers || [];
        var defaultProvider = providers.find(function (p) { return p.isDefault; }) || providers[0];
        if (defaultProvider) {
          maxContextTokens = defaultProvider.maxContextTokens || 0;
          modelName = defaultProvider.modelName || '';
          renderContextBar();
        }
      })
      .catch(function () { /* ignore */ });
  }

  function updateTokenUsage(inputTokens, outputTokens) {
    // inputTokens = 当前上下文窗口占用（最后一轮 API 调用的输入 token 数）
    // 这就是实际的上下文大小，outputTokens 不计入（下一轮会合并到 input 中）
    usedInputTokens = inputTokens;
    usedOutputTokens = outputTokens;
    renderContextBar();
  }

  function resetTokenUsage() {
    usedInputTokens = 0;
    usedOutputTokens = 0;
    renderContextBar();
  }

  function renderContextBar() {
    if (!elContextBar) return;

    // 上下文占用 = inputTokens（当前窗口大小），不加 outputTokens（避免重复计算）
    var usedTotal = usedInputTokens;
    var pct = maxContextTokens ? Math.min(100, Math.round((usedTotal / maxContextTokens) * 100)) : 0;
    var barColor = pct < 60 ? '#4caf50' : pct < 85 ? '#ff9800' : '#e94560';

    var fill = elContextBar.querySelector('.ctx-bottom-fill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.style.background = barColor;
    }

    elContextBar.title = '上下文: ' + pct + '%' +
      (maxContextTokens ? ' (' + formatTokenCount(usedTotal) + '/' + formatTokenCount(maxContextTokens) + ')' : '') +
      ' | 本轮输出: ' + formatTokenCount(usedOutputTokens);
  }

  function formatTokenCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return '' + n;
  }

  // ---- 二维码远程控制 ----

  function showQrCode() {
    messages.push({ role: 'agent', content: '正在生成远程控制二维码…' });
    renderMessages();

    fetch('/api/remote/session', { method: 'POST' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success) {
          messages.push({ role: 'agent', content: '生成二维码失败: ' + (data.error || '未知错误') });
          renderMessages();
          return;
        }

        // 移除 "正在生成" 消息
        messages.pop();
        renderMessages();

        // 创建二维码弹窗
        showQrModal(data.url, data.qrDataUrl, data.localIP, data.port, data.tunnel);
      })
      .catch(function () {
        messages.push({ role: 'agent', content: '生成二维码失败，请检查网络连接' });
        renderMessages();
      });
  }

  function showQrModal(url, qrDataUrl, localIP, port, tunnel) {
    // 创建遮罩层
    var overlay = document.createElement('div');
    overlay.className = 'qr-overlay';
    overlay.setAttribute('id', 'qr-overlay');

    var modal = document.createElement('div');
    modal.className = 'qr-modal';

    var title = document.createElement('h3');
    title.textContent = '手机扫码远程控制';
    modal.appendChild(title);

    var desc = document.createElement('p');
    desc.className = 'qr-desc';
    desc.textContent = '请确保手机和电脑在同一局域网内';
    modal.appendChild(desc);

    var qrContainer = document.createElement('div');
    qrContainer.className = 'qr-canvas-container';
    if (qrDataUrl) {
      var img = document.createElement('img');
      img.src = qrDataUrl;
      img.alt = 'QR Code';
      img.style.width = '220px';
      img.style.height = '220px';
      img.style.borderRadius = '8px';
      qrContainer.appendChild(img);
    } else {
      qrContainer.innerHTML = '<p style="word-break:break-all;font-size:12px;color:#a0a0a0;">二维码生成失败，请手动访问:<br>' + escapeHtml(url) + '</p>';
    }
    modal.appendChild(qrContainer);

    var urlText = document.createElement('p');
    urlText.className = 'qr-url';
    urlText.textContent = url;
    modal.appendChild(urlText);

    var info = document.createElement('p');
    info.className = 'qr-info';
    info.textContent = tunnel ? '通过公网隧道访问（任意网络可用）' : '局域网 IP: ' + localIP + ' | 端口: ' + port;
    modal.appendChild(info);

    var hint = document.createElement('p');
    hint.className = 'qr-timer';
    hint.textContent = '链接长期有效，直到下次重新生成';
    modal.appendChild(hint);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'qr-close-btn';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', function () {
      document.body.removeChild(overlay);
    });
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
      }
    });

    document.body.appendChild(overlay);
  }

  // ---- 公共 API ----

  function render(parentEl) {
    container = parentEl;

    // 检测远程模式
    var params = new URLSearchParams(window.location.search);
    remoteToken = params.get('token');
    remoteMode = !!remoteToken;

    container.innerHTML =
      '<div class="chat-page">' +
        // 历史记录侧边栏
        '<div class="history-panel" id="history-panel">' +
          '<div class="history-header">' +
            '<span>历史记录</span>' +
            '<button class="history-close" id="btn-history-close" title="关闭">&times;</button>' +
          '</div>' +
          '<div class="history-list" id="history-list"></div>' +
        '</div>' +
        // Pipeline panel（远程模式隐藏）
        (remoteMode ? '' :
        '<div class="pipeline-panel hidden" id="pipeline-panel">' +
          '<div class="pipeline-header">' +
            '<h3>Pipeline Progress</h3>' +
          '</div>' +
          '<div class="pipeline-progress-bar">' +
            '<div class="pipeline-progress-fill" id="progress-fill"></div>' +
          '</div>' +
          '<div class="pipeline-stages" id="stages-container"></div>' +
        '</div>') +
        // Messages
        '<div class="chat-messages" id="chat-messages"></div>' +
        // Input area（进度条作为上边框）
        '<div class="chat-input-area">' +
          '<div class="ctx-bottom-bar" id="ctx-bar" title="上下文用量">' +
            '<div class="ctx-bottom-fill"></div>' +
          '</div>' +
          '<div class="file-upload-status hidden" id="file-status">' +
            '<span class="file-name" id="file-name"></span>' +
            '<button class="file-remove" id="file-remove" title="Remove file">&times;</button>' +
          '</div>' +
          '<div class="chat-input-row">' +
            '<button class="btn-icon" id="btn-file" title="Upload file"><span class="icon-clip"></span></button>' +
            '<div class="input-wrapper">' +
              '<textarea id="chat-input" rows="1" placeholder="输入指令… (输入 ~ 查看命令)"></textarea>' +
            '</div>' +
            '<button class="btn-icon btn-send" id="btn-send" title="Send"><span class="icon-send"></span></button>' +
          '</div>' +
          '<input type="file" class="hidden-input" id="file-input">' +
        '</div>' +
      '</div>';

    // 缓存 DOM 引用
    elMessages = container.querySelector('#chat-messages');
    elInput = container.querySelector('#chat-input');
    elSendBtn = container.querySelector('#btn-send');
    elFileBtn = container.querySelector('#btn-file');
    elFileInput = container.querySelector('#file-input');
    elFileStatus = container.querySelector('#file-status');
    elFileName = container.querySelector('#file-name');
    elFileRemove = container.querySelector('#file-remove');
    elPipelinePanel = container.querySelector('#pipeline-panel');
    elProgressFill = container.querySelector('#progress-fill');
    elStagesContainer = container.querySelector('#stages-container');
    elHistoryPanel = container.querySelector('#history-panel');
    elHistoryList = container.querySelector('#history-list');
    var elHistoryClose = container.querySelector('#btn-history-close');
    elContextBar = container.querySelector('#ctx-bar');

    // 立即渲染上下文条（加载状态）
    renderContextBar();

    // 创建命令面板下拉框并插入到 input-wrapper 中
    elCmdDropdown = createCmdDropdown();
    var inputWrapper = container.querySelector('.input-wrapper');
    inputWrapper.appendChild(elCmdDropdown);

    // 初始化会话系统（远程模式在下方单独处理）
    if (!remoteMode) {
      initSession();
    }

    // 获取模型上下文信息
    fetchModelContext();

    if (!remoteMode) {
      // 从后端获取支持的文件格式
      fetchSupportedFormats();
    }

    // 绑定事件
    elSendBtn.addEventListener('click', handleSend);
    if (elHistoryClose) {
      elHistoryClose.addEventListener('click', function () {
        elHistoryPanel.classList.remove('open');
      });
    }

    elInput.addEventListener('keydown', function (e) {
      // 命令面板键盘导航优先
      if (handleCmdKeydown(e)) return;

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    elInput.addEventListener('input', function () {
      autoResizeInput();
      handleCmdInput();
    });

    elInput.addEventListener('blur', function () {
      // 延迟隐藏，让 mousedown 事件有机会触发
      setTimeout(hideCmdDropdown, 150);
    });

    if (elFileBtn) {
      elFileBtn.addEventListener('click', function () {
        elFileInput.click();
      });
    }

    if (elFileInput) {
      elFileInput.addEventListener('change', function () {
        if (elFileInput.files && elFileInput.files[0]) {
          handleFileSelect(elFileInput.files[0]);
        }
      });
    }

    if (elFileRemove) {
      elFileRemove.addEventListener('click', removeUploadedFile);
    }

    // 渲染已有消息（导航返回时）
    renderMessages();
    renderHistory();

    // 如果活跃则恢复流水线面板
    if (!remoteMode && stages.length > 0 && currentExecutionId) {
      elPipelinePanel.classList.remove('hidden');
      renderStages();
      updateProgressBar();
    }

    // 远程模式：从服务端同步会话
    if (remoteMode) {
      messages = [];
      renderMessagesOnly();
      fetch('/api/sessions?_t=' + Date.now())
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var serverSessions = data.sessions || [];
          var serverActiveId = data.activeSessionId || null;
          saveSessionList(serverSessions);
          var targetId = serverActiveId;
          if (!targetId && serverSessions.length > 0) {
            for (var i = 0; i < serverSessions.length; i++) {
              if (serverSessions[i].title && serverSessions[i].title !== '新对话') {
                targetId = serverSessions[i].id;
                break;
              }
            }
            if (!targetId) targetId = serverSessions[0].id;
          }
          if (targetId) {
            currentSessionId = targetId;
            setActiveSessionId(targetId);
            fetchSessionMessages(targetId, function (serverMsgs) {
              messages = serverMsgs;
              renderMessagesOnly();
              renderHistory();
            });
          } else {
            currentSessionId = generateSessionId();
            setActiveSessionId(currentSessionId);
          }
        })
        .catch(function () {
          currentSessionId = generateSessionId();
          setActiveSessionId(currentSessionId);
        });
    }

    // PC 和移动端统一连接 WebSocket
    connectChatWs();

    // 切回前台时重连 + 刷新消息
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        syncMessages();
        if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
          if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
          wsReconnectAttempts = 0;
          connectChatWs();
        }
      } else {
        stopSyncPolling();
      }
    });
  }

  return { render: render };
})();
