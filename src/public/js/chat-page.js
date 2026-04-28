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

  // ---- State ----
  var container = null;
  var messages = [];       // { role: 'user'|'agent', content: string }
  var uploadedFile = null; // { fileId, filename, size } or null
  var currentExecutionId = null;
  var stages = [];         // { name, status }
  var agentResponseBuffer = ''; // accumulates streaming chunks
  var isStreaming = false;      // 是否正在流式传输
  var userStopped = false;      // 用户是否已点击停止（忽略后续 stream 消息）
  var streamFinalized = false;  // 标记刚刚 finalize 了流式消息（用于跳过冗余 response）

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

  // ---- 消息持久化（单会话，固定 ID） ----

  var SESSION_ID = 'default';

  /** 保存消息到本地缓存（服务端由后端统一写入） */
  function saveSessionMessages() {
    var toSave = messages.map(function (m) { return { role: m.role, content: m.content }; });
    try {
      localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(toSave));
    } catch (_e) { /* ignore */ }
  }

  /** 从本地缓存加载消息（同步） */
  function loadLocalMessages() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY_MESSAGES);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_e) { /* ignore */ }
    return [];
  }

  /** 从服务端加载消息（异步） */
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

  /** 初始化：从本地缓存加载，再从服务端同步 */
  function initSession() {
    messages = loadLocalMessages();
    renderMessages();
    // 异步从服务端拉取最新消息
    fetchServerMessages(function (serverMsgs) {
      if (serverMsgs.length > messages.length) {
        messages = serverMsgs;
        renderMessages();
      }
    });
  }

  // ---- 持久化 ----

  function saveMessages() {
    saveSessionMessages();
  }

  function loadMessages() {
    return loadLocalMessages();
  }

  function clearMessages() {
    messages = [];
    saveMessages();
    // 通知后端清除消息缓存，下一轮从零构建
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'clear_session' }));
    }
  }

  // ---- DOM refs (set during render) ----
  var elMessages, elAnchor, elInput, elSendBtn, elFileBtn, elFileInput;
  var elFileStatus, elFileName, elFileRemove;
  var elPipelinePanel, elProgressFill, elStagesContainer;
  var elStatusBar, elStatusText, elStatusTurn;

  // ---- 辅助函数 ----

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
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

  /** 判断用户是否在聊天底部附近（150px 阈值） */
  function isNearBottom() {
    if (!elMessages) return true;
    var threshold = 150;
    return elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < threshold;
  }

  // ---- 状态指示器（输入区上方状态栏） ----

  var currentTurnCount = 0;

  function showThinking(withFile) {
    currentTurnCount = 0;
    if (!elStatusBar) return;
    var thinkText = withFile ? 'Parsing file & Thinking' : 'Thinking';
    updateStatusText(thinkText);
    if (elStatusTurn) elStatusTurn.textContent = '';
    elStatusBar.classList.add('active');
  }

  function updateTurnCounter(turn) {
    if (turn > currentTurnCount) {
      currentTurnCount = turn;
    }
    if (elStatusTurn) {
      elStatusTurn.textContent = '第 ' + currentTurnCount + ' 轮';
    }
  }

  function removeThinking() {
    currentTurnCount = 0;
    if (elStatusBar) {
      elStatusBar.classList.remove('active');
    }
    if (elStatusText) elStatusText.innerHTML = '';
    if (elStatusTurn) elStatusTurn.textContent = '';
  }

  /** 更新状态栏文本（保留动画点） */
  function updateStatusText(text) {
    if (!elStatusText) return;
    elStatusText.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span> ' + escapeHtml(text);
  }

  /** 在聊天区追加工具调用条目（紧凑行） */
  function appendToolAction(toolName, detail, status) {
    if (!elMessages) return;
    var el = document.createElement('div');
    el.className = 'tool-action';
    el.setAttribute('data-tool', toolName);

    var iconEl = document.createElement('span');
    iconEl.className = 'tool-icon ' + (status || 'pending');
    if (status === 'success') {
      iconEl.textContent = '✓';
    } else if (status === 'error') {
      iconEl.textContent = '✗';
    } else {
      iconEl.textContent = '⟳';
    }
    el.appendChild(iconEl);

    var nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = toolName;
    el.appendChild(nameEl);

    if (detail) {
      var detailEl = document.createElement('span');
      detailEl.className = 'tool-detail';
      detailEl.textContent = detail;
      el.appendChild(detailEl);
    }

    elMessages.insertBefore(el, elAnchor);
    return el;
  }

  /** 更新最后一个匹配工具名的条目状态 */
  function updateLastToolAction(toolName, status) {
    if (!elMessages) return;
    // 从锚点往前找最后一个匹配的 tool-action
    var node = elAnchor ? elAnchor.previousSibling : elMessages.lastChild;
    while (node) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-action') && node.getAttribute('data-tool') === toolName) {
        var iconEl = node.querySelector('.tool-icon');
        if (iconEl) {
          iconEl.className = 'tool-icon ' + status;
          iconEl.textContent = status === 'success' ? '✓' : status === 'error' ? '✗' : '⟳';
        }
        return;
      }
      node = node.previousSibling;
    }
  }

  // ---- 渲染 ----

  /** 渲染消息到 DOM（不触发保存，用于只读同步） */
  function renderMessagesOnly(shouldScroll) {
    // 保留锚点，清除其他内容
    while (elMessages.firstChild !== elAnchor) {
      elMessages.removeChild(elMessages.firstChild);
    }
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

      elMessages.insertBefore(el, elAnchor);
    }
    if (shouldScroll !== false) {
      scrollToBottom();
    }
  }

  function renderMessages() {
    renderMessagesOnly();
    saveMessages();
  }

  /** 增量追加单条消息到 DOM（避免全量 innerHTML 重建导致闪烁） */
  function appendMessageEl(msg) {
    if (!elMessages) return;
    var el = document.createElement('div');
    el.className = 'message ' + msg.role;

    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = msg.role === 'user' ? 'You' : 'Agent';
    el.appendChild(label);

    var content = document.createElement('div');
    content.textContent = msg.content;
    el.appendChild(content);

    elMessages.insertBefore(el, elAnchor);
  }

  // ---- 滚动状态（overflow-anchor 自动粘底） ----
  /** 用户是否手动向上滚动过（脱离底部） */
  var userScrolledUp = false;

  function appendAgentChunk(text) {
    agentResponseBuffer += text;

    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'agent' && lastMsg._streaming) {
      // 已有流式消息，更新数据模型
      lastMsg.content = agentResponseBuffer;
    } else {
      // 新建流式消息
      messages.push({ role: 'agent', content: agentResponseBuffer, _streaming: true });

      var el = document.createElement('div');
      el.className = 'message agent';
      el.setAttribute('id', 'streaming-msg');

      var label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = 'Agent';
      el.appendChild(label);

      var contentDiv = document.createElement('div');
      contentDiv.appendChild(document.createTextNode(text));
      el.appendChild(contentDiv);
      el._streamContentEl = contentDiv;

      elMessages.insertBefore(el, elAnchor);
      return;
    }

    // 增量追加文本节点
    var streamEl = document.getElementById('streaming-msg');
    if (streamEl && streamEl._streamContentEl) {
      streamEl._streamContentEl.appendChild(document.createTextNode(text));
    } else if (streamEl) {
      var contentEl = streamEl.lastChild;
      if (contentEl) {
        contentEl.appendChild(document.createTextNode(text));
        streamEl._streamContentEl = contentEl;
      }
    }
  }

  /** 从文本中移除 <status>...</status> 标记（系统用，不展示给用户） */
  function stripStatusTag(text) {
    return text.replace(/<status>\s*(?:complete|incomplete)\s*<\/status>/gi, '').trimEnd();
  }

  function finalizeAgentResponse() {
    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg._streaming) {
      delete lastMsg._streaming;
      streamFinalized = true;
      // 清理 status 标记
      lastMsg.content = stripStatusTag(lastMsg.content);
    }
    agentResponseBuffer = '';
    var streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      if (streamEl._streamContentEl) {
        streamEl._streamContentEl.normalize();
        // 同步清理 DOM 中的 status 标记
        streamEl._streamContentEl.textContent = stripStatusTag(streamEl._streamContentEl.textContent || '');
      }
      streamEl.removeAttribute('id');
      delete streamEl._streamContentEl;
    }
    setStreamingState(false);
    saveMessages();
  }

  // ---- 发送/停止按钮状态切换 ----

  function setStreamingState(streaming) {
    if (isStreaming === streaming) return; // 状态未变，不操作 DOM
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
    userStopped = true;
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
        // 更新 DOM 中流式消息的内容（不做全量重建）
        var streamEl = document.getElementById('streaming-msg');
        if (streamEl) {
          var contentEl = streamEl._streamContentEl || streamEl.lastChild;
          if (contentEl) {
            contentEl.appendChild(document.createTextNode('\n\n[已停止]'));
          }
          streamEl.removeAttribute('id');
          delete streamEl._streamContentEl;
        }
      }
    }
    agentResponseBuffer = '';
    setStreamingState(false);
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
    // 移除粘贴预览
    var preview = document.getElementById('paste-preview');
    if (preview) preview.parentNode.removeChild(preview);
  }

  /** 显示粘贴图片的缩略预览 */
  function showPastePreview(file) {
    // 移除旧预览
    var old = document.getElementById('paste-preview');
    if (old) old.parentNode.removeChild(old);

    var reader = new FileReader();
    reader.onload = function (e) {
      var img = document.createElement('img');
      img.src = e.target.result;
      img.setAttribute('id', 'paste-preview');
      img.style.cssText = 'max-width:120px;max-height:80px;border-radius:6px;margin:6px 16px;border:1px solid var(--border-color);display:block;';
      // 插入到 file-status 后面
      var inputArea = elFileStatus ? elFileStatus.parentNode : null;
      if (inputArea && elFileStatus) {
        inputArea.insertBefore(img, elFileStatus.nextSibling);
      }
    };
    reader.readAsDataURL(file);
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
      fetchModelContext();
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
    if (wsProcessing || isStreaming) return;
    fetchServerMessages(function (serverMsgs) {
      if (!serverMsgs || serverMsgs.length === 0) return;
      // 服务端是权威数据源（后端统一写入），有新消息就更新
      if (serverMsgs.length > messages.length) {
        var wasNearBottom = isNearBottom();
        messages = serverMsgs;
        renderMessagesOnly(wasNearBottom);
        // 同步到 localStorage
        try {
          localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(serverMsgs));
        } catch (_e) { /* ignore */ }
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
      case 'stream':
        // 流式增量文本：逐 chunk 追加到当前 agent 消息
        if (userStopped) break;
        if (!isStreaming) setStreamingState(true);
        appendAgentChunk(data.delta || '');
        break;
      case 'stream_end':
        // 流式结束：定稿当前流式消息
        if (!userStopped) finalizeAgentResponse();
        break;
      case 'response':
        // 完整响应（流式结束后的最终内容，或非流式模式的回退）
        if (userStopped) break;
        // 如果刚刚 finalize 了流式消息，response 是冗余的，跳过
        if (streamFinalized) {
          streamFinalized = false;
          break;
        }
        // 非流式模式：直接显示完整响应
        finalizeAgentResponse();
        messages.push({ role: 'agent', content: data.content });
        appendMessageEl(messages[messages.length - 1]);
        saveMessages();
        break;
      case 'step':
        handleWsStep(data.step);
        break;
      case 'status':
        wsProcessing = data.status === 'processing';
        if (data.status === 'idle') {
          userStopped = false;
          removeThinking();  // LLM 结束，隐藏状态栏
        }
        setStreamingState(wsProcessing);
        break;
      case 'error':
        finalizeAgentResponse();
        messages.push({ role: 'agent', content: '[err] ' + data.message });
        appendMessageEl(messages[messages.length - 1]);
        saveMessages();
        removeThinking();
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
      case 'tool_output':
        // 工具实时输出（忽略，工具调用已在聊天区展示）
        break;
      case 'pong':
        break;
    }
  }

  function handleWsStep(step) {
    if (!step) return;
    // 更新 token 用量
    if (step.totalTokenUsage) {
      usedInputTokens = step.totalTokenUsage.inputTokens || 0;
      usedOutputTokens = step.totalTokenUsage.outputTokens || 0;
      renderContextBar();
    }
    // 更新轮次指示器
    if (step.iteration) {
      updateTurnCounter(step.iteration);
    }
    // 工具调用：在聊天区追加紧凑条目
    if (step.type === 'tool_call' && step.toolName) {
      var detail = '';
      if (step.toolArgs) {
        // 提取关键参数作为摘要（文件路径、命令等）
        detail = step.toolArgs.path || step.toolArgs.file || step.toolArgs.command || step.toolArgs.query || '';
        if (!detail) {
          var argsStr = JSON.stringify(step.toolArgs);
          detail = argsStr.length > 80 ? argsStr.substring(0, 80) + '…' : argsStr;
        }
      }
      appendToolAction(step.toolName, detail, 'pending');
    }
    // 工具结果：更新对应条目的图标
    if (step.type === 'tool_result' && step.toolName) {
      updateLastToolAction(step.toolName, step.toolSuccess ? 'success' : 'error');
    }
  }

  function handleWsConfirm(toolName, args) {
    var argsText = args ? JSON.stringify(args) : '';
    var ok = window.confirm('AI 请求执行危险操作：\n\n工具: ' + toolName + '\n参数: ' + argsText + '\n\n是否允许？');
    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'confirm_reply', approved: ok }));
    }
    var confirmMsg = { role: 'agent', content: ok ? '[ok] 用户已确认: ' + toolName : '[denied] 用户已拒绝: ' + toolName };
    messages.push(confirmMsg);
    appendMessageEl(confirmMsg);
    saveMessages();
  }

  function sendWsMessage(text) {
    if (!chatWs || chatWs.readyState !== WebSocket.OPEN) {
      messages.push({ role: 'agent', content: '[err] 未连接，无法发送' });
      renderMessages();
      return;
    }
    chatWs.send(JSON.stringify({ type: 'message', content: text }));
  }

  // ---- 命令面板 ----

  // ~ 开头：本地命令（不发送到服务器）
  // / 开头：服务端命令（发送到服务器执行）
  var PC_LOCAL_COMMANDS = [
    { name: 'clear', description: '清空当前聊天显示（记忆保留）', prefix: '~' },
    { name: 'open', description: '打开文件管理器，浏览电脑文件', prefix: '~' },
    { name: 'scan', description: '手机扫码连接，远程控制', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' }
  ];

  var REMOTE_LOCAL_COMMANDS = [
    { name: 'clear', description: '清空当前聊天显示（记忆保留）', prefix: '~' },
    { name: 'open', description: '打开文件管理器，浏览电脑文件', prefix: '~' },
    { name: 'telemetry', description: '查看记忆系统遥测报告', prefix: '~' }
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

    // 处理 ~clear 命令：清空聊天显示和后端缓存（记忆系统不受影响）
    if (text === '~clear') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      clearMessages();
      renderMessages();
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

    // 处理 ~open 命令：注入文件浏览器指令后发送给 LLM
    if (text === '~open') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      showThinking(false);
      sendWsMessage('~open\n\n' +
        '【文件浏览器模式】忽略之前对话中的所有任务和主题。你现在是文件浏览器。\n\n' +
        '核心规则：\n' +
        '- 每次调用工具后，必须把工具返回的内容（驱动器列表、目录内容）完整展示给用户。\n' +
        '- 展示完内容后等待用户下一条指令。\n' +
        '- 禁止分析、总结、评价、修改任何文件或项目。只做导航和展示。\n\n' +
        '导航规则：\n' +
        '1. 现在立即调用 list_drives，然后把所有驱动器列出来。\n' +
        '2. 用户说"进入 X:"时，调用 browse_directory 浏览该路径，然后列出目录内容。\n' +
        '3. 用户说"进入 XXX"时，拼接到当前路径，调用 browse_directory，然后列出目录内容。\n' +
        '4. 用户说"返回"时，浏览当前目录的父目录，然后列出目录内容。\n' +
        '5. 记住当前路径。\n\n' +
        '展示格式：目录用 [DIR]，文件用 [FILE]，驱动器用 [DRIVE]。');
      return;
    }

    // 处理 ~telemetry 命令：获取并显示记忆系统遥测报告
    if (text === '~telemetry') {
      elInput.value = '';
      autoResizeInput();
      hideCmdDropdown();
      messages.push({ role: 'agent', content: '正在获取记忆系统遥测报告…' });
      renderMessages();

      fetch('/api/memory/telemetry')
        .then(function (r) { return r.json(); })
        .then(function (data) {
          // 移除 "正在获取" 消息
          messages.pop();
          if (data.success && data.report) {
            messages.push({ role: 'agent', content: data.report });
          } else {
            messages.push({ role: 'agent', content: '获取遥测报告失败: ' + (data.error || '未知错误') });
          }
          renderMessages();
        })
        .catch(function () {
          messages.pop();
          messages.push({ role: 'agent', content: '获取遥测报告失败，请检查服务器是否运行' });
          renderMessages();
        });
      return;
    }

    // 统一通过 WebSocket 发送（PC 和移动端共用）
    var displayParts = [];
    if (text) displayParts.push(text);
    if (uploadedFile) displayParts.push('[file] ' + uploadedFile.filename);
    if (displayParts.length > 0) {
      var userMsg = { role: 'user', content: displayParts.join('\n') };
      messages.push(userMsg);
      appendMessageEl(userMsg);
      saveMessages();
    }
    elInput.value = '';
    autoResizeInput();
    hideCmdDropdown();
    userScrolledUp = false; // 发送新消息时重置，确保看到回复
    showThinking(!!uploadedFile);

    // 如果有文件，先上传，再把 fileId 附加到消息中
    var msgText = text || '';
    if (uploadedFile) {
      msgText = (msgText ? msgText + '\n' : '') + '[file:' + uploadedFile.fileId + '] ' + uploadedFile.filename;
    }
    removeUploadedFile();

    sendWsMessage(msgText);
    userStopped = false; // 新消息发送，重置停止标记
    streamFinalized = false;
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
        // Messages（正序 + overflow-anchor 锚点粘底）
        '<div class="chat-messages" id="chat-messages"><div class="chat-messages-anchor" id="chat-anchor"></div></div>' +
        // Thinking 指示器（fixed 悬浮）
        '<div class="agent-status-bar" id="agent-status-bar">' +
          '<span class="status-text" id="status-text"></span>' +
          '<span class="status-turn" id="status-turn"></span>' +
        '</div>' +
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
    elAnchor = container.querySelector('#chat-anchor');
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
    elContextBar = container.querySelector('#ctx-bar');
    elStatusBar = container.querySelector('#agent-status-bar');
    elStatusText = container.querySelector('#status-text');
    elStatusTurn = container.querySelector('#status-turn');

    // 立即渲染上下文条（加载状态）
    renderContextBar();

    // 监听用户滚动：检测是否手动向上滚动（脱离底部）
    elMessages.addEventListener('scroll', function () {
      var atBottom = elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight < 80;
      userScrolledUp = !atBottom;
    });

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

    // 粘贴图片支持：从剪贴板粘贴图片自动上传
    elInput.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          if (file) {
            // 生成文件名
            var ext = file.type.split('/')[1] || 'png';
            if (ext === 'jpeg') ext = 'jpg';
            var name = 'paste-' + Date.now() + '.' + ext;
            var namedFile = new File([file], name, { type: file.type });
            handleFileSelect(namedFile);
            // 显示粘贴预览
            showPastePreview(file);
          }
          return;
        }
      }
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

    // 如果活跃则恢复流水线面板
    if (!remoteMode && stages.length > 0 && currentExecutionId) {
      elPipelinePanel.classList.remove('hidden');
      renderStages();
      updateProgressBar();
    }

    // 远程模式：从服务端同步消息
    if (remoteMode) {
      messages = [];
      renderMessagesOnly();
      fetchServerMessages(function (serverMsgs) {
        if (serverMsgs.length > 0) {
          messages = serverMsgs;
          renderMessagesOnly();
        }
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
