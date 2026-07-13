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
  var Skills = window.ChatSkills;
  var FileRef = window.ChatFileRef;
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
  /** 本轮是否已有可见正文流写入 Assistant 气泡；仅 Thinking 流不算。 */
  var visibleStreamChunksReceived = false;
  /** tokenUsage 早于 agent 消息到达时的暂存 */
  var pendingTurnTokenUsage = null;
  var remoteMode = false;
  var remoteToken = null;
  /** 本页仅提示一次 MCP 就绪（含 WS 晚连时 connected.mcpReady 补发） */
  var mcpReadyAnnounced = false;
  /** 本页仅提示一次公网隧道就绪 */
  var tunnelReadyAnnounced = false;
  var lastWsConnectedFetchMs = 0;
  var lastActivateFetchMs = 0;
  var lastSyncMessagesMs = 0;
  var initialHistoryPainted = false;
  var pendingInitialPaint = false;

  function isMobileShell() {
    try {
      return document.documentElement.getAttribute('data-shell') === 'mobile';
    } catch (_e) {
      return false;
    }
  }

  function getWsConnectedFetchGapMs() {
    return isMobileShell() ? 8000 : 4000;
  }

  function getActivateFetchGapMs() {
    return isMobileShell() ? 20000 : 10000;
  }

  function shouldSkipWsConnectedHeavyFetch() {
    if (!initialHistoryPainted) return false;
    var now = Date.now();
    if (now - lastWsConnectedFetchMs < getWsConnectedFetchGapMs()) return true;
    lastWsConnectedFetchMs = now;
    return false;
  }

  function needsInitialHistoryPaint() {
    if (!initialHistoryPainted) return true;
    if (Session && typeof Session.getMessages === 'function') {
      return Session.getMessages().length === 0;
    }
    return false;
  }

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
    if (window.ChatStaircaseNav && typeof window.ChatStaircaseNav.refresh === 'function') {
      window.ChatStaircaseNav.refresh();
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
  var elFileStatus;
  var elStatusBar, elStatusTurn;
  var elCmdPlusBtn, mainInputWrapper;
  var cmdPaletteResizeObserver = null;
  var sessionPet = null;

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

  // 拉取一次即可覆盖两件事：
  //   1) Token 用量（maxContextTokens / modelName → 冰豆）
  //   2) 底部 #chip-model-label 显示当前默认 provider 的 modelName
  // 失败时也要回填 chip，避免一直停在"加载中…"
  function loadModelConfig() {
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
        if (window.ChatModelPicker && window.ChatModelPicker.setProviders) {
          window.ChatModelPicker.setProviders(providers);
        }
        updateChipModelLabel(providers);
        syncWelcomeState();
      })
      .catch(function () {
        if (window.ChatModelPicker && window.ChatModelPicker.setProviders) {
          window.ChatModelPicker.setProviders([]);
        }
        updateChipModelLabel(null);
      });
  }

  // 没有 provider 或请求失败时回退到"未配置"
  // DOM 还没渲染好时（chat 页面异步插入 chip-model-label）轮询重试，避免卡在"加载中…"
  function updateChipModelLabel(providers) {
    function apply() {
      var el = document.getElementById('chip-model-label');
      if (!el) return false;
      if (!providers || !providers.length) {
        el.textContent = '未配置';
        return true;
      }
      var def = providers.find(function (p) { return p.isDefault; }) || providers[0];
      el.textContent = def && def.modelName ? def.modelName : '未配置';
      return true;
    }
    if (apply()) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (apply() || tries >= 10) clearInterval(timer);
    }, 50);
  }

  // 从 WS 初始连接 payload 同步 chip（避免再走一次 fetch）
  // 兼容两种结构：data.providers (数组) 或 data.modelName (单值)
  function syncChipModelLabelFromWs(data) {
    var providers = null;
    if (data && data.providers && data.providers.length) {
      providers = data.providers;
    } else if (data && data.modelName) {
      providers = [{ isDefault: true, modelName: data.modelName }];
    }
    updateChipModelLabel(providers);
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
    syncWelcomeState();
  }

  function syncWelcomeState() {
    if (!window.ChatWelcome || typeof window.ChatWelcome.sync !== 'function') return;
    var tail = elMessages && elMessages.querySelector ? elMessages.querySelector('.chat-tail-root') : null;
    // tail 内始终保留 .chat-tail-anchor 占位，仅统计其前的真实消息/流式块
    var hasTailContent = !!(tail && tail.firstChild !== tail.lastChild);
    window.ChatWelcome.sync({
      messageCount: Session.getMessages().length,
      hasTailContent: hasTailContent,
      isWorkloadActive: isWorkloadActive(),
      supervisorMode: window.AppRouter && typeof window.AppRouter.getSupervisorMode === 'function'
        ? window.AppRouter.getSupervisorMode()
        : 'adaptive',
      connectionState: window.AppShell && typeof window.AppShell.getConnectionState === 'function'
        ? window.AppShell.getConnectionState()
        : 'disconnected',
      setupRequired: window.AppRouter && typeof window.AppRouter.isSetupRequired === 'function'
        ? window.AppRouter.isSetupRequired()
        : false,
      remoteMode: remoteMode,
    });
    if (window.MobileWorkPage && typeof window.MobileWorkPage.syncChatActivity === 'function') {
      window.MobileWorkPage.syncChatActivity();
    }
  }

  /** 后端仍在跑 / 本地流式未结束 → 发送钮应显示为 Stop */
  function isWorkloadActive() {
    return WS.isProcessing()
      || isStreaming
      || (Session && typeof Session.hasStreamingModelBubble === 'function' && Session.hasStreamingModelBubble());
  }

  /** 输入框是否有可发送内容（含附件 / file ref / skill ref） */
  function getComposerHasSendableContent() {
    if (getComposerText().trim()) return true;
    if (File.getUploadedFiles().length > 0) return true;
    if (File.getPendingImages().length > 0) return true;
    return false;
  }

  function syncComposerActionState() {
    var busy = isWorkloadActive();
    if (!busy || getComposerHasSendableContent()) {
      UI.setComposerAction('send');
    } else {
      UI.setComposerAction('stop');
    }
    if (window.ChatSessionSidebar && typeof window.ChatSessionSidebar.syncSwitchLockState === 'function') {
      window.ChatSessionSidebar.syncSwitchLockState();
    }
    if (window.MobileSessionDrawer && typeof window.MobileSessionDrawer.syncSwitchLockState === 'function') {
      window.MobileSessionDrawer.syncSwitchLockState();
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
    syncWelcomeState();
  }

  /** 切回聊天页或 WS 状态变化后，把发送钮与真实 workload 对齐（DOM 重建不会保留 btn-stop） */
  function syncSendButtonWithWorkload() {
    syncComposerActionState();
  }

  function getComposerBody() {
    return (elInput && elInput.value != null ? elInput.value : '').replace(/\u00A0/g, ' ').trim();
  }

  function buildComposerTextWithBody(taskBody) {
    var lines = [];
    if (Skills && typeof Skills.getSelectedRefs === 'function') {
      var skillRefs = Skills.getSelectedRefs();
      if (skillRefs.length) lines.push(skillRefs.join(' '));
    }
    if (FileRef && typeof FileRef.getSelectedRefs === 'function') {
      var fileRefs = FileRef.getSelectedRefs();
      for (var fi = 0; fi < fileRefs.length; fi++) {
        lines.push(fileRefs[fi]);
      }
    }
    var trimmed = (taskBody || '').trim();
    if (trimmed) lines.push(trimmed);
    return lines.join('\n');
  }

  function parseExplicitNextBody(body) {
    body = (body || '').trim();
    if (body.indexOf('/next') !== 0) return null;
    return body.slice('/next'.length).trim();
  }

  function handleAlsoCommand(body) {
    body = (body || '').trim();
    if (body.indexOf('/also') !== 0) return false;
    var noteText = body.slice('/also'.length).trim();
    var sid = Session.getActiveId();
    fetch('/api/sessions/' + encodeURIComponent(sid) + '/also', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: noteText }),
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        var content = (body && body.message) ? body.message : '用法: /also <补充说明>';
        var infoMsg = { role: 'agent', content: content, statusTag: 'system' };
        if (window.ChatSession && typeof window.ChatSession.stampMessageTimestamps === 'function') {
          window.ChatSession.stampMessageTimestamps(infoMsg);
        }
        Session.appendMessage(infoMsg);
        UI.appendMessageEl(infoMsg, Session.stripStatusTag);
        Session.saveMessages();
      })
      .catch(function () {
        var errMsg = { role: 'agent', content: '备注设置失败', statusTag: 'system' };
        Session.appendMessage(errMsg);
        UI.appendMessageEl(errMsg, Session.stripStatusTag);
        Session.saveMessages();
      });
    return true;
  }

  // ---- 命令面板（+ 按钮）：浮层已统一为 ChatDropdown ----
  function openCmdPalette() {
    if (!elCmdPlusBtn) return;
    Cmd.hide();
    Cmd.setApplyTarget(function (value) {
      executeLocalCommand(value);
      Cmd.hide();
    });
    Cmd.show('~', '');
  }

  function toggleCmdPalette() {
    if (Cmd.isTildeOpen && Cmd.isTildeOpen()) Cmd.hide();
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
  function getComposerText() {
    var lines = [];
    if (Skills && typeof Skills.getSelectedRefs === 'function') {
      var skillRefs = Skills.getSelectedRefs();
      if (skillRefs.length) lines.push(skillRefs.join(' '));
    }
    if (FileRef && typeof FileRef.getSelectedRefs === 'function') {
      var fileRefs = FileRef.getSelectedRefs();
      for (var fi = 0; fi < fileRefs.length; fi++) {
        lines.push(fileRefs[fi]);
      }
    }
    var body = (elInput && elInput.value != null ? elInput.value : '').replace(/\u00A0/g, ' ').trim();
    if (body) lines.push(body);
    return lines.join('\n');
  }

  function clearComposerInput() {
    if (Skills && typeof Skills.clearInput === 'function') Skills.clearInput(elInput);
    else if (elInput) elInput.value = '';
    if (FileRef && typeof FileRef.clearInput === 'function') FileRef.clearInput(elInput);
    UI.autoResizeInput();
  }

  function handleSend() {
    Cmd.hide();
    if (Skills) Skills.hide();
    if (FileRef) FileRef.hide();

    var composerBody = getComposerBody();
    var fullText = getComposerText().trim();
    var referencePaths = [];
    if (FileRef && typeof FileRef.getSelectedRefs === 'function') {
      referencePaths = FileRef.getSelectedRefs();
    }
    var uploadedFiles = File.getUploadedFiles();
    var pendingImages = File.getPendingImages();
    var explicitNextBody = parseExplicitNextBody(composerBody);
    var isExplicitNext = explicitNextBody !== null;
    var busyAtSend = isWorkloadActive();
    var appendUserMessageNow = !isExplicitNext && !busyAtSend;

    if (handleAlsoCommand(composerBody)) {
      clearComposerInput();
      syncComposerActionState();
      return;
    }

    if (executeLocalCommand(composerBody)) {
      clearComposerInput();
      syncComposerActionState();
      return;
    }

    if (
      elSendBtn
      && elSendBtn.dataset.action === 'stop'
      && !isExplicitNext
      && !composerBody
      && !fullText
      && uploadedFiles.length === 0
      && pendingImages.length === 0
    ) {
      handleStop();
      return;
    }

    if (File.hasPendingUploads && File.hasPendingUploads()) return;
    if (File.hasPendingImageLoads && File.hasPendingImageLoads()) return;
    if (!composerBody && !fullText && uploadedFiles.length === 0 && pendingImages.length === 0) return;

    if (
      window.AppRouter &&
      typeof window.AppRouter.getShell === 'function' &&
      window.AppRouter.getShell() === 'mobile' &&
      document.body.dataset.page === 'work' &&
      !remoteMode &&
      window.MobileComposerHost &&
      typeof window.MobileComposerHost.handleWorkPageSend === 'function'
    ) {
      if (window.MobileComposerHost.handleWorkPageSend()) return;
    }

    var outboundText = isExplicitNext ? buildComposerTextWithBody(explicitNextBody) : fullText;
    if (isExplicitNext && !explicitNextBody && uploadedFiles.length === 0 && pendingImages.length === 0) {
      var usageMsg = { role: 'agent', content: '用法: /next <任务描述>', statusTag: 'system' };
      if (window.ChatSession && typeof window.ChatSession.stampMessageTimestamps === 'function') {
        window.ChatSession.stampMessageTimestamps(usageMsg);
      }
      Session.appendMessage(usageMsg);
      UI.appendMessageEl(usageMsg, Session.stripStatusTag);
      Session.saveMessages();
      clearComposerInput();
      syncComposerActionState();
      return;
    }

    var displayParts = [];
    if (appendUserMessageNow && composerBody) displayParts.push(composerBody);
    for (var fi = 0; fi < uploadedFiles.length; fi++) {
      if (appendUserMessageNow) displayParts.push('[file] ' + uploadedFiles[fi].filename);
    }
    var msgImages = pendingImages.map(function (p) { return p.dataUrl; });

    var didAppendUserMessage = false;
    if (appendUserMessageNow && (displayParts.length > 0 || msgImages.length > 0)) {
      UI.finalizeBeforeUserMessage(Session.getMessages(), Session.stripStatusTag);
      var userMessageId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : ('msg-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      var userMsg = {
        role: 'user',
        id: userMessageId,
        content: displayParts.join('\n') || '(图片)',
        images: msgImages.length > 0 ? msgImages : undefined,
      };
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
      syncWelcomeState();
      var titlePrompt = displayParts.join('\n') || composerBody || fullText || '';
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

    clearComposerInput();
    Cmd.hide();

    var msgText = outboundText || '';
    for (var fj = 0; fj < uploadedFiles.length; fj++) {
      var uf = uploadedFiles[fj];
      msgText = (msgText ? msgText + '\n' : '') + '[file:' + uf.fileId + '] ' + uf.filename;
    }
    File.clearUploadedFiles();

    if (appendUserMessageNow) {
      userStopped = false;
      streamFinalized = false;
      streamChunksReceived = false;
      visibleStreamChunksReceived = false;
      pendingTurnTokenUsage = null;
      Pet.showThinking(uploadedFiles.length > 0 || msgImages.length > 0);
      UI.clearLiveToolRoundDom();
      UI.setLiveToolRoundActive(true);
    }
    var outboundMessageId = didAppendUserMessage && Session.getLastMessage()
      ? Session.getLastMessage().id
      : undefined;
    var sendOpts = { referencePaths: referencePaths };
    if (outboundMessageId) sendOpts.messageId = outboundMessageId;
    if (isExplicitNext) {
      sendOpts.source = 'explicit';
      sendOpts.command = 'next';
    }
    if (window.ChatTaskQueue && typeof window.ChatTaskQueue.getEditingInsertIndex === 'function') {
      var insertIndex = window.ChatTaskQueue.getEditingInsertIndex();
      if (typeof insertIndex === 'number') {
        sendOpts.queueInsertIndex = insertIndex;
        window.ChatTaskQueue.clearEditingInsertIndex();
      }
    }
    if (msgImages.length > 0) {
      sendOpts.images = msgImages;
      WS.sendMessage(msgText || '请分析这些图片', sendOpts);
    } else {
      WS.sendMessage(msgText, sendOpts);
    }
    File.clearPendingImages();

    if (didAppendUserMessage) {
      UI.enableAutoScroll();
    }
    syncComposerActionState();
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
      if (lastMsg.completedAt == null) lastMsg.completedAt = Date.now();

      var streamEl = document.getElementById('streaming-msg');
      if (streamEl) {
        var contentEl = streamEl._streamContentEl || streamEl.lastChild;
        if (contentEl) contentEl.textContent = lastMsg.content;
        if (UI.updateMsgLabelTime) UI.updateMsgLabelTime(streamEl, lastMsg.completedAt);
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
    visibleStreamChunksReceived = false;
    UI.setStreamingState(false);
    WS.setProcessing(false);
    Session.saveMessages();
    syncComposerActionState();
  }

  function onWsTaskQueueUpdated(data) {
    if (!window.ChatTaskQueue || typeof window.ChatTaskQueue.setItems !== 'function') return;
    if (data && data.sessionId && data.sessionId !== Session.getActiveId()) return;
    window.ChatTaskQueue.setItems(data && data.items ? data.items : []);
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
    if (FileRef && typeof FileRef.clearInput === 'function') {
      FileRef.clearInput(elInput);
    }
    if (Session && typeof Session.setSessionId === 'function') {
      Session.setSessionId(sessionId);
    }
    Session.fetchServerMessages(function (serverMsgs) {
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      var separated = Session.separateToolTraces(raw);
      Session.applyServerChatSnapshot(separated, { fullRender: true, authoritative: true }, isStreaming, WS.isProcessing());
      if (shouldSkipServerSnapshotSync()) {
        mergeAndPaintRemoteUserMessages(raw);
        if (runningTurn && runningTurn.isProcessing) restoreFromRunningTurn(runningTurn);
        initialHistoryPainted = true;
        pendingInitialPaint = false;
        return;
      }
      renderChatHistoryWithFetch(false, function () {
        Session.saveMessages();
        UI.enableAutoScroll();
        initialHistoryPainted = true;
        pendingInitialPaint = false;
        if (runningTurn && runningTurn.isProcessing) restoreFromRunningTurn(runningTurn);
      });
    });
    resetTokenUsage();
    if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
    if (window.ChatTaskQueue && typeof window.ChatTaskQueue.refresh === 'function') {
      window.ChatTaskQueue.refresh(sessionId);
    }
    if (window.ChatSessionSidebar && typeof window.ChatSessionSidebar.renderList === 'function') {
      window.ChatSessionSidebar.renderList();
    }
  }

  function paintInitialChatView() {
    function afterHistoryPainted() {
      initialHistoryPainted = true;
      pendingInitialPaint = false;
      var cachedLiveTools = Session.loadLiveToolBatch ? Session.loadLiveToolBatch() : [];
      if (cachedLiveTools.length > 0) {
        applyLiveToolTimelineToUI(cachedLiveTools);
      }
      UI.enableAutoScroll();
      syncSendButtonWithWorkload();
    }
    Session.fetchServerMessages(function (serverMsgs) {
      var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
      if (shouldSkipServerSnapshotSync()) {
        mergeAndPaintRemoteUserMessages(raw);
        afterHistoryPainted();
        return;
      }
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

  function syncActiveSessionFromServer(data) {
    if (!data) return false;
    var serverId = data.activeSessionId || data.sessionId;
    if (!serverId) return false;
    var clientId = Session.getActiveId ? Session.getActiveId() : 'default';
    if (window.ChatSessionStore && typeof window.ChatSessionStore.setActiveSessionId === 'function') {
      window.ChatSessionStore.setActiveSessionId(serverId);
    }
    if (serverId !== clientId) {
      pendingInitialPaint = false;
      onSessionSwitched(serverId, data.runningTurn || null);
      return true;
    }
    if (remoteMode && pendingInitialPaint && !initialHistoryPainted) {
      pendingInitialPaint = false;
      paintInitialChatView();
      return true;
    }
    return false;
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
      visibleStreamChunksReceived = false;
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
    visibleStreamChunksReceived = false;
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
    var skipHeavyFetch = shouldSkipWsConnectedHeavyFetch();
    var paintedFromSessionSync = syncActiveSessionFromServer(data || {});
    if (!applyModelContextFromWs(data)) {
      if (!skipHeavyFetch) loadModelConfig();
    } else if (data && (data.providers || data.modelName)) {
      syncChipModelLabelFromWs(data);
    } else if (!skipHeavyFetch) {
      loadModelConfig();
    }
    syncSidebarWorkspace(data);
    if (!skipHeavyFetch && window.ChatSessionStore && typeof window.ChatSessionStore.fetchSessions === 'function') {
      window.ChatSessionStore.fetchSessions();
    }
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
    if (typeof data.canRestore === 'boolean') {
      applyHarnessRestoreUi(data.canRestore, data.checkpointMessageIds);
    }
    if (window.ChatExecutionPlanBridge && typeof window.ChatExecutionPlanBridge.notifyConnected === 'function') {
      if (!skipHeavyFetch) {
        window.ChatExecutionPlanBridge.notifyConnected(data || {});
      }
    }
    if (paintedFromSessionSync) return;
    var rt = data && data.runningTurn;
    if ((!rt || !rt.isProcessing) && !skipHeavyFetch) {
      syncMessages(needsInitialHistoryPaint());
    } else if (needsInitialHistoryPaint()) {
      syncMessages(true);
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
    syncWelcomeState();
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
      syncWelcomeState();
      return;
    }
    visibleStreamChunksReceived = true;
    if (sessionPet) sessionPet.setState('read');
    UI.appendStreamChunk(data.delta, Session.getMessages(), Session.stripStatusTag);
    syncWelcomeState();
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
    syncWelcomeState();
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
    if (streamFinalized && visibleStreamChunksReceived) {
      streamFinalized = false;
      visibleStreamChunksReceived = false;
      scheduleRefreshAfterTurn();
      return;
    }
    streamFinalized = false;
    visibleStreamChunksReceived = false;
    UI.finalizeStreamResponse(Session.getMessages(), Session.stripStatusTag);
    UI.clearReasoningStream();
    var msg = { role: 'agent', content: Session.stripStatusTag(data.content || '') };
    Session.appendMessage(msg);
    if (pendingTurnTokenUsage) {
      if (pendingTurnTokenUsage.messageId && !msg.id) {
        msg.id = pendingTurnTokenUsage.messageId;
      }
      msg.turnTokenUsage = pendingTurnTokenUsage.usage || pendingTurnTokenUsage;
      pendingTurnTokenUsage = null;
    }
    Session.flushToolBatchLocal();
    UI.appendMessageEl(msg, Session.stripStatusTag);
    if (msg.turnTokenUsage && UI.updateMessageTokenUsage) {
      UI.updateMessageTokenUsage(msg);
    }
    Session.saveMessages();
    UI.enableAutoScroll();
    syncWelcomeState();
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
      var noticeMsg = { role: 'agent', content: notices[i] };
      if (Session.stampMessageTimestamps) Session.stampMessageTimestamps(noticeMsg);
      messages.push(noticeMsg);
      UI.appendMessageEl(noticeMsg, Session.stripStatusTag);
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

  function dismissActiveConfirmModal(approved) {
    if (window.Modal && typeof Modal.dismissActive === 'function') {
      Modal.dismissActive(approved);
    }
  }

  function onWsConfirmResolved(data) {
    if (!data) return;
    // 其它端 first-win 后关闭本地弹窗，避免 PC/移动端各弹各的
    if (!activeConfirmId || data.confirmId === activeConfirmId) {
      activeConfirmResolved = true;
      dismissActiveConfirmModal(!!data.approved);
    }
  }

  function onWsConfirmTimeout(data) {
    if (!data) return;
    if (!activeConfirmId || data.confirmId === activeConfirmId) {
      activeConfirmResolved = true;
      dismissActiveConfirmModal(false);
    }
  }

  function applyTurnTokenUsageToLastAgent(usage, messageId) {
    if (!usage || typeof usage !== 'object') return false;
    var payload = {
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
    };
    var msgs = Session.getMessages();
    if (messageId) {
      for (var j = msgs.length - 1; j >= 0; j--) {
        if (msgs[j].role === 'agent' && msgs[j].id === messageId) {
          msgs[j].turnTokenUsage = payload;
          if (UI.updateMessageTokenUsage) UI.updateMessageTokenUsage(msgs[j]);
          Session.saveMessages();
          return true;
        }
      }
      pendingTurnTokenUsage = { usage: payload, messageId: messageId };
      return false;
    }
    for (var i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'agent') {
        msgs[i].turnTokenUsage = payload;
        if (UI.updateMessageTokenUsage) UI.updateMessageTokenUsage(msgs[i]);
        Session.saveMessages();
        return true;
      }
    }
    pendingTurnTokenUsage = { usage: payload, messageId: '' };
    return false;
  }

  function onWsTokenUsage(data) {
    updateTokenUsage(data.inputTokens || 0, data.outputTokens || 0, {
      effectiveUsed: data.effectiveUsed,
      contextWindow: data.contextWindow,
    });
    var turnIn = typeof data.totalInputTokens === 'number' ? data.totalInputTokens : 0;
    var turnOut = typeof data.totalOutputTokens === 'number' ? data.totalOutputTokens : 0;
    if (turnIn > 0 || turnOut > 0) {
      var usage = { inputTokens: turnIn, outputTokens: turnOut };
      if (applyTurnTokenUsageToLastAgent(usage, data.messageId || '')) {
        pendingTurnTokenUsage = null;
      }
    }
  }

  function onWsPulse(data) {
    if (!sessionPet) return;
    var hint = data && data.hint ? data.hint : '处理中';
    Pet.updateStatusText(hint, isStreaming, WS.isProcessing());
  }

  function applyHarnessRestoreUi(canRestore, checkpointIds) {
    if (UI && typeof UI.setRestoreAvailability === 'function') {
      UI.setRestoreAvailability(canRestore);
    }
    if (UI && typeof UI.setCheckpointMessageIds === 'function') {
      UI.setCheckpointMessageIds(checkpointIds || []);
    }
  }

  function onWsHarnessState(data) {
    if (!data) return;
    applyHarnessRestoreUi(!!data.canRestore, data.checkpointMessageIds);
  }

  function onWsCheckpointMessageIds(data) {
    if (!data || !UI || typeof UI.setCheckpointMessageIds !== 'function') return;
    UI.setCheckpointMessageIds(data.ids || []);
  }

  function dispatchDeleteMessage(messageId) {
    if (!messageId) return;
    if (!WS.isConnected || !WS.isConnected()) {
      notifyUser('连接已断开，正在重连…', 'warning', { duration: 4000 });
      WS.connect(remoteToken);
      return;
    }
    if (!WS.canDeleteUserMessage || !WS.canDeleteUserMessage()) {
      notifyUser('运行中，请等待当前任务完成后再删除。', 'warning', { duration: 4000 });
      return;
    }
    var sent = WS.sendDeleteUserMessage(messageId);
    if (sent === false) {
      notifyUser('删除请求发送失败，请检查网络后重试。', 'error', { duration: 4000 });
    }
  }

  function dispatchRestoreRuntime(messageId) {
    if (!messageId) return;
    if (!WS.isConnected || !WS.isConnected()) {
      notifyUser('连接已断开，正在重连…', 'warning', { duration: 4000 });
      WS.connect(remoteToken);
      return;
    }
    if (!WS.canRestoreRuntime || !WS.canRestoreRuntime()) {
      notifyUser('运行中，请等待当前任务完成后再回滚。', 'warning', { duration: 4000 });
      return;
    }
    var sent = WS.sendRestoreRuntime(messageId);
    if (sent === false) {
      notifyUser('回滚请求发送失败，请检查网络后重试。', 'error', { duration: 4000 });
    }
  }

  function closeRestoreConfirmDialog() {
    var overlay = document.querySelector('.restore-confirm-overlay');
    if (overlay) overlay.remove();
  }

  function showRestoreConfirmDialog(messageId) {
    closeRestoreConfirmDialog();
    var overlay = document.createElement('div');
    overlay.className = 'restore-confirm-overlay';
    overlay.innerHTML =
      '<div class="restore-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-confirm-title">' +
        '<h3 id="restore-confirm-title">确认回滚？</h3>' +
        '<p>将运行时回滚到此对话点？<br><br>' +
        '当前运行时状态及之后的全部对话记录将被丢弃。</p>' +
        '<div class="restore-confirm-actions">' +
          '<button type="button" class="restore-confirm-cancel">取消</button>' +
          '<button type="button" class="restore-confirm-ok">回滚</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.restore-confirm-cancel').addEventListener('click', closeRestoreConfirmDialog);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeRestoreConfirmDialog();
    });
    overlay.querySelector('.restore-confirm-ok').addEventListener('click', function () {
      closeRestoreConfirmDialog();
      dispatchRestoreRuntime(messageId);
    });
  }

  function closeDeleteConfirmDialog() {
    var overlay = document.querySelector('.delete-confirm-overlay');
    if (overlay) overlay.remove();
  }

  function showDeleteConfirmDialog(messageId) {
    closeDeleteConfirmDialog();
    var overlay = document.createElement('div');
    overlay.className = 'restore-confirm-overlay delete-confirm-overlay';
    overlay.innerHTML =
      '<div class="restore-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">' +
        '<h3 id="delete-confirm-title">确认删除？</h3>' +
        '<p>将删除此消息及之后的全部对话记录，并同步更新模型上下文。<br><br>' +
        '此操作不会回滚工作区文件修改。</p>' +
        '<div class="restore-confirm-actions">' +
          '<button type="button" class="restore-confirm-cancel">取消</button>' +
          '<button type="button" class="restore-confirm-ok">删除</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.restore-confirm-cancel').addEventListener('click', closeDeleteConfirmDialog);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeDeleteConfirmDialog();
    });
    overlay.querySelector('.restore-confirm-ok').addEventListener('click', function () {
      closeDeleteConfirmDialog();
      dispatchDeleteMessage(messageId);
    });
  }

  function handleMessageDeleteAction(messageId, btn) {
    if (btn && btn.disabled) {
      notifyUser('运行中，请等待当前任务完成后再删除。', 'warning', { duration: 4000 });
      return;
    }
    if (!WS.canDeleteUserMessage || !WS.canDeleteUserMessage()) {
      notifyUser('运行中，请等待当前任务完成后再删除。', 'warning', { duration: 4000 });
      return;
    }
    if (!messageId) return;
    showDeleteConfirmDialog(messageId);
  }

  function handleMessageRestoreAction(messageId, btn) {
    if (btn && btn.disabled) {
      notifyUser('运行中，请等待当前任务完成后再回滚。', 'warning', { duration: 4000 });
      return;
    }
    if (!WS.canRestoreRuntime || !WS.canRestoreRuntime()) {
      notifyUser('运行中，请等待当前任务完成后再回滚。', 'warning', { duration: 4000 });
      return;
    }
    if (!messageId) return;
    if (UI && typeof UI.hasCheckpointForMessage === 'function' && !UI.hasCheckpointForMessage(messageId)) {
      notifyUser('未找到该消息的检查点。该消息可能在回滚功能启用前发送，请发送新消息后再试。', 'warning', { duration: 5000 });
      return;
    }
    showRestoreConfirmDialog(messageId);
  }

  function onRestoreButtonClick(e) {
    var target = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    if (!target || !target.closest) return;
    var btn = target.closest('.msg-restore-btn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    handleMessageRestoreAction(btn.dataset.messageId, btn);
  }

  function onDeleteButtonClick(e) {
    var target = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    if (!target || !target.closest) return;
    var btn = target.closest('.msg-delete-btn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    handleMessageDeleteAction(btn.dataset.messageId, btn);
  }
                                                             
  function onWsRuntimeRestored() {
    isStreaming = false;
    UI.setStreamingState(false);
    UI.clearReasoningStream();
    if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
    if (Session.invalidateStructuredCache) Session.invalidateStructuredCache();
    refreshChatHistoryAfterTurn(true);
    syncSidebarWorkspace({ sessionId: Session.getActiveId ? Session.getActiveId() : 'default' });
  }

  function notifyUser(message, type, opts) {
    if (window.Notification && typeof window.Notification.show === 'function') {
      return window.Notification.show(message, type || 'info', opts);
    }
    if (window.UI && typeof window.UI.notify === 'function') {
      return window.UI.notify(message, type || 'info', opts);
    }
    alert(message);
  }

  function onWsRestoreFailed(data) {
    var msg = (data && data.error) ? data.error : '回滚失败，运行时状态未改变。';
    notifyUser(msg, 'error', { duration: 5000 });
  }

  function onWsMessageDeleted() {
    isStreaming = false;
    UI.setStreamingState(false);
    UI.clearReasoningStream();
    if (window.ChatExecutionPlan) window.ChatExecutionPlan.clear();
    if (Session.invalidateStructuredCache) Session.invalidateStructuredCache();
    refreshChatHistoryAfterTurn(true);
    syncSidebarWorkspace({ sessionId: Session.getActiveId ? Session.getActiveId() : 'default' });
  }

  function onWsDeleteMessageFailed(data) {
    var msg = (data && data.error) ? data.error : '删除消息失败。';
    notifyUser(msg, 'error', { duration: 5000 });
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

  function getSyncMessagesGapMs() {
    return isMobileShell() ? 12000 : 5000;
  }

  function syncMessages(force) {
    if (shouldSkipServerSnapshotSync()) return;
    var allowThrottleBypass = !!force || needsInitialHistoryPaint();
    if (!allowThrottleBypass) {
      var now = Date.now();
      if (now - lastSyncMessagesMs < getSyncMessagesGapMs()) return;
    }
    lastSyncMessagesMs = Date.now();
    Session.fetchServerMessages(function (serverMsgs) {
      // F5 重连：onWsOpen 发起的 fetch 可能在 connected+restore 之后才返回；
      // 此时若仍 renderMessagesOnly 会清掉 runningTurn 刚还原的工具时间线/流式气泡。
      if (shouldSkipServerSnapshotSync()) return;
      if (!serverMsgs || serverMsgs.length === 0) return;
      var separated = Session.separateToolTraces(serverMsgs);
      var updated = Session.applyServerChatSnapshot(separated, { fullRender: false }, isStreaming, WS.isProcessing());
      if (updated) {
        renderChatHistoryWithFetch(false, function () {
          Session.saveMessages();
          initialHistoryPainted = true;
          pendingInitialPaint = false;
        });
      } else if (needsInitialHistoryPaint() && serverMsgs && serverMsgs.length > 0) {
        renderChatHistoryWithFetch(false, function () {
          Session.saveMessages();
          initialHistoryPainted = true;
          pendingInitialPaint = false;
        });
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

  function paintRemoteUserMessagesWithoutDom(msgs) {
    var painted = false;
    for (var i = 0; i < msgs.length; i++) {
      var um = msgs[i];
      if (um.role !== 'user' || um._el) continue;
      if (UI.insertRemoteUserMessageEl) {
        UI.insertRemoteUserMessageEl(um, Session.stripStatusTag);
      } else {
        UI.appendMessageEl(um, Session.stripStatusTag);
      }
      painted = true;
    }
    if (painted) {
      if (UI.maybeRepartitionTailIfNeeded) {
        UI.maybeRepartitionTailIfNeeded(
          Session.getMessages(),
          Session.getToolTraces(),
          Session.stripStatusTag,
          'force',
          buildDisplayMap(),
        );
      }
      syncWelcomeState();
      UI.scheduleScrollIfSticky();
    }
    return painted;
  }

  /** processing 期间无法全量拉快照时，仅补齐服务端已有 user 消息并插入 DOM */
  function mergeAndPaintRemoteUserMessages(serverMsgs) {
    var raw = Array.isArray(serverMsgs) ? serverMsgs : [];
    if (!raw.length || !Session.mergeUserMessagesFromServer) return false;
    var separated = Session.separateToolTraces(raw);
    var added = Session.mergeUserMessagesFromServer(separated.msgs);
    var painted = paintRemoteUserMessagesWithoutDom(Session.getMessages());
    if (added || painted) Session.saveMessages();
    return added || painted;
  }

  function applyRemoteUserMessage(msg) {
    if (!msg || msg.role !== 'user') return false;
    if (msg.sessionId && Session.getActiveId && msg.sessionId !== Session.getActiveId()) return false;
    var existed = Session.hasUserMessageId && Session.hasUserMessageId(msg.id);
    if (!Session.insertRemoteUserMessage || !Session.insertRemoteUserMessage(msg)) return false;
    if (existed) {
      if (UI.updateMessageImagesEl && msg.images && msg.images.length) {
        UI.updateMessageImagesEl(msg.id, msg.images);
      }
      Session.saveMessages();
      syncWelcomeState();
      UI.scheduleScrollIfSticky();
      return true;
    }
    if (UI.insertRemoteUserMessageEl) {
      UI.insertRemoteUserMessageEl(msg, Session.stripStatusTag);
    } else {
      UI.appendMessageEl(msg, Session.stripStatusTag);
    }
    if (UI.maybeRepartitionTailIfNeeded) {
      UI.maybeRepartitionTailIfNeeded(
        Session.getMessages(),
        Session.getToolTraces(),
        Session.stripStatusTag,
        'force',
        buildDisplayMap(),
      );
    }
    Session.saveMessages();
    syncWelcomeState();
    UI.scheduleScrollIfSticky();
    return true;
  }

  function onWsUserMessageAppended(data) {
    if (!data || !data.message) return;
    if (data.sessionId && Session.getActiveId && data.sessionId !== Session.getActiveId()) return;
    applyRemoteUserMessage(data.message);
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
    if (data && data.reason === 'message_deleted') {
      if (!shouldSkipServerSnapshotSync()) {
        refreshChatHistoryAfterTurn(true);
      }
      return;
    }
    if (data && data.reason === 'user_message') {
      if (Session.fetchAndMergeRemoteUserMessages) {
        Session.fetchAndMergeRemoteUserMessages(function (added) {
          if (!added) return;
          paintRemoteUserMessagesWithoutDom(Session.getMessages());
          Session.saveMessages();
        });
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
    // 模型配置与底部 chip 每次回到聊天页都要刷新，不受消息同步节流影响
    loadModelConfig();
    if (needsInitialHistoryPaint()) return;
    var now = Date.now();
    if (now - lastActivateFetchMs < getActivateFetchGapMs()) return;
    lastActivateFetchMs = now;
    if (!WS.isProcessing() && !isStreaming && !Session.hasStreamingModelBubble()) {
      syncMessages(false);
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
    if (remoteMode) {
      var remoteSid = params.get('sid');
      if (remoteSid && window.ChatSessionStore && typeof window.ChatSessionStore.setActiveSessionId === 'function') {
        window.ChatSessionStore.setActiveSessionId(remoteSid);
      }
    }

    container.innerHTML =
      '<div class="chat-page">' +
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
          '<div class="chat-fade-overlay" aria-hidden="true"></div>' +
          '<div class="pending-images-preview hidden" id="pending-images-preview"></div>' +
          '<div class="file-upload-status hidden" id="file-status"></div>' +
          '<div class="chat-composer">' +
            '<div class="composer-input">' +
              '<div class="input-wrapper">' +
                '<div id="skill-chips-bar" class="skill-chips-bar hidden" role="listbox" aria-label="已选技能"></div>' +
                '<div id="file-ref-chips-bar" class="file-ref-chips-bar hidden" role="listbox" aria-label="已引用文件"></div>' +
                '<textarea id="chat-input" rows="2" placeholder="输入消息… (输入 # 选用技能，@ 引用文件)"></textarea>' +
              '</div>' +
            '</div>' +
            '<div class="composer-toolbar">' +
              '<button class="btn-icon btn-icon-ghost" id="btn-file" title="Upload file" aria-label="Upload file">' +
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
              '</button>' +
              '<button class="chip chip-select" id="chip-model" type="button" aria-label="选择模型" aria-haspopup="menu" aria-expanded="false">' +
                '<span class="chip-label" id="chip-model-label">加载中…</span>' +
                '<svg class="chip-caret" viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="2 4 6 8 10 4"/></svg>' +
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
          '<input type="file" class="hidden-input" id="file-input" multiple>' +
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
    elStatusBar = container.querySelector('#agent-status-bar');
    elStatusTurn = container.querySelector('#status-turn');
    elCmdPlusBtn = container.querySelector('#btn-cmd-plus');
    mainInputWrapper = container.querySelector('.input-wrapper');
    if (elCmdPlusBtn) Cmd.setAnchor(elCmdPlusBtn);
    var composerInputEl = container.querySelector('.composer-input');
    if (composerInputEl) {
      Cmd.setInputAnchor(composerInputEl);
      if (Skills) Skills.setAnchor(composerInputEl);
      if (FileRef) FileRef.setAnchor(composerInputEl);
    }

    // 初始化底部"模型名"下拉：点击 chip 弹出与命令面板同款下拉，
    // 选中后走 config-page 相同的 POST /api/config 设为默认逻辑。
    if (window.ChatModelPicker && typeof window.ChatModelPicker.init === 'function') {
      window.ChatModelPicker.init({
        chipEl: container.querySelector('#chip-model'),
        labelEl: container.querySelector('#chip-model-label'),
      });
      // 初次拉取 providers 缓存，供下拉渲染使用
      window.ChatModelPicker.refreshFromServer();
    }

    // 会话侧栏由 app.js 挂在 app-shell 上，切记忆/配置页时保持可见。

    // 初始化子模块
    UI.init({ elMessages: elMessages, elAnchor: elAnchor, elInput: elInput, elSendBtn: elSendBtn });
    if (typeof UI.setMessageActionHandlers === 'function') {
      UI.setMessageActionHandlers({
        onDelete: handleMessageDeleteAction,
        onRestore: handleMessageRestoreAction,
      });
    }
    if (window.ChatStaircaseNav && typeof window.ChatStaircaseNav.init === 'function') {
      window.ChatStaircaseNav.init({
        elMessages: elMessages,
        elMain: container.querySelector('.chat-main'),
        getMessages: Session.getMessages,
      });
    }
    if (window.ChatWelcome && typeof window.ChatWelcome.init === 'function') {
      window.ChatWelcome.init({
        elMessages: elMessages,
        remoteMode: remoteMode,
        onPromptSelect: function (text) {
          if (!elInput) return;
          UI.setInputValue(text);
          UI.autoResizeInput();
          UI.focusInput();
        },
      });
    }
    if (window.AppShell) {
      if (typeof window.AppShell.addSupervisorModeListener === 'function') {
        window.AppShell.addSupervisorModeListener(function () {
          syncWelcomeState();
        });
      }
      if (typeof window.AppShell.addConnectionChangeListener === 'function') {
        window.AppShell.addConnectionChangeListener(function () {
          syncWelcomeState();
        });
      }
    }
    File.init({ elFileStatus: elFileStatus, elFileInput: elFileInput });
    Cmd.setRemoteMode(remoteMode);
    var cmdDropdown = Cmd.init();
    if (mainInputWrapper && cmdDropdown) mainInputWrapper.appendChild(cmdDropdown);
    if (Skills) {
      Skills.init();
      Skills.initSkillComposer(elInput, container.querySelector('#skill-chips-bar'));
    }
    if (FileRef) {
      FileRef.init();
      FileRef.initFileComposer(elInput, container.querySelector('#file-ref-chips-bar'));
    }

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
    WS.on('confirm_timeout', onWsConfirmTimeout);
    WS.on('tokenUsage', onWsTokenUsage);
    WS.on('pulse', onWsPulse);
    WS.on('session_updated', onWsSessionUpdated);
    WS.on('user_message_appended', onWsUserMessageAppended);
    WS.on('workspace_updated', syncSidebarWorkspace);
    WS.on('sync', syncMessages);
    WS.on('bg_task_update', onWsBgTaskUpdate);
    WS.on('bg_task_stop_result', onWsBgTaskStopResult);
    WS.on('tool_output', onWsToolOutput);
    WS.on('harness_state', onWsHarnessState);
    WS.on('checkpoint_message_ids', onWsCheckpointMessageIds);
    WS.on('runtime_restored', onWsRuntimeRestored);
    WS.on('restore_failed', onWsRestoreFailed);
    WS.on('message_deleted', onWsMessageDeleted);
    WS.on('delete_message_failed', onWsDeleteMessageFailed);
    WS.on('task_queue_updated', onWsTaskQueueUpdated);

    if (window.ChatTaskQueue && typeof window.ChatTaskQueue.init === 'function') {
      var inputArea = container.querySelector('.chat-input-area');
      window.ChatTaskQueue.init({
        container: inputArea,
        getSessionId: function () { return Session.getActiveId(); },
        onFillInput: function (text) {
          if (elInput) {
            elInput.value = text || '';
            UI.autoResizeInput();
            elInput.focus();
          }
          syncComposerActionState();
        },
      });
      window.ChatTaskQueue.refresh(Session.getActiveId());
    }

    // 连接 WebSocket
    WS.connect(remoteToken);

    // 绑定 UI 事件（捕获阶段：虚拟历史区与尾部真实 DOM 均可靠命中）
    elMessages.addEventListener('click', onRestoreButtonClick, true);
    elMessages.addEventListener('click', onDeleteButtonClick, true);
    elSendBtn.addEventListener('click', handleSend);
    elInput.addEventListener('keydown', function (e) {
      if (FileRef && FileRef.handleKeydown(e, elInput)) return;
      if (Skills && Skills.handleKeydown(e, elInput)) return;
      if (Cmd.handleKeydown(e, elInput)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (elSendBtn && elSendBtn.dataset.action === 'stop') return;
        handleSend();
      }
    });
    elInput.addEventListener('input', function () {
      UI.autoResizeInput();
      if (Skills) Skills.handleInput(elInput.value, elInput);
      if (FileRef) FileRef.handleInput(elInput.value, elInput);
      Cmd.handleInput(elInput.value, elInput);
      syncComposerActionState();
    });
    // 命令面板的 outside-click / escape / focus-blur 关闭由 ChatDropdown 统一处理
    if (elCmdPlusBtn) {
      elCmdPlusBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleCmdPalette();
      });
    }
    // 命令面板的 keydown / outside-click / escape 由 ChatDropdown 统一处理
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
        if (!elFileInput.files) return;
        for (var fi = 0; fi < elFileInput.files.length; fi++) {
          File.handleFileSelect(elFileInput.files[fi], Session.getMessages(), function (msg) { UI.appendMessageEl(msg, Session.stripStatusTag); }, Session.saveMessages);
        }
        elFileInput.value = '';
      });
    }

    if (!remoteMode && window.ChatSessionStore && typeof window.ChatSessionStore.bootstrapInitialSession === 'function') {
      window.ChatSessionStore.bootstrapInitialSession(function () {
        paintInitialChatView();
      });
    } else if (remoteMode) {
      pendingInitialPaint = true;
      setTimeout(function () {
        if (!initialHistoryPainted && pendingInitialPaint) {
          pendingInitialPaint = false;
          paintInitialChatView();
        }
      }, 4000);
    } else {
      paintInitialChatView();
    }

    // 切回前台重连
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        if (!WS.isConnected()) {
          WS.connect(remoteToken);
        } else if (!WS.isProcessing() && !isStreaming && !Session.hasStreamingModelBubble()) {
          var now = Date.now();
          if (now - lastActivateFetchMs >= getActivateFetchGapMs()) {
            lastActivateFetchMs = now;
            syncMessages(false);
          }
        }
        WS.startSyncPolling();
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
    syncWelcomeState: syncWelcomeState,
    reloadModelConfig: loadModelConfig,
    triggerSend: handleSend,
    isMounted: function () { return mounted; },
    getContainer: function () { return container; },
  };
})();
