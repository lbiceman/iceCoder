/**
 * 聊天页面主模块（重构后）
 * 职责：DOM 渲染、事件绑定、模块协调
 * 依赖：ChatSession, ChatWebSocket, ChatUI, ChatCommands, ChatFile, ChatQR, ChatPetBridge, SessionPet（冰豆）
 */

/* exported ChatPage */

window.ChatPage = (function () {
  'use strict';

  // ---- 子模块引用 ----
  var Session = window.ChatSession;
  var WS = window.ChatWebSocket;
  var UI = window.ChatUI;
  var Cmd = window.ChatCommands;
  var File = window.ChatFile;
  var QR = window.ChatQR;
  var Pet = window.ChatPetBridge;

  // ---- 状态 ----
  var container = null;
  var isStreaming = false;
  var userStopped = false;
  var streamFinalized = false;
  /** 本轮是否收到过流式增量（用于区分 stream_end + response 双包时的重复追加） */
  var streamChunksReceived = false;
  var remoteMode = false;
  var remoteToken = null;
  /** 本页仅提示一次 MCP 就绪（含 WS 晚连时 connected.mcpReady 补发） */
  var mcpReadyAnnounced = false;
  /** 本页仅提示一次公网隧道就绪 */
  var tunnelReadyAnnounced = false;

  // Token 用量
  var maxContextTokens = 0;
  var usedInputTokens = 0;
  var usedOutputTokens = 0;
  var modelName = '';

  // DOM 引用
  var elMessages, elAnchor, elInput, elSendBtn, elFileBtn, elFileInput;
  var elFileStatus, elFileName, elFileRemove;
  var elStatusBar, elStatusTurn;
  var sessionPet = null;

  // ---- 辅助 ----
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function updateNavStatus(connected) {
    var dot = document.getElementById('status-dot');
    if (dot) {
      dot.classList.toggle('connected', connected);
      dot.classList.toggle('disconnected', !connected);
      dot.title = connected ? '已连接' : '未连接';
    }
  }

  function applyModelContextFromWs(data) {
    if (!data || !data.modelContext) return false;
    var mc = data.modelContext;
    if (typeof mc.maxContextTokens === 'number' && mc.maxContextTokens > 0) {
      maxContextTokens = mc.maxContextTokens;
    }
    if (typeof mc.modelName === 'string') {
      modelName = mc.modelName;
    }
    updatePetTokenUsage();
    return true;
  }

  // ---- Token 用量 ----
  function fetchModelContext() {
    fetch('/api/config')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var providers = data.providers || [];
        var defaultProvider = providers.find(function (p) { return p.isDefault; }) || providers[0];
        if (defaultProvider) {
          maxContextTokens = defaultProvider.maxContextTokens || 0;
          modelName = defaultProvider.modelName || '';
          updatePetTokenUsage();
        }
      })
      .catch(function () { /* ignore */ });
  }

  function fetchSupportedFormats() {
    fetch('/api/chat/supported-formats')
      .then(function (res) { return res.json(); })
      .then(function () { /* ignore */ })
      .catch(function () { /* ignore */ });
  }

  function updateTokenUsage(inputTokens, outputTokens) {
    usedInputTokens = inputTokens;
    usedOutputTokens = outputTokens;
    updatePetTokenUsage();
  }

  function resetTokenUsage() {
    usedInputTokens = 0;
    usedOutputTokens = 0;
    updatePetTokenUsage();
  }

  function updatePetTokenUsage() {
    if (sessionPet && sessionPet.setTokenUsage) {
      sessionPet.setTokenUsage(usedInputTokens, maxContextTokens, usedOutputTokens);
    }
  }

  function formatTokenCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return '' + n;
  }

  // ---- 发送/停止 ----
  function handleSend() {
    if (isStreaming) {
      handleStop();
      return;
    }

    var text = elInput.value.trim();
    var uploadedFile = File.getUploadedFile();
    var pendingImages = File.getPendingImages();

    if (!text && !uploadedFile && pendingImages.length === 0) return;

    // ~clear
    if (text === '~clear') {
      elInput.value = '';
      UI.autoResizeInput();
      Cmd.hide();
      resetTokenUsage();
      Session.clearMessages(WS.isConnected() ? { send: WS.send } : null);
      UI.renderMessagesOnly(Session.getMessages(), Session.getToolTraces(), Session.stripStatusTag);
      if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
      return;
    }

    // ~scan
    if (text === '~scan' && !remoteMode) {
      elInput.value = '';
      UI.autoResizeInput();
      Cmd.hide();
      QR.showQrCode(Session.getMessages(), function (msg) { UI.appendMessageEl(msg, Session.stripStatusTag); }, Session.saveMessages);
      return;
    }

    // ~open：发给模型的指令为英文。中文含义——用户若只给文件名，须结合最近一次目录列表里的 `[当前路径]` 拼成绝对路径后再调用 parse_document / parse_pptx_deep / open_file。
    if (text === '~open') {
      elInput.value = '';
      UI.autoResizeInput();
      Cmd.hide();
      Pet.showThinking(false);
      WS.sendMessage(
        '~open\n\n' +
        '[Directory browsing] If the user only gives a file name (no folder path), combine it with the directory from the most recent listing line labeled `[当前路径]` to build the full absolute path, then call parse_document, parse_pptx_deep, or open_file as needed.',
      );
      return;
    }

    // ~telemetry
    if (text === '~telemetry') {
      elInput.value = '';
      UI.autoResizeInput();
      Cmd.hide();
      Cmd.handleTelemetry(Session.getMessages(), function (msg) { UI.appendMessageEl(msg, Session.stripStatusTag); }, Session.saveMessages);
      return;
    }

    if (text === '~memory') {
      elInput.value = '';
      UI.autoResizeInput();
      Cmd.hide();
      window.location.hash = '#/memory';
      return;
    }
    if (text.indexOf('~memory ') === 0) {
      elInput.value = '';
      UI.autoResizeInput();
      Cmd.hide();
      Cmd.handleMemory(text, Session.getMessages(), function (msg) {
        UI.appendMessageEl(msg, Session.stripStatusTag);
      }, Session.saveMessages);
      return;
    }

    // 普通消息
    var displayParts = [];
    if (text) displayParts.push(text);
    if (uploadedFile) displayParts.push('[file] ' + uploadedFile.filename);
    var msgImages = pendingImages.map(function (p) { return p.dataUrl; });

    if (displayParts.length > 0 || msgImages.length > 0) {
      UI.finalizeBeforeUserMessage(Session.getMessages(), Session.stripStatusTag);
      var userMsg = { role: 'user', content: displayParts.join('\n') || '(图片)', images: msgImages.length > 0 ? msgImages : undefined };
      Session.appendMessage(userMsg);
      UI.appendMessageEl(userMsg, Session.stripStatusTag);
      Session.saveMessages();
    }

    elInput.value = '';
    UI.autoResizeInput();
    Cmd.hide();
    userStopped = false;
    streamFinalized = false;
    streamChunksReceived = false;
    Pet.showThinking(!!uploadedFile || msgImages.length > 0);

    var msgText = text || '';
    if (uploadedFile) {
      msgText = (msgText ? msgText + '\n' : '') + '[file:' + uploadedFile.fileId + '] ' + uploadedFile.filename;
    }
    File.removeUploadedFile();

    if (msgImages.length > 0) {
      UI.resetLiveToolRoundTargets();
      UI.setLiveToolRoundActive(true);
      WS.send({ type: 'message', content: msgText || '请分析这些图片', images: msgImages });
    } else {
      WS.sendMessage(msgText);
    }
    File.clearPendingImages();
  }

  function handleStop() {
    userStopped = true;
    WS.sendStop();

    Pet.removeThinking(isStreaming, WS.isProcessing());

    var messages = Session.getMessages();
    var lastMsg = Session.getLastMessage();

    if (lastMsg && lastMsg._streaming) {
      var stoppedContent = Session.stripStatusTag(lastMsg.content || '');
      lastMsg.content = stoppedContent ? stoppedContent + '\n\n[已停止]' : '[已停止]';
      Session.markLastMessageStreaming(false);

      var streamEl = document.getElementById('streaming-msg');
      if (streamEl) {
        var contentEl = streamEl._streamContentEl || streamEl.lastChild;
        if (contentEl) contentEl.textContent = lastMsg.content;
        streamEl.removeAttribute('id');
        delete streamEl._streamContentEl;
      }
      Session.flushToolBatchLocal();
    } else {
      var infoMsg = { role: 'agent', content: '[已停止]' };
      Session.appendMessage(infoMsg);
      Session.flushToolBatchLocal();
      UI.appendMessageEl(infoMsg, Session.stripStatusTag);
    }

    isStreaming = false;
    streamFinalized = false;
    streamChunksReceived = false;
    UI.setStreamingState(false);
    WS.setProcessing(false);
    Session.saveMessages();
  }

  function announceTunnelReadyFromPayload(payload) {
    if (!payload || !payload.url || tunnelReadyAnnounced) return;
    tunnelReadyAnnounced = true;
    Pet.applyTunnelReadyToPet(payload, {
      isStreaming: isStreaming,
      wsProcessing: WS.isProcessing(),
    });
  }

  function announceMcpReadyFromPayload(payload) {
    if (!payload || mcpReadyAnnounced) return;
    mcpReadyAnnounced = true;
    Pet.applyMcpReadyToPet(payload, {
      isStreaming: isStreaming,
      wsProcessing: WS.isProcessing(),
    });
  }

  function onWsConnected(data) {
    if (!applyModelContextFromWs(data)) {
      fetchModelContext();
    }
    if (data && data.mcpReady) {
      announceMcpReadyFromPayload(data.mcpReady);
    }
    if (data && data.tunnelReady) {
      announceTunnelReadyFromPayload(data.tunnelReady);
    }
    if (window.ChatExecutionPlanBridge && typeof window.ChatExecutionPlanBridge.notifyConnected === 'function') {
      window.ChatExecutionPlanBridge.notifyConnected(data || {});
    }
  }

  // ---- WebSocket 事件处理 ----
  function onWsOpen() {
    updateNavStatus(true);
    syncMessages();
    WS.startSyncPolling();
  }

  function onWsClose() {
    updateNavStatus(false);
    isStreaming = false;
    UI.setStreamingState(false);
  }

  function onWsStream(data) {
    if (userStopped) return;
    streamChunksReceived = true;
    if (!isStreaming) {
      isStreaming = true;
      UI.setStreamingState(true);
    }
    if (sessionPet) sessionPet.setState('read');
    UI.appendStreamChunk(data.delta, Session.getMessages(), Session.stripStatusTag);
  }

  function onWsStreamEnd() {
    if (!userStopped) {
      UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
      if (streamChunksReceived) {
        streamFinalized = true;
      }
    }
    streamChunksReceived = false;
    isStreaming = false;
    UI.setStreamingState(false);
  }

  function onWsResponse(data) {
    if (userStopped) {
      userStopped = false;
      return;
    }
    if (streamFinalized) {
      streamFinalized = false;
      return;
    }
    UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
    var msg = { role: 'agent', content: Session.stripStatusTag(data.content || '') };
    Session.appendMessage(msg);
    Session.flushToolBatchLocal();
    UI.appendMessageEl(msg, Session.stripStatusTag);
    Session.saveMessages();
  }

  function onWsStep(data) {
    var step = data.step;
    if (!step) return;

    if (step.totalTokenUsage) {
      usedInputTokens = step.totalTokenUsage.inputTokens || 0;
      usedOutputTokens = step.totalTokenUsage.outputTokens || 0;
      updatePetTokenUsage();
    }
    if (step.iteration) {
      Pet.updateTurnCounter(step.iteration, isStreaming, WS.isProcessing());
    }
    if (step.type === 'tool_progress' && step.content) {
      Pet.setLastToolProgressHint(step.content);
      WS.setLastToolProgressHint(step.content);
      Pet.updateStatusText(step.content, isStreaming, WS.isProcessing());
    }
    if (step.type === 'tool_call' && step.toolName) {
      var detail = '';
      if (step.toolArgs) {
        detail = step.toolArgs.path || step.toolArgs.file || step.toolArgs.command || step.toolArgs.query || '';
        if (!detail) {
          var argsStr = JSON.stringify(step.toolArgs);
          detail = argsStr.length > 80 ? argsStr.substring(0, 80) + '…' : argsStr;
        }
      }
      UI.appendToolAction(step.toolName, detail, 'pending');
      Session.pushToolBatch({ toolName: step.toolName, detail: detail, status: 'pending' });
    }
    if (step.type === 'tool_result' && step.toolName) {
      var resultStatus = step.toolSuccess ? 'success' : 'error';
      UI.updateLastToolAction(step.toolName, resultStatus);
      Session.updateToolBatchStatus(step.toolName, resultStatus);
    }
    if (window.ChatExecutionPlanBridge
      && (step.type === 'execution_plan_init'
        || step.type === 'execution_plan_update'
        || step.type === 'execution_plan_clear')) {
      window.ChatExecutionPlanBridge.handleStep(step);
    }
    Pet.applyHarnessStepToPet(step, isStreaming, WS.isProcessing());
  }

  function onWsStatus(data) {
    var processing = data.status === 'processing';
    WS.setProcessing(processing);
    if (!processing) {
      if (userStopped) userStopped = false;
      Pet.removeThinking(isStreaming, WS.isProcessing());
      UI.setStreamingState(false);
      isStreaming = false;
    } else {
      UI.setStreamingState(true);
      if (sessionPet) sessionPet.setState('thinking');
    }
  }

  function onWsError(data) {
    UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
    var msg = { role: 'agent', content: '[err] ' + data.message };
    Session.appendMessage(msg);
    UI.appendMessageEl(msg, Session.stripStatusTag);
    Session.saveMessages();
    Pet.removeThinking(isStreaming, WS.isProcessing());
  }

  function onWsMcpReady(data) {
    announceMcpReadyFromPayload(data || {});
  }

  function onWsTunnelReady(data) {
    announceTunnelReadyFromPayload(data || {});
  }

  function onWsMemoryNotice(data) {
    var notices = data.notices || [];
    var messages = Session.getMessages();
    for (var i = 0; i < notices.length; i++) {
      messages.push({ role: 'agent', content: notices[i] });
      UI.appendMessageEl(messages[messages.length - 1], Session.stripStatusTag);
    }
    Session.saveMessages();
    Pet.applyMemoryNoticesToPet(notices, {
      isStreaming: isStreaming,
      wsProcessing: WS.isProcessing(),
    });
  }

  function onWsConfirm(data) {
    if (sessionPet) {
      sessionPet.setState('alert');
      sessionPet.setBubbleText('请在弹窗中确认危险操作');
    }
    var argsText = data.args ? JSON.stringify(data.args) : '';
    var ok = window.confirm('AI 请求执行危险操作：\n\n工具: ' + data.toolName + '\n参数: ' + argsText + '\n\n是否允许？');
    WS.sendConfirmReply(ok);
    var confirmMsg = { role: 'agent', content: ok ? '[ok] 用户已确认: ' + data.toolName : '[denied] 用户已拒绝: ' + data.toolName };
    Session.appendMessage(confirmMsg);
    UI.appendMessageEl(confirmMsg, Session.stripStatusTag);
    Session.saveMessages();
    if (sessionPet) {
      sessionPet.setState(isStreaming || WS.isProcessing() ? 'read' : 'idle');
      sessionPet.setBubbleText('');
    }
  }

  function onWsTokenUsage(data) {
    updateTokenUsage(data.inputTokens || 0, data.outputTokens || 0);
  }

  function onWsPulse(data) {
    if (!sessionPet) return;
    var hint = data && data.hint ? data.hint : '处理中';
    Pet.updateStatusText(hint, isStreaming, WS.isProcessing());
  }

  function syncMessages() {
    if (WS.isProcessing() || isStreaming || Session.hasStreamingModelBubble()) return;
    Session.fetchServerMessages(function (serverMsgs) {
      if (!serverMsgs || serverMsgs.length === 0) return;
      var separated = Session.separateToolTraces(serverMsgs);
      var updated = Session.applyServerChatSnapshot(separated, { fullRender: false }, isStreaming, WS.isProcessing());
      if (updated) {
        UI.renderMessagesOnly(Session.getMessages(), Session.getToolTraces(), Session.stripStatusTag);
        Session.saveMessages();
      }
    });
  }

  function pullServerChatSnapshotAuthoritative() {
    if (WS.isProcessing() || isStreaming || Session.hasStreamingModelBubble()) return;
    Session.fetchServerMessages(function (serverMsgs) {
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      var separated = Session.separateToolTraces(raw);
      if (Session.applyServerChatSnapshot(separated, { fullRender: false, authoritative: true }, isStreaming, WS.isProcessing())) {
        UI.renderMessagesOnly(Session.getMessages(), Session.getToolTraces(), Session.stripStatusTag);
        Session.saveMessages();
      }
    });
  }

  function onWsSessionUpdated() {
    if (window.ChatExecutionPlanBridge && typeof window.ChatExecutionPlanBridge.notifySessionUpdated === 'function') {
      window.ChatExecutionPlanBridge.notifySessionUpdated();
    }
    pullServerChatSnapshotAuthoritative();
  }

  // ---- 渲染 ----
  function render(parentEl) {
    container = parentEl;

    var params = new URLSearchParams(window.location.search);
    remoteToken = params.get('token');
    remoteMode = !!remoteToken;

    container.innerHTML =
      '<div class="chat-page">' +
        '<div class="chat-messages" id="chat-messages"><div class="chat-messages-anchor" id="chat-anchor"></div></div>' +
        '<div class="session-pet-indicator" id="agent-status-bar">' +
          '<div class="pet-bubble" id="pet-bubble" role="status" aria-live="polite"></div>' +
          '<canvas class="pet-canvas" id="pet-canvas" width="96" height="96" role="img" aria-label="' +
          (window.SESSION_PET_DISPLAY_NAME || '冰豆') +
          '，拖动移动；双击恢复默认位置" title="' +
          (window.SESSION_PET_DISPLAY_NAME || '冰豆') +
          '：拖动移动；双击恢复默认位置"></canvas>' +
          '<span class="status-turn" id="status-turn"></span>' +
        '</div>' +
        '<div class="chat-input-area">' +
          '<div class="pending-images-preview hidden" id="pending-images-preview"></div>' +
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

    // 缓存 DOM
    elMessages = container.querySelector('#chat-messages');
    elAnchor = container.querySelector('#chat-anchor');
    elInput = container.querySelector('#chat-input');
    elSendBtn = container.querySelector('#btn-send');
    elFileBtn = container.querySelector('#btn-file');
    elFileInput = container.querySelector('#file-input');
    elFileStatus = container.querySelector('#file-status');
    elFileName = container.querySelector('#file-name');
    elFileRemove = container.querySelector('#file-remove');
    elStatusBar = container.querySelector('#agent-status-bar');
    elStatusTurn = container.querySelector('#status-turn');

    // 初始化子模块
    UI.init({ elMessages: elMessages, elAnchor: elAnchor, elInput: elInput, elSendBtn: elSendBtn });
    File.init({ elFileStatus: elFileStatus, elFileName: elFileName, elFileInput: elFileInput });
    Cmd.setRemoteMode(remoteMode);
    var cmdDropdown = Cmd.init();
    var inputWrapper = container.querySelector('.input-wrapper');
    if (inputWrapper && cmdDropdown) inputWrapper.appendChild(cmdDropdown);

    // 初始化冰豆（会话指示器）
    if (window.SessionPet) {
      sessionPet = window.SessionPet.create(elStatusBar);
      Pet.init(sessionPet);
    }

    // 初始化会话：先从 localStorage 载入（本地页与远程页都需要内存里有消息再绘制）
    Session.initSession();

    fetchSupportedFormats();

    // 绑定 WebSocket 事件
    WS.on('open', onWsOpen);
    WS.on('connected', onWsConnected);
    WS.on('close', onWsClose);
    WS.on('stream', onWsStream);
    WS.on('stream_end', onWsStreamEnd);
    WS.on('response', onWsResponse);
    WS.on('step', onWsStep);
    WS.on('status', onWsStatus);
    WS.on('error', onWsError);
    WS.on('mcp_ready', onWsMcpReady);
    WS.on('tunnel_ready', onWsTunnelReady);
    WS.on('memory_notice', onWsMemoryNotice);
    WS.on('confirm', onWsConfirm);
    WS.on('tokenUsage', onWsTokenUsage);
    WS.on('pulse', onWsPulse);
    WS.on('session_updated', onWsSessionUpdated);
    WS.on('sync', syncMessages);

    // 连接 WebSocket
    WS.connect(remoteToken);

    // 绑定 UI 事件
    elSendBtn.addEventListener('click', handleSend);
    elInput.addEventListener('keydown', function (e) {
      if (Cmd.handleKeydown(e, elInput)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
    elInput.addEventListener('input', function () {
      UI.autoResizeInput();
      Cmd.handleInput(elInput.value);
    });
    elInput.addEventListener('blur', function () {
      setTimeout(Cmd.hide, 150);
    });
    elInput.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          e.preventDefault();
          var file = items[i].getAsFile();
          if (file) File.addPendingImage(file);
          return;
        }
      }
    });

    // 拖拽支持
    var chatPage = container.querySelector('.chat-page');
    if (chatPage) {
      chatPage.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chatPage.classList.add('drag-over');
      });
      chatPage.addEventListener('dragleave', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chatPage.classList.remove('drag-over');
      });
      chatPage.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        chatPage.classList.remove('drag-over');
        var files = e.dataTransfer && e.dataTransfer.files;
        if (!files) return;
        for (var i = 0; i < files.length; i++) {
          if (files[i].type.indexOf('image/') === 0) {
            File.addPendingImage(files[i]);
          } else {
            File.handleFileSelect(files[i], Session.getMessages(), function (msg) { UI.appendMessageEl(msg, Session.stripStatusTag); }, Session.saveMessages);
          }
        }
      });
    }

    if (elFileBtn) {
      elFileBtn.addEventListener('click', function () {
        elFileInput.click();
      });
    }
    if (elFileInput) {
      elFileInput.addEventListener('change', function () {
        if (elFileInput.files && elFileInput.files[0]) {
          File.handleFileSelect(elFileInput.files[0], Session.getMessages(), function (msg) { UI.appendMessageEl(msg, Session.stripStatusTag); }, Session.saveMessages);
        }
      });
    }
    if (elFileRemove) {
      elFileRemove.addEventListener('click', File.removeUploadedFile);
    }

    // 渲染已有消息（远程模式先展示本地缓存；服务端返回后以快照为准刷新）
    UI.renderMessagesOnly(Session.getMessages(), Session.getToolTraces(), Session.stripStatusTag);

    if (remoteMode) {
      Session.fetchServerMessages(function (serverMsgs) {
        var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
        var separated = Session.separateToolTraces(raw);
        if (Session.applyServerChatSnapshot(separated, { fullRender: false, authoritative: true }, isStreaming, WS.isProcessing())) {
          UI.renderMessagesOnly(Session.getMessages(), Session.getToolTraces(), Session.stripStatusTag);
          Session.saveMessages();
        }
      });
    }

    // 切回前台重连
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        syncMessages();
        if (!WS.isConnected()) {
          WS.connect(remoteToken);
        }
      } else {
        WS.stopSyncPolling();
      }
    });
  }

  return { render: render };
})();
