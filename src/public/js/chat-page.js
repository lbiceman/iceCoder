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
  /**
   * 方案 A keep-alive：ChatPage.render 只执行一次；
   * 切到配置 / 记忆页再切回来不会重建 DOM、不重连 WS、不丢失流式状态。
   */
  var mounted = false;
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
  var elCmdPlusBtn, elCmdPalette, mainInputWrapper;
  var sessionPet = null;
  var cmdPaletteOpen = false;
  var cmdBlurHideTimer = null;

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

  /** 后端仍在跑 / 本地流式未结束 → 发送钮应显示为 Stop */
  function isWorkloadActive() {
    return WS.isProcessing()
      || isStreaming
      || (Session && typeof Session.hasStreamingModelBubble === 'function' && Session.hasStreamingModelBubble());
  }

  /** 切回聊天页或 WS 状态变化后，把发送钮与真实 workload 对齐（DOM 重建不会保留 btn-stop） */
  function syncSendButtonWithWorkload() {
    var busy = isWorkloadActive();
    UI.setStreamingState(busy);
    if (sessionPet) {
      if (busy) {
        sessionPet.setState(isStreaming ? 'read' : 'thinking');
      } else if (!userStopped) {
        sessionPet.setState('idle');
      }
    }
  }

  // ---- 命令面板（+ 按钮） ----
  function closeCmdPalette() {
    if (!elCmdPalette || !cmdPaletteOpen) return;
    cmdPaletteOpen = false;
    elCmdPalette.classList.add('hidden');
    if (elCmdPlusBtn) elCmdPlusBtn.classList.remove('active');
    Cmd.hide();
    Cmd.setApplyTarget(null);
    if (mainInputWrapper) Cmd.mountDropdownTo(mainInputWrapper);
  }

  function openCmdPalette() {
    if (!elCmdPalette) return;
    if (cmdBlurHideTimer) {
      clearTimeout(cmdBlurHideTimer);
      cmdBlurHideTimer = null;
    }
    cmdPaletteOpen = true;
    elCmdPalette.classList.remove('hidden');
    if (elCmdPlusBtn) elCmdPlusBtn.classList.add('active');
    Cmd.mountDropdownTo(elCmdPalette);
    Cmd.setApplyTarget(function (value) {
      executeLocalCommand(value);
      closeCmdPalette();
    });
    Cmd.show('~', '');
    elCmdPalette.focus();
  }

  function toggleCmdPalette() {
    if (cmdPaletteOpen) closeCmdPalette();
    else openCmdPalette();
  }

  /** 本地 ~ 命令：选中即执行，返回 true 表示已处理 */
  function executeLocalCommand(text) {
    text = (text || '').trim();
    if (!text) return false;

    if (text === '~scan' && !remoteMode) {
      Cmd.hide();
      QR.showQrCode(Session.getMessages(), function (msg) { UI.appendMessageEl(msg, Session.stripStatusTag); }, Session.saveMessages);
      return true;
    }

    if (text === '~open') {
      Cmd.hide();
      Pet.showThinking(false);
      UI.resetLiveToolRoundTargets();
      UI.setLiveToolRoundActive(true);
      WS.sendMessage(
        '~open\n\n' +
        '[Directory browsing] If the user only gives a file name (no folder path), combine it with the directory from the most recent listing line labeled `[当前路径]` to build the full absolute path, then call parse_document, parse_pptx_deep, or open_file as needed.',
      );
      return true;
    }

    if (text === '~telemetry') {
      Cmd.hide();
      Cmd.handleTelemetry(Session.getMessages(), function (msg) { UI.appendMessageEl(msg, Session.stripStatusTag); }, Session.saveMessages);
      return true;
    }

    if (text === '~supervisor' || text.indexOf('~supervisor ') === 0) {
      Cmd.hide();
      Cmd.handleSupervisor(text, Session.getMessages(), function (msg) { UI.appendMessageEl(msg, Session.stripStatusTag); }, Session.saveMessages);
      return true;
    }

    if (text === '~memory') {
      Cmd.hide();
      window.location.hash = '#/memory';
      return true;
    }

    if (text.indexOf('~memory ') === 0) {
      Cmd.hide();
      Cmd.handleMemory(text, Session.getMessages(), function (msg) {
        UI.appendMessageEl(msg, Session.stripStatusTag);
      }, Session.saveMessages);
      return true;
    }

    return false;
  }

  // ---- 发送/停止 ----
  function handleSend() {
    closeCmdPalette();
    if (isWorkloadActive()) {
      handleStop();
      return;
    }

    var text = elInput.value.trim();
    var uploadedFile = File.getUploadedFile();
    var pendingImages = File.getPendingImages();

    if (!text && !uploadedFile && pendingImages.length === 0) return;

    if (executeLocalCommand(text)) {
      elInput.value = '';
      UI.autoResizeInput();
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
      var titlePrompt = displayParts.join('\n') || text || '';
      if (window.ChatSessionStore && typeof window.ChatSessionStore.maybeAutoTitleFromPrompt === 'function') {
        var userMsgCount = 0;
        var allMsgs = Session.getMessages();
        for (var ti = 0; ti < allMsgs.length; ti++) {
          if (allMsgs[ti].role === 'user') userMsgCount++;
        }
        if (userMsgCount === 1) {
          window.ChatSessionStore.maybeAutoTitleFromPrompt(Session.getActiveId(), titlePrompt);
        }
      }
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

    UI.resetLiveToolRoundTargets();
    UI.setLiveToolRoundActive(true);
    if (msgImages.length > 0) {
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

  function syncSidebarWorkspace(data) {
    if (!data || !window.ChatSessionSidebar) return;
    var sid = data.sessionId || data.activeSessionId;
    if (sid && typeof window.ChatSessionSidebar.notifyWorkspaceUpdated === 'function') {
      window.ChatSessionSidebar.notifyWorkspaceUpdated(Object.assign({ sessionId: sid }, data));
    }
  }

  /** 会话切换：侧栏或 WS 重连后同步服务端 activeSessionId。第二个参数 runningTurn 由服务端 session_switched 包带回。 */
  function onSessionSwitched(sessionId, runningTurn) {
    if (Session && typeof Session.setSessionId === 'function') {
      Session.setSessionId(sessionId);
    }
    if (elMessages) {
      UI.renderMessagesOnly(Session.getMessages(), Session.getToolTraces(), Session.stripStatusTag);
    }
    Session.fetchServerMessages(function (serverMsgs) {
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      var separated = Session.separateToolTraces(raw);
      Session.applyServerChatSnapshot(separated, { fullRender: true, authoritative: true }, isStreaming, WS.isProcessing());
      UI.renderMessagesOnly(Session.getMessages(), Session.getToolTraces(), Session.stripStatusTag);
      Session.saveMessages();
      // 服务端消息渲染后再叠加 runningTurn（流式 bubble 永远位于消息列表尾）
      if (runningTurn) restoreFromRunningTurn(runningTurn);
    });
    resetTokenUsage();
    if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
    if (window.ChatSessionSidebar && typeof window.ChatSessionSidebar.renderList === 'function') {
      window.ChatSessionSidebar.renderList();
    }
    // 即使 fetch 还没回来，先按 runningTurn 设置好按钮/冰豆，避免短暂闪烁
    if (runningTurn) restoreFromRunningTurn(runningTurn);
  }

  function syncActiveSessionFromServer(data) {
    if (remoteMode || !data) return;
    var serverId = data.activeSessionId || data.sessionId;
    if (!serverId) return;
    var clientId = Session.getActiveId ? Session.getActiveId() : 'default';
    if (window.ChatSessionStore && typeof window.ChatSessionStore.setActiveSessionId === 'function') {
      window.ChatSessionStore.setActiveSessionId(serverId);
    }
    if (serverId !== clientId) {
      onSessionSwitched(serverId);
    }
  }

  /**
   * 把工具时间线渲染到 live 工具区（F5 / runningTurn / localStorage 共用）
   */
  function applyLiveToolTimelineToUI(timeline) {
    if (!timeline || !timeline.length || !elMessages) return;
    if (UI.clearLiveToolRoundDom) UI.clearLiveToolRoundDom();
    UI.setLiveToolRoundActive(true);
    for (var i = 0; i < timeline.length; i++) {
      var row = timeline[i];
      UI.appendToolAction(row.toolName, row.detail || '', row.status || 'pending');
    }
  }

  function pickToolTimelineForRestore(runningTurn) {
    var serverTimeline = runningTurn && Array.isArray(runningTurn.toolTimeline)
      ? runningTurn.toolTimeline
      : [];
    if (serverTimeline.length > 0) {
      if (Session.replaceLiveToolBatch) Session.replaceLiveToolBatch(serverTimeline);
      return serverTimeline;
    }
    var localTimeline = Session.loadLiveToolBatch ? Session.loadLiveToolBatch() : [];
    if (localTimeline.length > 0) return localTimeline;
    return [];
  }

  /**
   * 方案 B3 还原：F5 / 移动端扫码 / 网络重连 / 切 session 等场景下
   * 服务端在 `connected` 或 `session_switched` 包里附带 runningTurn 快照，
   * 这里把流式文本、工具时间线、冰豆、按钮、token、计划重放一遍，使 UI 看起来「跟没断过」。
   * 多次调用安全。runningTurn 为空时退化为 no-op（并把 isStreaming 复位）。
   */
  function restoreFromRunningTurn(runningTurn) {
    if (!runningTurn || !runningTurn.isProcessing) {
      // 无服务端 runningTurn 时保留 localStorage 占位（初始 render 已绘制），由 status:idle 清理
      isStreaming = false;
      userStopped = false;
      streamFinalized = false;
      streamChunksReceived = false;
      WS.setProcessing(false);
      UI.setStreamingState(false);
      if (sessionPet) {
        sessionPet.setState('idle');
        sessionPet.setBubbleText('');
        sessionPet.setTurnLabel('');
      }
      return;
    }

    // 1. 流式文本：先收尾上一段残留，再用累积文本重建 streaming bubble
    UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
    if (runningTurn.streamingText) {
      UI.appendStreamChunk(runningTurn.streamingText, Session.getMessages(), Session.stripStatusTag);
      streamChunksReceived = true;
    }

    // 2. 标记 streaming 中
    isStreaming = !!runningTurn.streamingText;
    userStopped = false;
    streamFinalized = false;
    WS.setProcessing(true);
    UI.setStreamingState(true);

    // 3. 工具时间线：服务端 runningTurn 优先，否则 localStorage 缓存
    var toolTimeline = pickToolTimelineForRestore(runningTurn);
    applyLiveToolTimelineToUI(toolTimeline);

    // 4. token 用量 & 轮次
    if (typeof runningTurn.lastInputTokens === 'number' || typeof runningTurn.lastOutputTokens === 'number') {
      updateTokenUsage(runningTurn.lastInputTokens || 0, runningTurn.lastOutputTokens || 0);
    }
    if (runningTurn.iteration > 0) {
      Pet.updateTurnCounter(runningTurn.iteration, isStreaming, true);
    }

    // 5. 冰豆状态 & 气泡
    if (sessionPet) {
      sessionPet.setVisible(true);
      if (runningTurn.petState) sessionPet.setState(runningTurn.petState);
      if (runningTurn.petBubble) sessionPet.setBubbleText(runningTurn.petBubble);
      else if (runningTurn.petStatusText) sessionPet.setBubbleText(runningTurn.petStatusText);
    }

    // 6. 执行计划 / 任务图：重放保存的 step 事件
    if (Array.isArray(runningTurn.planEvents) && window.ChatExecutionPlanBridge
        && typeof window.ChatExecutionPlanBridge.handleStep === 'function') {
      for (var j = 0; j < runningTurn.planEvents.length; j++) {
        try { window.ChatExecutionPlanBridge.handleStep(runningTurn.planEvents[j]); }
        catch (_e) { /* ignore */ }
      }
    }
  }

  function onWsConnected(data) {
    if (!applyModelContextFromWs(data)) {
      fetchModelContext();
    }
    syncSidebarWorkspace(data);
    if (window.ChatSessionStore && typeof window.ChatSessionStore.fetchSessions === 'function') {
      window.ChatSessionStore.fetchSessions();
    }
    // 先还原 runningTurn，避免 syncActiveSessionFromServer / notifyConnected 触发重绘清掉工具区
    if (data) restoreFromRunningTurn(data.runningTurn || null);
    if (data && data.mcpReady) {
      announceMcpReadyFromPayload(data.mcpReady);
    }
    if (data && data.tunnelReady) {
      announceTunnelReadyFromPayload(data.tunnelReady);
    }
    syncActiveSessionFromServer(data || {});
    if (window.ChatExecutionPlanBridge && typeof window.ChatExecutionPlanBridge.notifyConnected === 'function') {
      window.ChatExecutionPlanBridge.notifyConnected(data || {});
    }
    // 任务进行中（runningTurn）时跳过服务端快照合并，避免覆盖刚还原的 live 工具区
    var rt = data && data.runningTurn;
    if (!rt || !rt.isProcessing) {
      syncMessages();
    }
  }

  // ---- WebSocket 事件处理 ----
  function onWsOpen() {
    updateNavStatus(true);
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

    // P3 — 用户已点 Stop：后端 harness 还在收尾（写 checkpoint / drain memory）期间会继续推
    // step / stream_delta，UI 不再据此切冰豆状态，否则会出现「按钮变 Send 了但冰豆还在动」。
    // userStopped 会在 status:idle 或下一次 sendMessage 时被清掉。
    if (userStopped) return;

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
      var resultStatus = step.toolOutcome === 'policy_block'
        ? 'warn'
        : (step.toolSuccess ? 'success' : 'error');
      UI.updateLastToolAction(step.toolName, resultStatus);
      Session.updateToolBatchStatus(step.toolName, resultStatus);
    }
    if (window.ChatExecutionPlanBridge
      && (step.type === 'execution_plan_init'
        || step.type === 'execution_plan_update'
        || step.type === 'execution_plan_clear'
        || step.type === 'task_graph_init'
        || step.type === 'task_graph_node'
        || step.type === 'task_graph_update'
        || step.type === 'task_graph_branch'
        || step.type === 'task_graph_done'
        || step.type === 'execution_mode_enter'
        || step.type === 'execution_mode_exit')) {
      window.ChatExecutionPlanBridge.handleStep(step);
    }
    Pet.applyHarnessStepToPet(step, isStreaming, WS.isProcessing());
  }

  function onWsStatus(data) {
    var processing = data.status === 'processing';
    WS.setProcessing(processing);
    if (!processing) {
      if (userStopped) userStopped = false;
      isStreaming = false;
      Pet.removeThinking(isStreaming, WS.isProcessing());
      if (Session.clearLiveToolBatch) Session.clearLiveToolBatch();
    } else if (!userStopped) {
      if (sessionPet) sessionPet.setState('thinking');
    }
    syncSendButtonWithWorkload();
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

  /** 当前正在显示的 confirm 对话框（用于其它端 first-win 后关闭本地弹窗） */
  var activeConfirmId = null;
  var activeConfirmResolved = false;

  function onWsConfirm(data) {
    if (sessionPet) {
      sessionPet.setState('alert');
      sessionPet.setBubbleText('请在弹窗中确认危险操作');
    }
    activeConfirmId = data.confirmId || null;
    activeConfirmResolved = false;
    var argsText = data.args ? JSON.stringify(data.args) : '';
    // 注意：window.confirm 是同步阻塞，单端用户必须先选择；
    // 但只要服务端已经 first-win 关闭，我们丢弃本地结果即可。
    var ok = window.confirm('AI 请求执行危险操作：\n\n工具: ' + data.toolName + '\n参数: ' + argsText + '\n\n是否允许？');
    if (activeConfirmResolved) {
      // 其它端已经回复，丢弃本地选择
      activeConfirmId = null;
      activeConfirmResolved = false;
      if (sessionPet) {
        sessionPet.setState(isStreaming || WS.isProcessing() ? 'read' : 'idle');
        sessionPet.setBubbleText('');
      }
      return;
    }
    WS.sendConfirmReply(ok, activeConfirmId);
    activeConfirmId = null;
    var confirmMsg = { role: 'agent', content: ok ? '[ok] 用户已确认: ' + data.toolName : '[denied] 用户已拒绝: ' + data.toolName };
    Session.appendMessage(confirmMsg);
    UI.appendMessageEl(confirmMsg, Session.stripStatusTag);
    Session.saveMessages();
    if (sessionPet) {
      sessionPet.setState(isStreaming || WS.isProcessing() ? 'read' : 'idle');
      sessionPet.setBubbleText('');
    }
  }

  function onWsConfirmResolved(data) {
    if (!data) return;
    // 标记本地弹窗的回复已被服务端 first-win
    if (!activeConfirmId || data.confirmId === activeConfirmId) {
      activeConfirmResolved = true;
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

  function shouldSkipServerSnapshotSync() {
    return WS.isProcessing() || isStreaming || Session.hasStreamingModelBubble();
  }

  function syncMessages() {
    if (shouldSkipServerSnapshotSync()) return;
    Session.fetchServerMessages(function (serverMsgs) {
      // F5 重连：onWsOpen 发起的 fetch 可能在 connected+restore 之后才返回；
      // 此时若仍 renderMessagesOnly 会清掉 runningTurn 刚还原的工具时间线/流式气泡。
      if (shouldSkipServerSnapshotSync()) return;
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
    if (shouldSkipServerSnapshotSync()) return;
    Session.fetchServerMessages(function (serverMsgs) {
      if (shouldSkipServerSnapshotSync()) return;
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      var separated = Session.separateToolTraces(raw);
      if (Session.applyServerChatSnapshot(separated, { fullRender: false, authoritative: true }, isStreaming, WS.isProcessing())) {
        UI.renderMessagesOnly(Session.getMessages(), Session.getToolTraces(), Session.stripStatusTag);
        Session.saveMessages();
      }
    });
  }

  function onWsSessionUpdated(data) {
    if (data && data.sessionId && data.title && window.ChatSessionStore
        && typeof window.ChatSessionStore.patchSession === 'function') {
      window.ChatSessionStore.patchSession(data.sessionId, { title: data.title });
    }
    if (window.ChatExecutionPlanBridge && typeof window.ChatExecutionPlanBridge.notifySessionUpdated === 'function') {
      window.ChatExecutionPlanBridge.notifySessionUpdated();
    }
    if (!data || !data.title) {
      pullServerChatSnapshotAuthoritative();
    }
  }

  function onWsBgTaskUpdate(payload) {
    if (!window.BgTaskChip || !elMessages) return;
    // 当前 sessionId 来源：ChatSession.getActiveId 若存在则用；否则不过滤（兼容当前单 session 模型）
    var activeId = (Session && typeof Session.getActiveId === 'function')
      ? Session.getActiveId()
      : '';
    window.BgTaskChip.handleUpdate(elMessages, payload, activeId);
  }

  /**
   * 方案 A keep-alive：app.js navigate 回聊天页时调用。
   * 此时 DOM、WS、流式状态都还在，仅做一次轻量级同步（拉服务端快照、对齐按钮态）。
   */
  function onActivate() {
    if (!mounted) return;
    if (WS && typeof WS.isConnected === 'function' && !WS.isConnected()) {
      WS.connect(remoteToken);
    }
    syncSendButtonWithWorkload();
    if (!WS.isProcessing() && !isStreaming && !Session.hasStreamingModelBubble()) {
      syncMessages();
    }
  }

  // ---- 渲染 ----
  function render(parentEl) {
    if (mounted) {
      // 方案 A：已经挂载，切页面回来不再重建
      onActivate();
      return;
    }
    mounted = true;
    container = parentEl;

    var params = new URLSearchParams(window.location.search);
    remoteToken = params.get('token');
    remoteMode = !!remoteToken;

    container.innerHTML =
      '<div class="chat-page chat-layout">' +
        '<div class="chat-main">' +
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
            '<div class="cmd-palette-anchor">' +
              '<button class="btn-icon btn-cmd-plus" id="btn-cmd-plus" type="button" title="命令"><span class="icon-plus"></span></button>' +
              '<div class="cmd-palette hidden" id="cmd-palette" tabindex="-1" role="menu" aria-label="命令列表"></div>' +
            '</div>' +
          '</div>' +
          '<input type="file" class="hidden-input" id="file-input">' +
        '</div>' +
        '</div>' + /* /chat-main */
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
    elCmdPlusBtn = container.querySelector('#btn-cmd-plus');
    elCmdPalette = container.querySelector('#cmd-palette');
    mainInputWrapper = container.querySelector('.input-wrapper');

    // 初始化会话侧栏（PC 模式）
    if (!remoteMode && window.ChatSessionSidebar) {
      var chatLayout = container.querySelector('.chat-layout');
      if (chatLayout) {
        window.ChatSessionSidebar.create(chatLayout);
        var navBrand = document.querySelector('.nav-brand');
        var panelToggle = document.getElementById('nav-sidebar-toggle');
        if (navBrand && !panelToggle) {
          panelToggle = document.createElement('button');
          panelToggle.type = 'button';
          panelToggle.className = 'nav-sidebar-toggle is-expanded';
          panelToggle.id = 'nav-sidebar-toggle';
          panelToggle.title = '隐藏会话列表';
          panelToggle.setAttribute('aria-label', '显示或隐藏会话列表');
          panelToggle.setAttribute('aria-pressed', 'true');
          panelToggle.innerHTML =
            '<span class="nav-sidebar-toggle-icon" aria-hidden="true">' +
              '<svg class="icon-panel-open" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
                '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
                '<path d="M9 4v16"/>' +
              '</svg>' +
              '<svg class="icon-panel-closed" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
                '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
                '<path d="M9 4v16"/>' +
                '<path d="M14 12h5"/>' +
                '<path d="M17 9l3 3-3 3"/>' +
              '</svg>' +
            '</span>';
          panelToggle.addEventListener('click', function () {
            window.ChatSessionSidebar.togglePanel();
          });
          navBrand.insertBefore(panelToggle, navBrand.firstChild);
        }
        if (panelToggle) {
          window.ChatSessionSidebar.bindNavToggle(panelToggle);
        }
      }
      // 加载会话列表
      if (window.ChatSessionStore) {
        window.ChatSessionStore.fetchSessions();
      }
    }

    // 初始化子模块
    UI.init({ elMessages: elMessages, elAnchor: elAnchor, elInput: elInput, elSendBtn: elSendBtn });
    File.init({ elFileStatus: elFileStatus, elFileName: elFileName, elFileInput: elFileInput });
    Cmd.setRemoteMode(remoteMode);
    var cmdDropdown = Cmd.init();
    if (mainInputWrapper && cmdDropdown) mainInputWrapper.appendChild(cmdDropdown);

    // 初始化冰豆（会话指示器）
    if (window.SessionPet) {
      sessionPet = window.SessionPet.create(elStatusBar);
      Pet.init(sessionPet);
      if (window.AppRouter && typeof window.AppRouter.getSupervisorMode === 'function') {
        Pet.syncSupervisorModeEye(window.AppRouter.getSupervisorMode());
      }
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
    WS.on('confirm_resolved', onWsConfirmResolved);
    WS.on('tokenUsage', onWsTokenUsage);
    WS.on('pulse', onWsPulse);
    WS.on('session_updated', onWsSessionUpdated);
    WS.on('workspace_updated', syncSidebarWorkspace);
    WS.on('sync', syncMessages);
    WS.on('bg_task_update', onWsBgTaskUpdate);

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
      Cmd.handleInput(elInput.value, elInput);
    });
    elInput.addEventListener('focus', closeCmdPalette);
    elInput.addEventListener('blur', function () {
      if (cmdPaletteOpen) return;
      if (cmdBlurHideTimer) clearTimeout(cmdBlurHideTimer);
      cmdBlurHideTimer = setTimeout(function () {
        cmdBlurHideTimer = null;
        if (!cmdPaletteOpen) Cmd.hide();
      }, 150);
    });
    if (elCmdPlusBtn) {
      elCmdPlusBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleCmdPalette();
      });
    }
    if (elCmdPalette) {
      elCmdPalette.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeCmdPalette();
          return;
        }
        Cmd.handleKeydown(e, null);
      });
    }
    document.addEventListener('click', function (e) {
      if (!cmdPaletteOpen || !elCmdPalette) return;
      var anchor = elCmdPalette.parentElement;
      if (anchor && anchor.contains(e.target)) return;
      closeCmdPalette();
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

    // F5 后 WS 尚未连上：先用 localStorage 里的 live 工具缓存占位，connected 后以 runningTurn 为准覆盖
    var cachedLiveTools = Session.loadLiveToolBatch ? Session.loadLiveToolBatch() : [];
    if (cachedLiveTools.length > 0) {
      applyLiveToolTimelineToUI(cachedLiveTools);
    }

    // 从配置页等切回时 DOM 已重建，须按 WS 真实 processing 恢复 Stop 钮
    syncSendButtonWithWorkload();

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

  return { render: render, onActivate: onActivate, onSessionSwitched: onSessionSwitched };
})();
