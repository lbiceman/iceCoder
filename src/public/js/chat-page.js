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

  /** run_command 流式 stdout 累积（tool_result 到达后会清空） */
  var streamingDiffBuffer = { toolCallId: '', text: '' };

  function buildDisplayMap(structured) {
    if (!window.ToolDisplayHistory) return {};
    return window.ToolDisplayHistory.buildAgentDisplayMap(
      structured || Session.getStructuredMessages(),
      Session.getMessages(),
      Session.getToolTraces(),
    );
  }

  /** 方案 B：拉 structured messages 并重绘聊天历史（含 diff） */
  function renderChatHistory(shouldScroll, structured) {
    var displayMap = buildDisplayMap(structured);
    UI.renderMessagesOnly(
      Session.getMessages(),
      Session.getToolTraces(),
      Session.stripStatusTag,
      shouldScroll,
      displayMap,
    );
    if (UI.repairMissingDiffMountsFromStructured) {
      UI.repairMissingDiffMountsFromStructured(structured);
    }
    if (UI.followBottomAfterContentPatch) {
      UI.followBottomAfterContentPatch(shouldScroll);
    }
  }

  function renderChatHistoryWithFetch(shouldScroll, done) {
    Session.fetchStructuredMessages(function (structured) {
      renderChatHistory(shouldScroll, structured);
      if (done) done();
    });
  }

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
  var cmdPaletteResizeObserver = null;
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

  function updateTokenUsage(inputTokens, outputTokens, contextOpts) {
    contextOpts = contextOpts || {};
    if (typeof contextOpts.effectiveUsed === 'number' && contextOpts.effectiveUsed > 0) {
      usedInputTokens = contextOpts.effectiveUsed;
    } else {
      usedInputTokens = inputTokens;
    }
    usedOutputTokens = outputTokens;
    if (typeof contextOpts.contextWindow === 'number' && contextOpts.contextWindow > 0) {
      maxContextTokens = contextOpts.contextWindow;
    }
    updatePetTokenUsage();
  }

  function applyTotalTokenUsageFromStep(totalTokenUsage) {
    if (!totalTokenUsage) return;
    updateTokenUsage(
      totalTokenUsage.inputTokens || 0,
      totalTokenUsage.outputTokens || 0,
      {
        effectiveUsed: totalTokenUsage.effectiveUsed,
        contextWindow: totalTokenUsage.contextWindow,
      },
    );
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
    if (window.ChatSessionSidebar && typeof window.ChatSessionSidebar.syncSwitchLockState === 'function') {
      window.ChatSessionSidebar.syncSwitchLockState();
    }
    if (sessionPet && !(Pet.isUserCheckpointActive && Pet.isUserCheckpointActive())) {
      if (busy) {
        sessionPet.setState(isStreaming ? 'read' : 'thinking');
      } else if (
        !userStopped
        && !(Pet.isModelDoneNoticeActive && Pet.isModelDoneNoticeActive())
      ) {
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

  function positionCmdPalette() {
    if (!elCmdPalette || !elCmdPlusBtn) return;
    // 关键：把面板挂到 document.body 顶层 + position: fixed，
    // 完全脱离 chat-main / chat-composer 的 stacking context，
    // 任何高度变化都不会被工具栏行绘制顺序盖住。
    if (elCmdPalette.parentElement !== document.body) {
      document.body.appendChild(elCmdPalette);
    }
    var plusRect = elCmdPlusBtn.getBoundingClientRect();
    var toolbar = elCmdPlusBtn.closest('.composer-toolbar');
    var toolbarRect = toolbar ? toolbar.getBoundingClientRect() : plusRect;
    var margin = 8;
    var panelWidth = Math.min(320, window.innerWidth - 32);
    elCmdPalette.style.position = 'fixed';
    elCmdPalette.style.width = panelWidth + 'px';
    elCmdPalette.style.visibility = 'hidden';
    elCmdPalette.style.left = '0px';
    elCmdPalette.style.top = '0px';
    // 强制回流
    void elCmdPalette.offsetHeight;
    var panelHeight = elCmdPalette.offsetHeight;
    elCmdPalette.style.visibility = '';
    // 面板底端 = 工具栏行顶端之上 margin（不依赖 panelHeight 是否已经包含 dropdown）
    var left = plusRect.right - panelWidth;
    if (left < 8) left = 8;
    if (left + panelWidth > window.innerWidth - 8) {
      left = window.innerWidth - panelWidth - 8;
    }
    var top = toolbarRect.top - panelHeight - margin;
    if (top < 8) top = 8;
    elCmdPalette.style.left = left + 'px';
    elCmdPalette.style.top = top + 'px';
  }

  function startCmdPaletteObserver() {
    if (!elCmdPalette || typeof ResizeObserver === 'undefined') return;
    if (cmdPaletteResizeObserver) cmdPaletteResizeObserver.disconnect();
    cmdPaletteResizeObserver = new ResizeObserver(function () {
      if (cmdPaletteOpen) positionCmdPalette();
    });
    cmdPaletteResizeObserver.observe(elCmdPalette);
  }

  function stopCmdPaletteObserver() {
    if (cmdPaletteResizeObserver) {
      cmdPaletteResizeObserver.disconnect();
      cmdPaletteResizeObserver = null;
    }
  }

  function onCmdPaletteDocClick(e) {
    if (!cmdPaletteOpen || !elCmdPalette || !elCmdPlusBtn) return;
    var t = e.target;
    if (elCmdPalette.contains(t) || elCmdPlusBtn.contains(t)) return;
    closeCmdPalette();
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
    // Cmd.show 会在面板里注入命令列表（panelHeight 此时才撑高）。
    // 必须等 dropdown DOM 落地 + reflow 后再算位置，否则 panelHeight≈0，
    // 面板会跑到按钮下方被 composer-toolbar 行盖住。
    // Cmd 内部用 microtask 同步注入 DOM，但 reflow 要等下一帧——
    // 双 rAF 确保 list DOM 已布局完成。
    requestAnimationFrame(function () {
      positionCmdPalette();
      requestAnimationFrame(positionCmdPalette);
    });
    // 延一帧再绑 doc click，避免本次点击立刻被它关闭
    setTimeout(function () {
      document.addEventListener('mousedown', onCmdPaletteDocClick, true);
    }, 0);
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
      UI.clearLiveToolRoundDom();
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

    var didAppendUserMessage = false;
    if (displayParts.length > 0 || msgImages.length > 0) {
      UI.finalizeBeforeUserMessage(Session.getMessages(), Session.stripStatusTag);
      var userMsg = { role: 'user', content: displayParts.join('\n') || '(图片)', images: msgImages.length > 0 ? msgImages : undefined };
      Session.appendMessage(userMsg);
      UI.appendMessageEl(userMsg, Session.stripStatusTag);
      if (UI.maybeRepartitionTailIfNeeded) {
        UI.maybeRepartitionTailIfNeeded(
          Session.getMessages(),
          Session.getToolTraces(),
          Session.stripStatusTag,
          'force',
          buildDisplayMap(),
        );
      }
      didAppendUserMessage = true;
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

    UI.clearLiveToolRoundDom();
    UI.setLiveToolRoundActive(true);
    if (msgImages.length > 0) {
      WS.send({ type: 'message', content: msgText || '请分析这些图片', images: msgImages });
    } else {
      WS.sendMessage(msgText);
    }
    File.clearPendingImages();

    if (didAppendUserMessage) {
      UI.enableAutoScroll();
    }
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
    UI.clearReasoningStream();
    UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
    if (Session && typeof Session.setSessionId === 'function') {
      Session.setSessionId(sessionId);
    }
    Session.fetchServerMessages(function (serverMsgs) {
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      var separated = Session.separateToolTraces(raw);
      Session.applyServerChatSnapshot(separated, { fullRender: true, authoritative: true }, isStreaming, WS.isProcessing());
      if (shouldSkipServerSnapshotSync()) {
        if (runningTurn && runningTurn.isProcessing) restoreFromRunningTurn(runningTurn);
        return;
      }
      renderChatHistoryWithFetch(false, function () {
        Session.saveMessages();
        UI.enableAutoScroll();
        if (runningTurn && runningTurn.isProcessing) restoreFromRunningTurn(runningTurn);
      });
    });
    resetTokenUsage();
    if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
    if (window.ChatSessionSidebar && typeof window.ChatSessionSidebar.renderList === 'function') {
      window.ChatSessionSidebar.renderList();
    }
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
      UI.appendToolAction(
        row.toolName,
        row.detail || '',
        row.status || 'pending',
        row.toolCallId || '',
        row.diffSource || null,
      );
    }
    if (UI.repairLiveToolGroupFold) UI.repairLiveToolGroupFold();
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
      // 无服务端 runningTurn 时清掉上一会话残留的流式思考 UI
      UI.clearReasoningStream();
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
    if (runningTurn.streamingReasoningText) {
      UI.appendReasoningStreamChunk(runningTurn.streamingReasoningText);
    }
    if (runningTurn.streamingText) {
      UI.appendReasoningStreamChunk(runningTurn.streamingText);
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
    if (typeof runningTurn.lastEffectiveUsed === 'number' && runningTurn.lastEffectiveUsed > 0) {
      updateTokenUsage(
        runningTurn.lastInputTokens || 0,
        runningTurn.lastOutputTokens || 0,
        {
          effectiveUsed: runningTurn.lastEffectiveUsed,
          contextWindow: runningTurn.contextWindow,
        },
      );
    } else if (typeof runningTurn.lastInputTokens === 'number' || typeof runningTurn.lastOutputTokens === 'number') {
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

    UI.scheduleScrollIfSticky();
  }

  function onWsConnected(data) {
    if (!applyModelContextFromWs(data)) {
      fetchModelContext();
    }
    syncSidebarWorkspace(data);
    if (window.ChatSessionStore && typeof window.ChatSessionStore.fetchSessions === 'function') {
      window.ChatSessionStore.fetchSessions();
    }
    // 仅当服务端活跃会话与当前选中一致时才还原 runningTurn，避免 A 的思考串到 B
    var clientSid = Session.getActiveId ? Session.getActiveId() : 'default';
    var serverSid = data && (data.activeSessionId || data.sessionId);
    if (data && serverSid === clientSid) {
      restoreFromRunningTurn(data.runningTurn || null);
    } else if (data && data.runningTurn && data.runningTurn.isProcessing) {
      restoreFromRunningTurn(null);
    }
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

  function onWsReasoningStream(data) {
    if (userStopped) return;
    if (!isStreaming) {
      isStreaming = true;
      UI.setStreamingState(true);
    }
    if (sessionPet) sessionPet.setState('thinking');
    UI.appendReasoningStreamChunk(data.delta || '');
  }

  function onWsStream(data) {
    if (userStopped) return;
    streamChunksReceived = true;
    if (!isStreaming) {
      isStreaming = true;
      UI.setStreamingState(true);
    }
    // Harness 多轮工具任务期间 stream_delta 多为规划/推理，进 Thinking 块而非 Assistant 正文
    if (WS.isProcessing()) {
      if (sessionPet) sessionPet.setState('thinking');
      UI.appendReasoningStreamChunk(data.delta || '');
      return;
    }
    if (sessionPet) sessionPet.setState('read');
    UI.appendStreamChunk(data.delta, Session.getMessages(), Session.stripStatusTag);
  }

  function onWsStreamEnd() {
    if (!userStopped) {
      UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
      if (streamChunksReceived) {
        streamFinalized = true;
        // 任务结束：过程思考仅作流式展示，最终答复由 refresh / response 写入 Assistant
        UI.clearReasoningStream();
      }
    }
    streamChunksReceived = false;
    isStreaming = false;
    UI.setStreamingState(false);
  }

  function scheduleRefreshAfterTurn() {
    setTimeout(function () {
      if (!shouldSkipServerSnapshotSync()) {
        refreshChatHistoryAfterTurn('force');
      }
    }, 50);
  }

  function onWsResponse(data) {
    if (userStopped) {
      userStopped = false;
      return;
    }
    if (streamFinalized) {
      streamFinalized = false;
      scheduleRefreshAfterTurn();
      return;
    }
    UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
    UI.clearReasoningStream();
    var msg = { role: 'agent', content: Session.stripStatusTag(data.content || '') };
    Session.appendMessage(msg);
    Session.flushToolBatchLocal();
    UI.appendMessageEl(msg, Session.stripStatusTag);
    Session.saveMessages();
    UI.enableAutoScroll();
    scheduleRefreshAfterTurn();
  }

  function onWsStep(data) {
    var step = data.step;
    if (!step) return;

    // P3 — 用户已点 Stop：后端 harness 还在收尾（写 checkpoint / drain memory）期间会继续推
    // step / stream_delta，UI 不再据此切冰豆状态，否则会出现「按钮变 Send 了但冰豆还在动」。
    // userStopped 会在 status:idle 或下一次 sendMessage 时被清掉。
    if (userStopped) return;

    if (step.totalTokenUsage) {
      applyTotalTokenUsageFromStep(step.totalTokenUsage);
    }
    if (step.iteration) {
      Pet.updateTurnCounter(step.iteration, isStreaming, WS.isProcessing());
    }
    if (step.type === 'tool_progress' && step.content) {
      Pet.setLastToolProgressHint(step.content);
      WS.setLastToolProgressHint(step.content);
      Pet.updateStatusText(step.content, isStreaming, WS.isProcessing());
    }
    if (step.type === 'thinking') {
      UI.promoteAssistantBubbleToThinking(Session.stripStatusTag);
      if (step.content) {
        UI.appendReasoningStreamIfAbsent(Session.stripStatusTag(step.content));
      }
      var msgsThink = Session.getMessages();
      for (var mti = msgsThink.length - 1; mti >= 0; mti--) {
        if (msgsThink[mti].role === 'agent' && msgsThink[mti]._streaming) {
          msgsThink.splice(mti, 1);
          break;
        }
      }
    }
    if (step.type === 'tool_call') {
      UI.promoteAssistantBubbleToThinking(Session.stripStatusTag);
      var msgs = Session.getMessages();
      for (var mi = msgs.length - 1; mi >= 0; mi--) {
        if (msgs[mi].role === 'agent' && msgs[mi]._streaming) {
          msgs.splice(mi, 1);
          break;
        }
      }
    }
    if (step.type === 'tool_call' && step.toolName) {
      if (WS.isProcessing() && UI.isLiveToolRoundActive && !UI.isLiveToolRoundActive()) {
        UI.setLiveToolRoundActive(true);
      }
      var fmt = window.ToolTraceFormat;
      var detail = fmt
        ? fmt.formatToolArgsDetailPreview(step.toolName, step.toolArgs)
        : (step.toolArgs && (step.toolArgs.path || step.toolArgs.file || step.toolArgs.command || step.toolArgs.query)) || '';
      if (!detail && step.toolArgs) {
        var argsStr = JSON.stringify(step.toolArgs);
        detail = argsStr.length > 80 ? argsStr.substring(0, 80) + '…' : argsStr;
      }
      var callStatus = fmt && fmt.resolveToolCallInitialStatus
        ? fmt.resolveToolCallInitialStatus(step.toolName, step.toolArgs)
        : 'pending';
      var toolCallId = step.toolCallId || '';
      var diffFromArgs = (window.ToolDisplayHistory && step.toolArgs)
        ? window.ToolDisplayHistory.extractDiffSource(step.toolName, null, step.toolArgs)
        : null;
      UI.appendToolAction(step.toolName, detail, callStatus, toolCallId, diffFromArgs);
      Session.pushToolBatch({
        toolName: step.toolName,
        detail: detail,
        status: callStatus,
        toolCallId: toolCallId,
      });
      if (toolCallId) {
        streamingDiffBuffer = { toolCallId: toolCallId, text: '' };
      }
    }
    if (step.type === 'tool_result' && step.toolName) {
      var fmtResult = window.ToolTraceFormat;
      var resultStatus = fmtResult
        ? fmtResult.resolveToolTraceResultStatus(
          step.toolName,
          step.toolSuccess,
          step.toolOutcome,
          step.toolOutput,
        )
        : (step.toolOutcome === 'policy_block'
          ? 'warn'
          : (step.toolSuccess ? 'success' : 'error'));
      UI.updateToolActionByCallId(step.toolCallId || '', step.toolName, resultStatus);
      Session.updateToolBatchStatus(step.toolName, resultStatus, step.toolCallId || '');
      if (fmtResult && step.toolName === 'run_command' && window.BgTaskChip && elMessages) {
        var checkInfo = fmtResult.parseCheckTaskResult(step.toolOutput);
        if (checkInfo && fmtResult.isTerminalBackgroundStatus(checkInfo.status)) {
          window.BgTaskChip.markConfirmedViaCheck(elMessages, checkInfo.taskId);
        }
      }
      if (window.ToolDisplayHistory) {
        var diffSource = window.ToolDisplayHistory.extractDiffSource(
          step.toolName,
          step.toolOutput,
          step.toolArgs,
        );
        if (!diffSource && window.DiffViewer && step.toolOutput) {
          diffSource = DiffViewer.extractUnifiedDiff(step.toolOutput);
        }
        tryMountToolDiff(step.toolCallId || '', diffSource);
      }
      streamingDiffBuffer = { toolCallId: '', text: '' };
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
      // 用户主动 Stop 后 handleStop 已更新本地消息/DOM；idle 时再 authoritative 拉服务端
      // 快照可能拿到空数组（会话文件读写竞态 / sessionId 未对齐），会把整页聊天记录清掉。
      var skipRefreshAfterUserStop = userStopped;
      if (userStopped) userStopped = false;
      isStreaming = false;
      Pet.removeThinking(isStreaming, WS.isProcessing());
      if (Session.clearLiveToolBatch) Session.clearLiveToolBatch();
      if (UI.repairLiveToolGroupFold) UI.repairLiveToolGroupFold();
      // turn_complete 时 session_updated 可能仍在 processing 中被跳过；idle 时强制从 structured 重绘 diff
      if (!skipRefreshAfterUserStop) {
        refreshChatHistoryAfterTurn('force');
      }
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

    Modal.confirm({
      title: '危险操作确认',
      message: '工具: ' + data.toolName + '\n参数: ' + argsText,
      type: 'danger',
      dangerConfirm: true,
      confirmText: '允许',
      cancelText: '拒绝',
    }).then(function (ok) {
      if (activeConfirmResolved) {
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
    });
  }

  function onWsConfirmResolved(data) {
    if (!data) return;
    // 标记本地弹窗的回复已被服务端 first-win
    if (!activeConfirmId || data.confirmId === activeConfirmId) {
      activeConfirmResolved = true;
    }
  }

  function onWsTokenUsage(data) {
    updateTokenUsage(data.inputTokens || 0, data.outputTokens || 0, {
      effectiveUsed: data.effectiveUsed,
      contextWindow: data.contextWindow,
    });
  }

  function onWsPulse(data) {
    if (!sessionPet) return;
    var hint = data && data.hint ? data.hint : '处理中';
    Pet.updateStatusText(hint, isStreaming, WS.isProcessing());
  }

  function shouldSkipServerSnapshotSync() {
    return WS.isProcessing() || isStreaming || Session.hasStreamingModelBubble();
  }

  function refreshChatHistoryAfterTurn(shouldScroll, done) {
    if (shouldSkipServerSnapshotSync()) {
      if (done) done();
      return;
    }
    if (Session.invalidateStructuredCache) Session.invalidateStructuredCache();
    Session.fetchServerMessages(function (serverMsgs) {
      if (shouldSkipServerSnapshotSync()) {
        if (done) done();
        return;
      }
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      var separated = Session.separateToolTraces(raw);
      Session.applyServerChatSnapshot(
        separated,
        { fullRender: false, authoritative: true },
        isStreaming,
        WS.isProcessing(),
      );
      renderChatHistoryWithFetch(shouldScroll, function () {
        Session.saveMessages();
        if (done) done();
      });
    });
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
        renderChatHistoryWithFetch(false);
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
        renderChatHistoryWithFetch(false);
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
    if (data && data.reason === 'turn_complete') {
      if (!shouldSkipServerSnapshotSync()) {
        refreshChatHistoryAfterTurn('force');
      }
      return;
    }
    if (!data || !data.title) {
      pullServerChatSnapshotAuthoritative();
    }
  }

  function onWsBgTaskStopResult(payload) {
    if (!window.BgTaskChip || !payload || payload.ok) return;
    if (window.BgTaskChip.resetStopPending && payload.taskId) {
      window.BgTaskChip.resetStopPending(payload.taskId);
    }
  }

  function onWsBgTaskUpdate(payload) {
    if (!window.BgTaskChip || !elMessages) return;
    var activeId = (Session && typeof Session.getActiveId === 'function')
      ? Session.getActiveId()
      : '';
    window.BgTaskChip.handleUpdate(elMessages, payload, activeId);
    UI.scheduleScrollIfSticky();
  }

  function tryMountToolDiff(toolCallId, diffSource) {
    if (!toolCallId || !diffSource || !UI.mountDiffForToolCallId) return;
    UI.mountDiffForToolCallId(toolCallId, diffSource);
  }

  /** run_command 流式输出：按 toolCallId 累积并实时预览 */
  function onWsToolOutput(data) {
    if (!data || !data.content || !data.toolCallId) return;
    if (streamingDiffBuffer.toolCallId && streamingDiffBuffer.toolCallId !== data.toolCallId) {
      streamingDiffBuffer = { toolCallId: data.toolCallId, text: '' };
    }
    if (!streamingDiffBuffer.toolCallId) streamingDiffBuffer.toolCallId = data.toolCallId;
    streamingDiffBuffer.text += data.content;
    var diffSource = null;
    if (window.DiffViewer && typeof DiffViewer.extractUnifiedDiff === 'function') {
      diffSource = DiffViewer.extractUnifiedDiff(streamingDiffBuffer.text);
    } else if (window.DiffViewer && typeof DiffViewer.looksLikeUnifiedDiffText === 'function') {
      if (!DiffViewer.looksLikeUnifiedDiffText(streamingDiffBuffer.text)) return;
      diffSource = streamingDiffBuffer.text;
    } else if (!/^@@\s/m.test(streamingDiffBuffer.text) && !/^diff --git /m.test(streamingDiffBuffer.text)) {
      return;
    } else {
      diffSource = streamingDiffBuffer.text;
    }
    if (!diffSource) return;
    tryMountToolDiff(streamingDiffBuffer.toolCallId, diffSource);
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
          '<div class="chat-composer">' +
            '<div class="composer-input">' +
              '<div class="input-wrapper">' +
                '<textarea id="chat-input" rows="1" placeholder="输入指令… (输入 ~ 查看命令)"></textarea>' +
              '</div>' +
            '</div>' +
            '<div class="composer-toolbar">' +
              '<button class="btn-icon btn-icon-ghost" id="btn-file" title="Upload file" aria-label="Upload file">' +
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
              '</button>' +
              '<button class="chip chip-select" id="chip-model" type="button" aria-label="选择模型">' +
                '<span class="chip-label">GPT-5.3-Codex</span>' +
              '</button>' +
              '<button class="btn-send" id="btn-send" title="Send" aria-label="Send">' +
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 12 12 6 18 12"/><line x1="12" y1="6" x2="12" y2="20"/></svg>' +
              '</button>' +
              '<div class="cmd-palette-anchor">' +
                '<button class="btn-icon btn-cmd-plus" id="btn-cmd-plus" type="button" title="命令" aria-label="命令">' +
                  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                    '<line x1="4" y1="6" x2="14" y2="6"/>' +
                    '<line x1="4" y1="12" x2="20" y2="12"/>' +
                    '<line x1="4" y1="18" x2="10" y2="18"/>' +
                    '<circle cx="16" cy="6" r="1.6" fill="currentColor" stroke="none"/>' +
                    '<circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none"/>' +
                    '<circle cx="14" cy="18" r="1.6" fill="currentColor" stroke="none"/>' +
                  '</svg>' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="cmd-palette hidden" id="cmd-palette" tabindex="-1" role="menu" aria-label="命令列表"></div>' +
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
      if (window.DesktopPetBridge && typeof window.DesktopPetBridge.attach === 'function') {
        window.DesktopPetBridge.attach(sessionPet);
      }
      if (window.AppRouter && typeof window.AppRouter.getSupervisorMode === 'function') {
        Pet.syncSupervisorModeEye(window.AppRouter.getSupervisorMode());
      }
    }

    // 初始化会话：先从 localStorage 载入（本地页与远程页都需要内存里有消息再绘制）
    Session.initSession();

    fetchSupportedFormats();

    if (window.BgTaskChip && window.BgTaskChip.setStopHandler) {
      window.BgTaskChip.setStopHandler(function (taskId) {
        if (!WS.isConnected || !WS.isConnected()) return;
        WS.send({ type: 'bg_task_stop', taskId: taskId });
      });
    }

    // 绑定 WebSocket 事件
    WS.on('open', onWsOpen);
    WS.on('connected', onWsConnected);
    WS.on('close', onWsClose);
    WS.on('stream', onWsStream);
    WS.on('reasoning_stream', onWsReasoningStream);
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
    WS.on('bg_task_stop_result', onWsBgTaskStopResult);
    WS.on('tool_output', onWsToolOutput);

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

    function paintInitialChatView() {
      function afterHistoryPainted() {
        var cachedLiveTools = Session.loadLiveToolBatch ? Session.loadLiveToolBatch() : [];
        if (cachedLiveTools.length > 0) {
          applyLiveToolTimelineToUI(cachedLiveTools);
        }
        UI.enableAutoScroll();
        syncSendButtonWithWorkload();
      }
      // 先拉服务端会话（含 tool_trace），再 fetch structured 重绘，避免 F5 后工具行无 diff
      Session.fetchServerMessages(function (serverMsgs) {
        var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
        if (raw.length > 0) {
          var separated = Session.separateToolTraces(raw);
          Session.applyServerChatSnapshot(
            separated,
            { fullRender: false, authoritative: true },
            isStreaming,
            WS.isProcessing(),
          );
        }
        renderChatHistoryWithFetch(false, afterHistoryPainted);
      });
    }

    if (!remoteMode && window.ChatSessionStore && typeof window.ChatSessionStore.bootstrapInitialSession === 'function') {
      window.ChatSessionStore.bootstrapInitialSession(function () {
        paintInitialChatView();
      });
    } else {
      paintInitialChatView();
    }

    if (remoteMode) {
      Session.fetchServerMessages(function (serverMsgs) {
        var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
        var separated = Session.separateToolTraces(raw);
        if (Session.applyServerChatSnapshot(separated, { fullRender: false, authoritative: true }, isStreaming, WS.isProcessing())) {
          renderChatHistoryWithFetch(false);
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

  return {
    render: render,
    onActivate: onActivate,
    onSessionSwitched: onSessionSwitched,
    isWorkloadActive: isWorkloadActive,
  };
})();
