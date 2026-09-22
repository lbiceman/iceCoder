// @ts-nocheck
/**
 * 聊天 UI 渲染模块
 * 负责：消息渲染、流式输出、工具调用展示、滚动控制、输入框管理
 */

/* exported ChatUI */

export const ChatUI = (() => {

  const TOOL_TRACE_VISIBLE_MAX = 3;

  let elMessages = null;
  let elAnchor = null;
  let elHistoryOuter = null;
  let elHistoryWindow = null;
  let elTailRoot = null;
  let elTailAnchor = null;
  let virtualScroller = null;
  let lastStripStatusTagFn = function (t) { return t; };
  let elInput = null;
  let elSendBtn = null;

  let streamReplyBuffer = '';
  let streamReasoningBuffer = '';

  /** 距底部小于该值时视为「贴底」，新内容会自动跟随滚动 */
  const SCROLL_STICKY_THRESHOLD_PX = 80;
  let autoScrollEnabled = true;
  /** 用户主动离开底部后保持，避免阈值附近误恢复贴底跟滚 */
  let userPinnedScroll = false;
  let scrollRafId = 0;
  let suppressScrollSync = false;
  let toolScrollGen = 0;
  let toolScrollFinishTimer = 0;
  let toolScrollEndHandler = null;
  let elJumpBottom = null;
  let contentResizeObserver = null;
  let tailResizeObserver = null;
  let composerResizeObserver = null;

  // 实时工具区 DOM
  let liveToolRoundActive = false;
  let liveToolRoundRoot = null;
  let liveToolRoundVisible = null;
  let liveToolRoundCollapsed = null;
  let liveToolRoundToggle = null;
  let liveToolRoundCount = 0;
  let diffOutsideCloseBound = false;

  function init(els) {
    elMessages = els.elMessages;
    elAnchor = els.elAnchor;
    elInput = els.elInput;
    elSendBtn = els.elSendBtn;

    if (elMessages) {
      elMessages.addEventListener('scroll', onMessagesScroll, { passive: true });
      setupScrollIntentListeners();
    }
    ensureChatLayout();
    ensureJumpBottomButton();
    setupContentResizeObserver();
    setupTailResizeObserver();
    setupComposerResizeObserver();
    ensureDiffOutsideClose();
    updateFollowBottomClass();
  }

  /** 贴底跟随时才启用底部 overflow-anchor，避免 LLM 流式输出时误拽滚动条 */
  function updateFollowBottomClass() {
    if (!elMessages) return;
    if (autoScrollEnabled) elMessages.classList.add('is-follow-bottom');
    else elMessages.classList.remove('is-follow-bottom');
  }

  function ensureChatLayout() {
    if (!elMessages || !elAnchor) return;

    if (!elHistoryOuter) {
      const existingOuter = elMessages.querySelector('.chat-history-outer');
      const existingTail = elMessages.querySelector('.chat-tail-root');
      if (existingOuter && existingTail) {
        elHistoryOuter = existingOuter;
        elHistoryWindow = existingOuter.querySelector('.chat-history-window');
        elTailRoot = existingTail;
        elTailAnchor = existingTail.querySelector('.chat-tail-anchor');
      }
    }

    if (!elHistoryOuter) {
      // 从旧版「消息直挂 chat-messages」升级时，清空 anchor 前节点（随后由 render 重绘）
      while (elAnchor.previousSibling) {
        elMessages.removeChild(elAnchor.previousSibling);
      }

      elHistoryOuter = document.createElement('div');
      elHistoryOuter.className = 'chat-history-outer';
      elHistoryWindow = document.createElement('div');
      elHistoryWindow.className = 'chat-history-window';
      elHistoryOuter.appendChild(elHistoryWindow);

      elTailRoot = document.createElement('div');
      elTailRoot.className = 'chat-tail-root';
      elTailAnchor = document.createElement('div');
      elTailAnchor.className = 'chat-tail-anchor';
      elTailRoot.appendChild(elTailAnchor);

      elMessages.insertBefore(elHistoryOuter, elAnchor);
      elMessages.insertBefore(elTailRoot, elAnchor);
    }

    ensureTailResizeObserver();

    if (window.ChatVirtualHistory
        && typeof window.ChatVirtualHistory.createScroller === 'function'
        && elHistoryOuter && elHistoryWindow) {
      if (!virtualScroller) {
        virtualScroller = window.ChatVirtualHistory.createScroller();
      }
      virtualScroller.init({
        outerEl: elHistoryOuter,
        windowEl: elHistoryWindow,
        scrollRoot: elMessages,
        renderUnit: renderHistoryUnit,
        stickyThresholdPx: SCROLL_STICKY_THRESHOLD_PX,
        onAfterVisibleRender() {
          refreshRestoreButtonsVisibility();
          if (window.ChatStaircaseNav && typeof window.ChatStaircaseNav.notifyScrollSync === 'function') {
            window.ChatStaircaseNav.notifyScrollSync();
          }
        },
      });
    }

    setupToolClickDelegation();
    setupToolTraceToggleDelegation();
    setupThinkingToggleDelegation();
  }

  function isNodeInHistoryRegion(node) {
    return !!(elHistoryWindow && node && elHistoryWindow.contains(node));
  }

  function isNodeInTailRegion(node) {
    return !!(elTailRoot && node && elTailRoot.contains(node));
  }

  /** 仅虚拟历史区需要委托；尾部真实 DOM 用直接监听 */
  function usesToolClickDelegation(block) {
    return isNodeInHistoryRegion(block);
  }

  function eventTargetElement(e) {
    const t = e && e.target;
    if (!t) return null;
    return t.nodeType === 1 ? t : t.parentElement;
  }

  function handleHistoryToolNameClick(block, toolName, e) {
    if (!block || !toolName) return;
    const group = block.closest('.tool-trace-group');
    bindDiffToggleRow(block, toolName, true);
    if (block.getAttribute('data-has-diff') !== '1') {
      const ds = block._diffSource || resolveDiffSourceForHistoryBlock(block, group);
      if (ds && !mountHiddenDiffInBlock(block, ds)) {
        delete block._diffSource;
      }
    }
    if (block.getAttribute('data-has-diff') === '1') {
      toggleDiffPanelForBlock(block);
      return;
    }
    tryLazyMountDiffForBlock(block, toolName, (ok) => {
      if (ok) toggleDiffPanelForBlock(block);
    });
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** 历史区工具名点击（绑在 history-window 捕获阶段，虚拟回收后仍可用） */
  function setupToolClickDelegation() {
    if (!elHistoryWindow) return;
    if (elHistoryWindow._toolDiffClickHandler) {
      elHistoryWindow.removeEventListener('click', elHistoryWindow._toolDiffClickHandler, true);
    }
    elHistoryWindow._toolDiffClickHandler = function (e) {
      const target = eventTargetElement(e);
      if (!target || !target.closest) return;
      const nameEl = target.closest('.tool-name');
      if (!nameEl || !elHistoryWindow.contains(nameEl)) return;
      const row = nameEl.closest('.tool-action');
      if (!row) return;
      const block = row.closest('.tool-action-row-block');
      if (!block) return;
      const toolName = row.getAttribute('data-tool') || '';
      if (!isDiffCapableToolName(toolName)) return;
      handleHistoryToolNameClick(block, toolName, e);
    };
    elHistoryWindow.addEventListener('click', elHistoryWindow._toolDiffClickHandler, true);
  }

  /** 工具 trace「还有 N 条历史 · 展开」按钮（历史区虚拟回收后仍可用） */
  function setupToolTraceToggleDelegation() {
    if (!elHistoryWindow) return;
    if (elHistoryWindow._toolTraceClickHandler) {
      elHistoryWindow.removeEventListener('click', elHistoryWindow._toolTraceClickHandler, true);
    }
    elHistoryWindow._toolTraceClickHandler = function (e) {
      const target = eventTargetElement(e);
      if (!target || !target.closest) return;
      const btn = target.closest('button.tool-trace-toggle, .tool-trace-toggle');
      if (!btn || btn.disabled || !elHistoryWindow.contains(btn)) return;
      const group = btn.closest('.tool-trace-group');
      if (!group) return;
      const collapsed = group.querySelector('.tool-trace-collapsed');
      if (!collapsed) return;
      e.preventDefault();
      e.stopPropagation();
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        collapsed.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = `还有 ${collapsed.children.length} 条历史 · 展开`;
      } else {
        collapsed.style.display = '';
        btn.setAttribute('aria-expanded', 'true');
        btn.textContent = '收起';
        primeHistoryDiffSourcesInGroup(group);
      }
      notifyHistoryLayoutChange(group);
    };
    elHistoryWindow.addEventListener('click', elHistoryWindow._toolTraceClickHandler, true);
  }

  function fillThinkingToggleText(container, text) {
    container.textContent = '';
    const word = text || 'Thinking';
    for (let i = 0; i < word.length; i++) {
      const ch = document.createElement('span');
      ch.className = 'msg-thinking-char';
      ch.textContent = word.charAt(i);
      container.appendChild(ch);
    }
  }

  function createThinkingToggleButton(footer) {
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'msg-label msg-thinking-toggle'
      + (footer ? ' msg-thinking-toggle-footer' : ' msg-thinking-toggle-header');
    label.setAttribute('aria-expanded', 'true');
    label.setAttribute('aria-label', '折叠思考内容');
    const labelText = document.createElement('span');
    labelText.className = 'msg-thinking-toggle-text';
    fillThinkingToggleText(labelText, 'Thinking');
    label.appendChild(labelText);
    const labelIcon = document.createElement('span');
    labelIcon.className = 'msg-thinking-toggle-icon';
    labelIcon.setAttribute('aria-hidden', 'true');
    labelIcon.textContent = '▾';
    label.appendChild(labelIcon);
    return label;
  }

  function setThinkingBlockCollapsed(block, collapsed) {
    if (!block) return;
    if (collapsed) block.classList.add('is-collapsed');
    else block.classList.remove('is-collapsed');
    const toggles = block.querySelectorAll('.msg-thinking-toggle');
    for (let i = 0; i < toggles.length; i++) {
      const t = toggles[i];
      t.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      t.setAttribute('aria-label', collapsed ? '展开思考内容' : '折叠思考内容');
    }
  }

  /** 思考块头/尾 Thinking 行折叠（尾部真实 DOM，委托在 chat-messages） */
  function setupThinkingToggleDelegation() {
    if (!elMessages) return;
    if (elMessages._thinkingToggleHandler) {
      elMessages.removeEventListener('click', elMessages._thinkingToggleHandler);
    }
    elMessages._thinkingToggleHandler = function (e) {
      const target = eventTargetElement(e);
      if (!target || !target.closest) return;
      const btn = target.closest('.msg-thinking-toggle');
      if (!btn || !elMessages.contains(btn)) return;
      const block = btn.closest('.message-thinking');
      if (!block) return;
      e.preventDefault();
      e.stopPropagation();
      const isExpanded = btn.getAttribute('aria-expanded') !== 'false';
      setThinkingBlockCollapsed(block, isExpanded);
      notifyTailLayoutChange();
    };
    elMessages.addEventListener('click', elMessages._thinkingToggleHandler);
  }

  let cachedToolCallDiffIndex = null;
  let cachedToolCallDiffIndexRef = null;
  let cachedTraceDiffIndex = null;
  let cachedTraceDiffSessionId = null;
  let cachedSessionWorkspaceRoot = null;
  let cachedSessionWorkspaceSessionId = null;
  let historyDisplayMapCache = null;

  function setHistoryDisplayMapCache(displayMap) {
    historyDisplayMapCache = displayMap || null;
  }

  function invalidateToolDisplayCaches() {
    cachedToolCallDiffIndex = null;
    cachedToolCallDiffIndexRef = null;
    cachedTraceDiffIndex = null;
    cachedTraceDiffSessionId = null;
    cachedSessionWorkspaceRoot = null;
    cachedSessionWorkspaceSessionId = null;
    if (window.ToolDisplayHistory
        && typeof window.ToolDisplayHistory.invalidateStructuredCaches === 'function') {
      window.ToolDisplayHistory.invalidateStructuredCaches();
    }
  }

  function getActiveSessionIdForApi() {
    return window.ChatSession && typeof window.ChatSession.getActiveId === 'function'
      ? window.ChatSession.getActiveId()
      : 'default';
  }

  function prefetchToolTraceDiffIndex() {
    const sid = getActiveSessionIdForApi();
    if (cachedTraceDiffIndex && cachedTraceDiffSessionId === sid) return;
    fetch(`/api/sessions/${encodeURIComponent(sid)}/tool-trace-diffs`, { cache: 'no-store' })
      .then((res) =>  res.ok ? res.json() : { index: {} })
      .then((data) => {
        cachedTraceDiffIndex = (data && data.index) ? data.index : {};
        cachedTraceDiffSessionId = sid;
        cachedToolCallDiffIndex = null;
        cachedToolCallDiffIndexRef = null;
      })
      .catch(() => {
        cachedTraceDiffIndex = {};
        cachedTraceDiffSessionId = sid;
      });
  }

  function getToolCallDiffIndex() {
    if (!window.ToolDisplayHistory
        || typeof window.ToolDisplayHistory.buildToolCallDiffIndex !== 'function') {
      return cachedTraceDiffIndex || null;
    }
    const structured = getStructuredMessagesLocal();
    const fromStructured = structured.length > 0
      ? window.ToolDisplayHistory.buildToolCallDiffIndex(structured)
      : {};
    const fromTrace = cachedTraceDiffIndex || {};
    if (!structured.length && !Object.keys(fromTrace).length) return null;
    if (cachedToolCallDiffIndex && cachedToolCallDiffIndexRef === structured
        && cachedTraceDiffSessionId === getActiveSessionIdForApi()) {
      return cachedToolCallDiffIndex;
    }
    cachedToolCallDiffIndexRef = structured;
    cachedToolCallDiffIndex = { ...fromStructured, ...fromTrace };
    return cachedToolCallDiffIndex;
  }

  function getSessionWorkspaceRoot(callback) {
    const sid = getActiveSessionIdForApi();
    if (cachedSessionWorkspaceRoot && cachedSessionWorkspaceSessionId === sid) {
      if (callback) callback(cachedSessionWorkspaceRoot);
      return;
    }
    fetch(`/api/sessions/workspace/${encodeURIComponent(sid)}`, { cache: 'no-store' })
      .then((res) =>  res.ok ? res.json() : {})
      .then((data) => {
        cachedSessionWorkspaceRoot = (data && data.workspaceRoot) ? String(data.workspaceRoot) : '';
        cachedSessionWorkspaceSessionId = sid;
        if (callback) callback(cachedSessionWorkspaceRoot);
      })
      .catch(() => {
        cachedSessionWorkspaceRoot = '';
        cachedSessionWorkspaceSessionId = sid;
        if (callback) callback('');
      });
  }

  function prefetchSessionWorkspaceRoot() {
    getSessionWorkspaceRoot(null);
  }

  /** 服务端 tool-diff 仅对 write_file 有磁盘回退；其它工具与本地同样只查 index/structured */
  function shouldFetchToolDiffFromServer(toolName, relPath, block) {
    if (toolName === 'write_file') return true;
    if (block && block.getAttribute('data-diff-rel-path')) return true;
    if (relPath && !/\s/.test(relPath) && /\.[A-Za-z0-9]{1,8}$/.test(relPath)) return true;
    return false;
  }

  function resolveDiffRelPathForBlock(block) {
    const group = block && block.closest ? block.closest('.tool-trace-group') : null;
    let relPath = block ? (block.getAttribute('data-diff-rel-path') || '') : '';
    const row = block ? block.querySelector('.tool-action') : null;
    if (!relPath && row) {
      const detailEl = row.querySelector('.tool-detail');
      if (detailEl && detailEl.textContent) relPath = detailEl.textContent.trim();
    }
    if (!relPath && group) {
      const msgId = group.getAttribute('data-agent-msg-id') || '';
      const traceIdx = getTraceIndexForBlock(block, group);
      const traces = msgId && window.ChatSession && window.ChatSession.getToolTraces
        ? (window.ChatSession.getToolTraces()[msgId] || [])
        : [];
      if (traceIdx >= 0 && traces[traceIdx] && traces[traceIdx].detail) {
        relPath = traces[traceIdx].detail;
      }
    }
    return relPath;
  }

  function fetchToolDiffFromServer(block, toolName, toolCallId, done) {
    const sid = getActiveSessionIdForApi();
    const relPath = resolveDiffRelPathForBlock(block);
    if (!shouldFetchToolDiffFromServer(toolName, relPath, block)) {
      if (done) done(null);
      return;
    }
    function doFetch(workspaceRoot) {
      let qs = `?toolName=${encodeURIComponent(toolName || 'write_file')}`;
      if (toolCallId) qs += `&toolCallId=${encodeURIComponent(toolCallId)}`;
      if (relPath) qs += `&path=${encodeURIComponent(relPath)}`;
      if (workspaceRoot) qs += `&workspaceRoot=${encodeURIComponent(workspaceRoot)}`;
      fetch(`/api/sessions/${encodeURIComponent(sid)}/tool-diff${qs}`, { cache: 'no-store' })
        .then((res) => {
          if (!res.ok) throw new Error('not found');
          return res.json();
        })
        .then((data) => {
          if (data && data.diffSource) {
            block._diffSource = data.diffSource;
            done(data.diffSource);
          } else {
            done(null);
          }
        })
        .catch(() => { done(null); });
    }
    getSessionWorkspaceRoot(doFetch);
  }

  function getStructuredMessagesLocal() {
    return window.ChatSession && window.ChatSession.getStructuredMessages
      ? window.ChatSession.getStructuredMessages()
      : [];
  }

  function extractDiffFromStructuredToolOutput(toolName, toolCallId) {
    if (!toolCallId || !toolName || !window.ToolDisplayHistory
        || typeof window.ToolDisplayHistory.extractDiffSource !== 'function') {
      return null;
    }
    const structured = getStructuredMessagesLocal();
    for (let i = 0; i < structured.length; i++) {
      const sm = structured[i];
      if (!sm || sm.role !== 'tool' || sm.toolCallId !== toolCallId) continue;
      if (typeof sm.content !== 'string') continue;
      const ds = window.ToolDisplayHistory.extractDiffSource(toolName, sm.content, null);
      if (ds) return ds;
    }
    return null;
  }

  function collectToolBlocksInTraceOrder(group) {
    const out = [];
    if (!group) return out;
    const collapsed = group.querySelector('.tool-trace-collapsed');
    const visible = group.querySelector('.tool-trace-visible');
    if (collapsed) {
      for (let c = 0; c < collapsed.children.length; c++) {
        if (isToolRowBlock(collapsed.children[c])) out.push(collapsed.children[c]);
      }
    }
    if (visible) {
      for (let v = 0; v < visible.children.length; v++) {
        if (isToolRowBlock(visible.children[v])) out.push(visible.children[v]);
      }
    }
    return out;
  }

  function getTraceIndexForBlock(block, group) {
    if (!block) return -1;
    const attr = block.getAttribute('data-trace-idx');
    if (attr !== null && attr !== '') {
      const parsed = parseInt(attr, 10);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    if (!group) return -1;
    const blocks = collectToolBlocksInTraceOrder(group);
    for (let bi = 0; bi < blocks.length; bi++) {
      if (blocks[bi] === block) return bi;
    }
    return -1;
  }

  function resolveDiffSourceForHistoryBlock(block, group) {
    if (!block) return null;
    if (block._diffSource) return block._diffSource;

    const row = block.querySelector('.tool-action');
    const toolName = row ? row.getAttribute('data-tool') : '';
    const toolCallId = block.getAttribute('data-tool-call-id') || '';
    const msgId = group ? (group.getAttribute('data-agent-msg-id') || '') : '';
    const traceIdx = getTraceIndexForBlock(block, group);

    if (msgId && traceIdx >= 0 && historyDisplayMapCache && historyDisplayMapCache[msgId]) {
      const cachedDisp = historyDisplayMapCache[msgId][traceIdx];
      if (cachedDisp && cachedDisp.diffSource) return cachedDisp.diffSource;
    }

    const diffIndex = getToolCallDiffIndex();
    const traces = msgId && window.ChatSession && typeof window.ChatSession.getToolTraces === 'function'
      ? (window.ChatSession.getToolTraces()[msgId] || [])
      : [];
    const tr = traceIdx >= 0 && traces[traceIdx] ? traces[traceIdx] : null;

    if (toolCallId && diffIndex && diffIndex[toolCallId]) return diffIndex[toolCallId];

    let fromOutput = extractDiffFromStructuredToolOutput(toolName, toolCallId);
    if (fromOutput) return fromOutput;

    if (tr) {
      if (tr.diffSource) return tr.diffSource;
      fromOutput = extractDiffFromStructuredToolOutput(
        tr.toolName || toolName,
        tr.toolCallId || toolCallId,
      );
      if (fromOutput) return fromOutput;
    }

    return null;
  }

  function primeHistoryDiffSource(block, group) {
    if (!block || block._diffSource || block.getAttribute('data-has-diff') === '1') return;
    const row = block.querySelector('.tool-action');
    const toolName = row ? row.getAttribute('data-tool') : '';
    if (!toolName || !isDiffCapableToolName(toolName)) return;
    const ds = resolveDiffSourceForHistoryBlock(block, group);
    if (ds) block._diffSource = ds;
    bindDiffToggleRow(block, toolName, true);
  }

  function primeHistoryDiffSourcesInGroup(group) {
    if (!group || !isNodeInHistoryRegion(group)) return;
    const blocks = collectToolBlocksInTraceOrder(group);
    for (let i = 0; i < blocks.length; i++) {
      primeHistoryDiffSource(blocks[i], group);
    }
  }

  function notifyTailLayoutChange() {
    if (!autoScrollEnabled) return;
    scheduleScrollIfSticky();
  }

  function cancelStickyScroll() {
    if (!scrollRafId) return;
    cancelAnimationFrame(scrollRafId);
    scrollRafId = 0;
  }

  /** 用户上滚/拖拽时立即脱离贴底，避免流式增高在 suppressScrollSync 期间抢回滚动条 */
  function pinScrollAwayFromBottom() {
    cancelStickyScroll();
    userPinnedScroll = true;
    autoScrollEnabled = false;
    updateFollowBottomClass();
    updateJumpBottomButton();
  }

  function setupScrollIntentListeners() {
    if (!elMessages || elMessages._scrollIntentBound) return;
    elMessages._scrollIntentBound = true;
    elMessages.addEventListener('wheel', (e) => {
      if (e.deltaY < 0) pinScrollAwayFromBottom();
    }, { passive: true });
    let touchStartY = 0;
    elMessages.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 1) touchStartY = e.touches[0].clientY;
    }, { passive: true });
    elMessages.addEventListener('touchmove', (e) => {
      if (!e.touches || e.touches.length !== 1) return;
      if (e.touches[0].clientY - touchStartY > 8) pinScrollAwayFromBottom();
    }, { passive: true });
  }

  function notifyHistoryLayoutChange(originNode) {
    if (originNode && virtualScroller && typeof virtualScroller.invalidateHeight === 'function') {
      const slot = originNode.closest ? originNode.closest('.chat-vhistory-slot[data-vkey]') : null;
      if (slot) {
        const vkey = slot.getAttribute('data-vkey') || '';
        if (vkey) virtualScroller.invalidateHeight(vkey);
      }
    }
    if (virtualScroller && typeof virtualScroller.remeasureLayout === 'function') {
      virtualScroller.remeasureLayout();
    } else if (virtualScroller) {
      virtualScroller.refresh();
    }
    scheduleScrollIfSticky();
  }

  function insertTailBefore(el) {
    if (!el || !elTailRoot || !elTailAnchor) return;
    elTailRoot.insertBefore(el, elTailAnchor);
  }

  function clearTailDom() {
    if (!elTailRoot || !elTailAnchor) return;
    while (elTailRoot.firstChild !== elTailAnchor) {
      elTailRoot.removeChild(elTailRoot.firstChild);
    }
  }

  function renderHistoryUnit(unit, slot) {
    if (!unit || !slot) return;
    if (unit.type === 'message' && unit.msg) {
      slot.appendChild(createMessageEl(unit.msg, lastStripStatusTagFn, unit.msgIndex));
      return;
    }
    if (unit.type === 'tools' && unit.traces && unit.traces.length > 0) {
      slot.appendChild(buildToolTraceGroupElement(unit.traces, unit.displays || [], {
        forHistory: true,
        agentMsgId: unit.msgId || '',
      }));
    }
  }

  function onVirtualHistoryScroll() {
    if (virtualScroller) virtualScroller.handleScroll();
  }

  function distanceFromBottom() {
    if (!elMessages) return 0;
    return elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight;
  }

  function isNearBottom() {
    return distanceFromBottom() < SCROLL_STICKY_THRESHOLD_PX;
  }

  function syncAutoScrollFromViewport() {
    const dist = distanceFromBottom();
    if (dist > SCROLL_STICKY_THRESHOLD_PX) {
      userPinnedScroll = true;
    } else if (dist <= 4) {
      userPinnedScroll = false;
    }
    if (userPinnedScroll) {
      autoScrollEnabled = false;
    } else {
      autoScrollEnabled = dist < SCROLL_STICKY_THRESHOLD_PX;
    }
    updateFollowBottomClass();
    updateJumpBottomButton();
  }

  function updateJumpBottomButton() {
    if (!elJumpBottom) return;
    if (autoScrollEnabled) {
      elJumpBottom.classList.add('hidden');
    } else {
      elJumpBottom.classList.remove('hidden');
    }
  }

  function getMaxScrollTop() {
    if (!elMessages) return 0;
    return Math.max(0, elMessages.scrollHeight - elMessages.clientHeight);
  }

  function applyScrollToBottom() {
    if (!elMessages) return;
    elMessages.scrollTop = getMaxScrollTop();
    if (elAnchor && typeof elAnchor.scrollIntoView === 'function') {
      try {
        elAnchor.scrollIntoView({ block: 'end', inline: 'nearest' });
      } catch (_e) { /* ignore */ }
    }
    elMessages.scrollTop = getMaxScrollTop();
  }

  function onMessagesScroll() {
    if (suppressScrollSync) return;
    syncAutoScrollFromViewport();
    onVirtualHistoryScroll();
    if (window.ChatStaircaseNav && typeof window.ChatStaircaseNav.notifyScrollSync === 'function') {
      window.ChatStaircaseNav.notifyScrollSync();
    }
  }

  function scrollToBottom(force) {
    if (!elMessages) return;
    if (force !== true && !autoScrollEnabled) return;
    if (force === true) {
      userPinnedScroll = false;
      autoScrollEnabled = true;
      updateFollowBottomClass();
    }
    suppressScrollSync = true;

    function runPass() {
      if (virtualScroller && typeof virtualScroller.remeasureLayout === 'function') {
        virtualScroller.remeasureLayout();
      }
      applyScrollToBottom();
    }

    runPass();
    requestAnimationFrame(() => {
      runPass();
      requestAnimationFrame(() => {
        runPass();
        setTimeout(() => {
          runPass();
          suppressScrollSync = false;
          if (force === true) {
            autoScrollEnabled = true;
            userPinnedScroll = false;
          }
          updateFollowBottomClass();
          updateJumpBottomButton();
        }, 0);
      });
    });
  }

  /** 用户发送等场景：强制恢复贴底并滚到底 */
  function enableAutoScroll() {
    userPinnedScroll = false;
    autoScrollEnabled = true;
    updateFollowBottomClass();
    scrollToBottom(true);
  }

  function scheduleScrollIfSticky() {
    if (!elMessages) return;
    if (userPinnedScroll || (!autoScrollEnabled && !isNearBottom())) {
      updateJumpBottomButton();
      return;
    }
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = 0;
      if (!elMessages) return;
      if (userPinnedScroll || (!autoScrollEnabled && !isNearBottom())) {
        updateJumpBottomButton();
        return;
      }
      suppressScrollSync = true;
      applyScrollToBottom();
      requestAnimationFrame(() => {
        if (!elMessages) return;
        if (userPinnedScroll) {
          suppressScrollSync = false;
          updateJumpBottomButton();
          return;
        }
        applyScrollToBottom();
        suppressScrollSync = false;
        syncAutoScrollFromViewport();
      });
    });
  }

  function ensureJumpBottomButton() {
    if (elJumpBottom || !elMessages) return;
    const host = elMessages.parentElement;
    if (!host) return;
    elJumpBottom = document.createElement('button');
    elJumpBottom.type = 'button';
    elJumpBottom.className = 'chat-jump-bottom hidden';
    elJumpBottom.setAttribute('aria-label', '回到底部');
    elJumpBottom.title = '回到底部';
    elJumpBottom.innerHTML = '<span class="chat-jump-bottom-icon" aria-hidden="true">↓</span>';
    elJumpBottom.addEventListener('click', () => {
      enableAutoScroll();
    });
    host.appendChild(elJumpBottom);
  }

  function setupContentResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || !elMessages || contentResizeObserver) return;
    contentResizeObserver = new ResizeObserver(() => {
      if (userPinnedScroll || (!autoScrollEnabled && !isNearBottom())) return;
      scheduleScrollIfSticky();
    });
    contentResizeObserver.observe(elMessages);
  }

  /** tail / 历史区增高时（新消息、图片、虚拟历史 remeasure）跟随贴底 */
  function setupTailResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || tailResizeObserver) return;
    tailResizeObserver = new ResizeObserver(() => {
      if (userPinnedScroll || !autoScrollEnabled) return;
      scheduleScrollIfSticky();
    });
    if (elTailRoot) tailResizeObserver.observe(elTailRoot);
    if (elHistoryOuter) tailResizeObserver.observe(elHistoryOuter);
  }

  function ensureTailResizeObserver() {
    if (!tailResizeObserver) setupTailResizeObserver();
    else if (elTailRoot && tailResizeObserver) {
      try { tailResizeObserver.observe(elTailRoot); } catch (_e) { /* already observing */ }
      if (elHistoryOuter) {
        try { tailResizeObserver.observe(elHistoryOuter); } catch (_e2) { /* ignore */ }
      }
    }
  }

  function notifyContentLayoutChange() {
    notifyTailLayoutChange();
  }

  function ensureDiffOutsideClose() {
    if (diffOutsideCloseBound) return;
    diffOutsideCloseBound = true;
    document.addEventListener('click', (e) => {
      if (!elMessages) return;
      if (!elMessages.querySelector('.tool-diff-wrap.is-open')) return;
      const target = e.target;
      if (target.closest && target.closest('.tool-diff-wrap.is-open')) return;
      if (target.closest && target.closest('.tool-name.tool-diff-toggle')) return;
      closeAllDiffPanels(null);
    });
  }

  function getMaxInputHeight() {
    if (!elInput) return 220;
    const maxH = parseFloat(window.getComputedStyle(elInput).maxHeight);
    return isFinite(maxH) && maxH > 0 ? maxH : 220;
  }

  function syncComposerStackHeight() {
    const main = elMessages && elMessages.parentElement;
    const inputArea = main ? main.querySelector('.chat-input-area') : null;
    if (!main || !inputArea) return;
    const h = Math.ceil(inputArea.getBoundingClientRect().height);
    if (h > 0) main.style.setProperty('--chat-composer-stack-height', `${h}px`);
    try {
      document.dispatchEvent(new CustomEvent('ice:composer-layout'));
    } catch (_e) { /* ignore */ }
  }

  function setupComposerResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || composerResizeObserver) return;
    const main = elMessages && elMessages.parentElement;
    const inputArea = main ? main.querySelector('.chat-input-area') : null;
    if (!inputArea || !main) return;
    composerResizeObserver = new ResizeObserver(() => {
      syncComposerStackHeight();
    });
    composerResizeObserver.observe(inputArea);
    syncComposerStackHeight();
  }

  function supportsFieldSizing() {
    try {
      return !!(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));
    } catch (_e) {
      return false;
    }
  }

  function autoResizeInput() {
    if (!elInput) return;
    if (!supportsFieldSizing()) {
      const maxH = getMaxInputHeight();
      const minH = 56;
      elInput.style.height = 'auto';
      const scrollH = elInput.scrollHeight;
      const next = Math.min(Math.max(scrollH, minH), maxH);
      elInput.style.height = `${next}px`;
    }
    elInput.style.overflowY = 'auto';
    syncComposerStackHeight();
  }

  // ---- 工具调用行 ----

  function iconTextForStatus(status) {
    if (status === 'success') return '✓';
    if (status === 'error') return '✗';
    if (status === 'warn') return '⚠';
    if (status === 'background') return '→';
    return '';
  }

  function createToolActionRow(toolName, detail, status, toolCallId) {
    const el = document.createElement('div');
    el.className = 'tool-action';
    el.setAttribute('data-tool', toolName);
    if (toolCallId) el.setAttribute('data-tool-call-id', toolCallId);

    const iconEl = document.createElement('span');
    iconEl.className = 'tool-icon ' + (status || 'pending');
    iconEl.textContent = iconTextForStatus(status || 'pending');
    el.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = toolName;
    el.appendChild(nameEl);

    if (detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'tool-detail';
      detailEl.textContent = detail;
      el.appendChild(detailEl);
    }
    return el;
  }

  function isDiffCapableToolName(toolName) {
    if (window.ToolDisplayHistory && typeof window.ToolDisplayHistory.isDiffCapableTool === 'function') {
      return window.ToolDisplayHistory.isDiffCapableTool(toolName);
    }
    return false;
  }

  function hideDiffWrap(wrap, block) {
    if (!wrap) return;
    wrap.classList.add('is-hidden');
    wrap.classList.remove('is-open');
    if (block) {
      const nameEl = block.querySelector('.tool-action .tool-name');
      if (nameEl) nameEl.classList.remove('is-diff-open');
    }
  }

  function closeAllDiffPanels(exceptBlock) {
    if (!elMessages) return;
    const openWraps = elMessages.querySelectorAll('.tool-diff-wrap.is-open');
    for (let i = 0; i < openWraps.length; i++) {
      const wrap = openWraps[i];
      const block = wrap.closest('.tool-action-row-block');
      if (block !== exceptBlock) hideDiffWrap(wrap, block);
    }
  }

  function showDiffWrap(wrap, block) {
    if (!wrap || !block) return;
    closeAllDiffPanels(block);
    wrap.classList.remove('is-hidden');
    wrap.classList.add('is-open');
    const nameEl = block.querySelector('.tool-action .tool-name');
    if (nameEl) nameEl.classList.add('is-diff-open');
  }

  function renderDiffElementFromSource(diffSource) {
    if (!diffSource) return null;
    let diffEl = null;
    if (window.ToolDisplayHistory && typeof window.ToolDisplayHistory.renderDiffElement === 'function') {
      diffEl = window.ToolDisplayHistory.renderDiffElement(diffSource);
    }
    if (!diffEl && window.DiffViewer && typeof DiffViewer.renderFromText === 'function') {
      diffEl = DiffViewer.renderFromText(diffSource, { compact: true });
    }
    return diffEl;
  }

  function wrapDiffWithPanel(diffEl) {
    const panel = document.createElement('div');
    panel.className = 'tool-diff-panel';
    panel.appendChild(diffEl);
    return panel;
  }

  /** 挂载 diff 内容但默认隐藏 */
  function mountHiddenDiffInBlock(block, diffSource) {
    if (!block || !diffSource) return false;
    const diffEl = renderDiffElementFromSource(diffSource);
    if (!diffEl) return false;

    block.setAttribute('data-has-diff', '1');
    block._diffSource = diffSource;

    let wrap = block.querySelector('.tool-diff-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'tool-diff-wrap is-hidden';
      block.appendChild(wrap);
    } else {
      hideDiffWrap(wrap, block);
      wrap.innerHTML = '';
    }
    wrap.appendChild(wrapDiffWithPanel(diffEl));
    return true;
  }

  function lookupDiffSourceForBlock(block, toolName) {
    if (!block) return null;
    if (block._diffSource) return block._diffSource;
    if (isNodeInHistoryRegion(block)) {
      const group = block.closest('.tool-trace-group');
      return resolveDiffSourceForHistoryBlock(block, group);
    }
    const toolCallId = block.getAttribute('data-tool-call-id') || '';
    if (!window.ToolDisplayHistory) return null;
    if (toolCallId) {
      const diffIndex = getToolCallDiffIndex();
      if (diffIndex && diffIndex[toolCallId]) return diffIndex[toolCallId];
      const fromOutput = extractDiffFromStructuredToolOutput(toolName, toolCallId);
      if (fromOutput) return fromOutput;
    }
    const structured = getStructuredMessagesLocal();
    if (toolCallId && structured.length > 0
        && typeof window.ToolDisplayHistory.flattenStructuredToolEntries === 'function') {
      const flat = window.ToolDisplayHistory.flattenStructuredToolEntries(structured);
      for (let i = 0; i < flat.length; i++) {
        if (flat[i].toolCallId === toolCallId && flat[i].diffSource) return flat[i].diffSource;
      }
    }
    return null;
  }

  function tryLazyMountDiffForBlock(block, toolName, done) {
    if (!block || block.getAttribute('data-has-diff') === '1') {
      if (done) done(true);
      return;
    }
    const toolCallId = block.getAttribute('data-tool-call-id') || '';

    function finishMounted(ds) {
      if (!ds || !mountHiddenDiffInBlock(block, ds)) {
        if (ds) delete block._diffSource;
        return false;
      }
      const nameEl = block.querySelector('.tool-action .tool-name');
      if (nameEl) {
        nameEl.classList.add('tool-diff-toggle');
        nameEl.classList.remove('tool-diff-toggle-pending');
        nameEl.setAttribute('title', '点击查看/关闭文件变更');
      }
      if (isNodeInHistoryRegion(block)) notifyHistoryLayoutChange(block);
      else notifyTailLayoutChange();
      if (done) done(true);
      return true;
    }

    function fetchFromApi(thenFn) {
      fetchToolDiffFromServer(block, toolName, toolCallId, (fromApi) => {
        if (finishMounted(fromApi)) return;
        if (thenFn) thenFn();
        else if (done) done(false);
      });
    }

    function afterStructuredFetch() {
      const retry = lookupDiffSourceForBlock(block, toolName);
      if (finishMounted(retry)) return;
      const relPath = resolveDiffRelPathForBlock(block);
      if (!shouldFetchToolDiffFromServer(toolName, relPath, block)) {
        if (done) done(false);
        return;
      }
      fetchFromApi(() => { if (done) done(false); });
    }

    function fetchStructuredThenTryApi() {
      if (!window.ChatSession || typeof window.ChatSession.fetchStructuredMessages !== 'function') {
        afterStructuredFetch();
        return;
      }
      window.ChatSession.fetchStructuredMessages((structured) => {
        if (structured.length > 0 && window.ToolDisplayHistory
            && typeof window.ToolDisplayHistory.buildToolCallDiffIndex === 'function') {
          const index = window.ToolDisplayHistory.buildToolCallDiffIndex(structured);
          cachedToolCallDiffIndex = { ...index, ...(cachedTraceDiffIndex || {}) };
          cachedToolCallDiffIndexRef = structured;
          if (toolCallId && index[toolCallId] && finishMounted(index[toolCallId])) return;
        }
        afterStructuredFetch();
      });
    }

    const resolved = lookupDiffSourceForBlock(block, toolName);
    if (finishMounted(resolved)) return;

    fetchStructuredThenTryApi();
  }

  function toggleDiffPanelForBlock(block) {
    const wrap = block.querySelector('.tool-diff-wrap');
    if (!wrap) return;
    if (wrap.classList.contains('is-open')) {
      hideDiffWrap(wrap, block);
    } else {
      showDiffWrap(wrap, block);
    }
    if (isNodeInHistoryRegion(block)) notifyHistoryLayoutChange(block);
    else notifyTailLayoutChange();
  }

  function bindDiffToggleRow(block, toolName, forHistory) {
    if (!isDiffCapableToolName(toolName)) return;
    const nameEl = block.querySelector('.tool-action .tool-name');
    if (!nameEl) return;

    nameEl.classList.add('tool-diff-toggle');
    if (block.getAttribute('data-has-diff') === '1') {
      nameEl.classList.remove('tool-diff-toggle-pending');
      nameEl.setAttribute('title', '点击查看/关闭文件变更');
    } else if (block._diffSource) {
      nameEl.classList.remove('tool-diff-toggle-pending');
      nameEl.setAttribute('title', '点击查看文件变更');
    } else {
      nameEl.classList.add('tool-diff-toggle-pending');
      nameEl.setAttribute('title', '点击加载文件变更');
    }

    if (forHistory || isNodeInHistoryRegion(block)) return;

    if (nameEl.getAttribute('data-diff-toggle-bound') === '1') return;
    nameEl.setAttribute('data-diff-toggle-bound', '1');
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (block.getAttribute('data-has-diff') === '1') {
        toggleDiffPanelForBlock(block);
        return;
      }
      tryLazyMountDiffForBlock(block, toolName, (ok) => {
        if (ok) toggleDiffPanelForBlock(block);
      });
    });
  }

  /** 历史重绘后：按 toolCallId 补挂 structured / tool_trace 中的 diff */
  function queryToolRowBlocks(toolCallId) {
    const escaped = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(toolCallId)
      : toolCallId.replace(/"/g, '\\"');
    const sel = `.tool-action-row-block[data-tool-call-id="${escaped}"]`;
    const out = [];
    if (elTailRoot) {
      const tailBlocks = elTailRoot.querySelectorAll(sel);
      for (let t = 0; t < tailBlocks.length; t++) out.push(tailBlocks[t]);
    }
    if (elHistoryWindow) {
      const histBlocks = elHistoryWindow.querySelectorAll(sel);
      for (let h = 0; h < histBlocks.length; h++) out.push(histBlocks[h]);
    }
    if (!out.length && elMessages) {
      const fallback = elMessages.querySelectorAll(sel);
      for (let f = 0; f < fallback.length; f++) out.push(fallback[f]);
    }
    return out;
  }

  function repairMissingDiffMounts(diffByCallId) {
    if (!diffByCallId) return;
    const blocks = elMessages
      ? elMessages.querySelectorAll('.tool-action-row-block[data-tool-call-id]')
      : [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.getAttribute('data-has-diff') === '1') continue;
      const toolCallId = block.getAttribute('data-tool-call-id') || '';
      const diffSource = diffByCallId[toolCallId];
      if (!diffSource) continue;
      const row = block.querySelector('.tool-action');
      const toolName = row ? row.getAttribute('data-tool') : '';
      if (!toolName || !isDiffCapableToolName(toolName)) continue;
      if (isNodeInHistoryRegion(block)) {
        block._diffSource = diffSource;
        bindDiffToggleRow(block, toolName, true);
      } else if (mountHiddenDiffInBlock(block, diffSource)) {
        bindDiffToggleRow(block, toolName, false);
      }
    }
  }

  function appendDiffToRowBlock(block, diffEl) {
    if (!block || !diffEl) return;
    let wrap = block.querySelector('.tool-diff-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'tool-diff-wrap is-hidden';
      block.appendChild(wrap);
    } else {
      hideDiffWrap(wrap, block);
      wrap.innerHTML = '';
    }
    wrap.appendChild(wrapDiffWithPanel(diffEl));
    block.setAttribute('data-has-diff', '1');
    const row = block.querySelector('.tool-action');
    const toolName = row ? row.getAttribute('data-tool') : '';
    bindDiffToggleRow(block, toolName || '');
    if (isNodeInHistoryRegion(block)) notifyHistoryLayoutChange(block);
    else notifyTailLayoutChange();
  }

  function createToolRowBlock(toolName, detail, status, toolCallId, diffSource, forHistory) {
    const block = document.createElement('div');
    block.className = 'tool-action-row-block';
    if (toolCallId) block.setAttribute('data-tool-call-id', toolCallId);

    const row = createToolActionRow(toolName, detail, status, toolCallId);
    block.appendChild(row);

    if (diffSource) {
      if (forHistory) {
        block._diffSource = diffSource;
      } else {
        mountHiddenDiffInBlock(block, diffSource);
      }
    }
    bindDiffToggleRow(block, toolName, forHistory);
    return block;
  }

  function isToolRowBlock(node) {
    return node && node.nodeType === 1 && node.classList && node.classList.contains('tool-action-row-block');
  }

  function isToolTraceContainer(node) {
    return node && node.nodeType === 1 && node.classList && (
      node.classList.contains('tool-action')
      || node.classList.contains('tool-action-row-block')
      || node.classList.contains('tool-trace-group')
    );
  }

  function bindToolTraceToggle(btn, collapsedEl, groupEl, forHistory) {
    if (forHistory) {
      btn.setAttribute('aria-expanded', 'false');
      return;
    }
    const group = groupEl || (btn.closest ? btn.closest('.tool-trace-group') : null);
    if (btn.getAttribute('data-trace-toggle-bound') === '1') return;
    btn.setAttribute('data-trace-toggle-bound', '1');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        collapsedEl.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = `还有 ${collapsedEl.children.length} 条历史 · 展开`;
      } else {
        collapsedEl.style.display = '';
        btn.setAttribute('aria-expanded', 'true');
        btn.textContent = '收起';
      }
      notifyTailLayoutChange();
    });
    btn.setAttribute('aria-expanded', 'false');
  }

  function refreshCollapsedToggleLabel(btn, collapsedEl) {
    if (!btn || !collapsedEl || collapsedEl.children.length === 0) return;
    btn.textContent = btn.getAttribute('aria-expanded') === 'true' ? '收起' : `还有 ${collapsedEl.children.length} 条历史 · 展开`;
  }

  function rebalanceToolTraceVisible(visibleEl, collapsedEl, toggleEl) {
    if (!visibleEl || !collapsedEl) return;
    while (visibleEl.children.length > TOOL_TRACE_VISIBLE_MAX) {
      const oldest = visibleEl.firstChild;
      if (oldest) collapsedEl.appendChild(oldest);
    }
    if (!toggleEl) return;
    if (collapsedEl.children.length > 0) {
      toggleEl.style.display = '';
      refreshCollapsedToggleLabel(toggleEl, collapsedEl);
    } else {
      toggleEl.style.display = 'none';
      toggleEl.setAttribute('aria-expanded', 'false');
    }
  }

  /** 清掉尾部区 anchor 前连续的平铺工具行 / 工具组（F5 还原或新一轮发送前） */
  function clearTrailingToolDomBeforeAnchor() {
    if (!elTailRoot || !elTailAnchor) return;
    let node = elTailAnchor.previousElementSibling;
    while (node) {
      if (node.id === 'streaming-msg' || node.id === 'streaming-reasoning-msg') {
        node = node.previousElementSibling;
        continue;
      }
      if (node.classList && isToolTraceContainer(node)) {
        const rm = node;
        node = node.previousElementSibling;
        rm.parentNode.removeChild(rm);
        continue;
      }
      break;
    }
  }

  /** 把尾部 anchor 前平铺的 tool-action 收进 live 折叠组 */
  function coalesceFlatToolActionsBeforeAnchor() {
    if (!elTailRoot || !elTailAnchor) return;
    const flats = [];
    let node = elTailAnchor.previousElementSibling;
    while (node) {
      if (node.id === 'streaming-msg' || node.id === 'streaming-reasoning-msg') {
        node = node.previousElementSibling;
        continue;
      }
      if (node.classList && (node.classList.contains('tool-action') || isToolRowBlock(node))) {
        flats.unshift(node);
        node = node.previousElementSibling;
        continue;
      }
      break;
    }
    if (flats.length === 0) return;
    liveToolRoundActive = true;
    adoptOrCreateLiveToolGroupDom();
    for (let i = 0; i < flats.length; i++) {
      liveToolRoundVisible.appendChild(flats[i]);
    }
    rebalanceToolTraceVisible(liveToolRoundVisible, liveToolRoundCollapsed, liveToolRoundToggle);
  }

  function buildToolTraceGroupElement(traces, displays, opts) {
    if (!traces || traces.length === 0) return null;
    displays = displays || [];
    opts = opts || {};
    const forHistory = !!opts.forHistory;

    function appendTraceRow(parent, tr, idx) {
      const disp = displays[idx];
      let diffSource = (tr.diffSource) || (disp && disp.diffSource) || null;
      const toolCallId = tr.toolCallId || '';
      if (!diffSource && toolCallId) {
        diffSource = extractDiffFromStructuredToolOutput(tr.toolName || '', toolCallId);
      }
      const block = createToolRowBlock(
        tr.toolName || '',
        tr.detail || '',
        tr.status || 'pending',
        toolCallId,
        diffSource,
        forHistory,
      );
      block.setAttribute('data-trace-idx', String(idx));
      if (forHistory && tr.detail) {
        block.setAttribute('data-diff-rel-path', tr.detail);
      }
      parent.appendChild(block);
    }

    const wrap = document.createElement('div');
    wrap.className = 'tool-trace-group';
    if (opts.agentMsgId) wrap.setAttribute('data-agent-msg-id', opts.agentMsgId);
    const visible = document.createElement('div');
    visible.className = 'tool-trace-visible';

    const max = TOOL_TRACE_VISIBLE_MAX;
    if (traces.length <= max) {
      for (let i = 0; i < traces.length; i++) {
        appendTraceRow(visible, traces[i], i);
      }
      wrap.appendChild(visible);
      return wrap;
    }

    const olderCount = traces.length - max;
    const collapsed = document.createElement('div');
    collapsed.className = 'tool-trace-collapsed';
    collapsed.style.display = 'none';
    for (let j = 0; j < olderCount; j++) {
      appendTraceRow(collapsed, traces[j], j);
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-trace-toggle';
    toggle.textContent = `还有 ${olderCount} 条历史 · 展开`;

    for (let k = olderCount; k < traces.length; k++) {
      appendTraceRow(visible, traces[k], k);
    }

    wrap.appendChild(collapsed);
    wrap.appendChild(toggle);
    wrap.appendChild(visible);
    bindToolTraceToggle(toggle, collapsed, wrap, forHistory);
    return wrap;
  }

  function insertFoldableToolTraceGroup(traces, displays, agentMsgId) {
    const wrap = buildToolTraceGroupElement(traces, displays, {
      agentMsgId: agentMsgId || '',
    });
    if (wrap) insertTailBefore(wrap);
  }

  function adoptOrCreateLiveToolGroupDom() {
    if (liveToolRoundRoot) {
      rebalanceToolTraceVisible(liveToolRoundVisible, liveToolRoundCollapsed, liveToolRoundToggle);
      return;
    }
    let prev = elTailAnchor ? elTailAnchor.previousElementSibling : null;
    while (prev && (prev.id === 'streaming-msg' || prev.id === 'streaming-reasoning-msg')) {
      prev = prev.previousElementSibling;
    }
    if (prev && prev.classList && prev.classList.contains('tool-trace-group')) {
      liveToolRoundRoot = prev;
      liveToolRoundCollapsed = prev.querySelector('.tool-trace-collapsed');
      liveToolRoundToggle = prev.querySelector('.tool-trace-toggle');
      liveToolRoundVisible = prev.querySelector('.tool-trace-visible');
      if (liveToolRoundCollapsed && liveToolRoundVisible && liveToolRoundToggle) {
        rebalanceToolTraceVisible(liveToolRoundVisible, liveToolRoundCollapsed, liveToolRoundToggle);
        return;
      }
      liveToolRoundRoot = null;
      liveToolRoundCollapsed = null;
      liveToolRoundToggle = null;
      liveToolRoundVisible = null;
    }
    liveToolRoundRoot = document.createElement('div');
    liveToolRoundRoot.className = 'tool-trace-group';
    liveToolRoundCollapsed = document.createElement('div');
    liveToolRoundCollapsed.className = 'tool-trace-collapsed';
    liveToolRoundCollapsed.style.display = 'none';
    liveToolRoundToggle = document.createElement('button');
    liveToolRoundToggle.type = 'button';
    liveToolRoundToggle.className = 'tool-trace-toggle';
    liveToolRoundToggle.style.display = 'none';
    liveToolRoundVisible = document.createElement('div');
    liveToolRoundVisible.className = 'tool-trace-visible';
    liveToolRoundRoot.appendChild(liveToolRoundCollapsed);
    liveToolRoundRoot.appendChild(liveToolRoundToggle);
    liveToolRoundRoot.appendChild(liveToolRoundVisible);
    bindToolTraceToggle(liveToolRoundToggle, liveToolRoundCollapsed, liveToolRoundRoot, false);
    insertTailBefore(liveToolRoundRoot);
  }

  function appendToolAction(toolName, detail, status, toolCallId, diffSource) {
    ensureChatLayout();
    if (!elTailRoot) return null;
    coalesceFlatToolActionsBeforeAnchor();
    const block = createToolRowBlock(toolName, detail, status || 'pending', toolCallId || '', diffSource || null);

    if (liveToolRoundActive) {
      adoptOrCreateLiveToolGroupDom();
      liveToolRoundCount++;
      liveToolRoundVisible.appendChild(block);
      rebalanceToolTraceVisible(liveToolRoundVisible, liveToolRoundCollapsed, liveToolRoundToggle);
      notifyContentLayoutChange();
      return block;
    }

    insertTailBefore(block);
    notifyContentLayoutChange();
    return block;
  }

  /** 批量还原 / 竞态修复后，重新折叠 live 工具区 */
  function repairLiveToolGroupFold() {
    coalesceFlatToolActionsBeforeAnchor();
    if (liveToolRoundRoot && liveToolRoundVisible && liveToolRoundCollapsed) {
      rebalanceToolTraceVisible(liveToolRoundVisible, liveToolRoundCollapsed, liveToolRoundToggle);
      notifyContentLayoutChange();
    }
  }

  function findToolRowBlockByCallId(toolCallId) {
    if (!toolCallId) return null;
    const blocks = queryToolRowBlocks(toolCallId);
    if (blocks.length > 0) return blocks[blocks.length - 1];
    return null;
  }

  function revealCollapsedToolTrace(block) {
    if (!block || !block.closest) return;
    const collapsed = block.closest('.tool-trace-collapsed');
    if (!collapsed || collapsed.style.display !== 'none') return;
    collapsed.style.display = '';
    const group = collapsed.closest('.tool-trace-group');
    const btn = group && group.querySelector('.tool-trace-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.textContent = '收起';
    }
    if (group && isNodeInHistoryRegion(group)) {
      primeHistoryDiffSourcesInGroup(group);
      notifyHistoryLayoutChange(group);
    }
  }

  function stopPinnedToolScrollWatch() {
    if (toolScrollFinishTimer) {
      clearTimeout(toolScrollFinishTimer);
      toolScrollFinishTimer = 0;
    }
    if (toolScrollEndHandler && elMessages) {
      elMessages.removeEventListener('scrollend', toolScrollEndHandler);
      toolScrollEndHandler = null;
    }
  }

  function finishPinnedToolScroll(gen) {
    if (gen !== toolScrollGen) return;
    stopPinnedToolScrollWatch();
    userPinnedScroll = true;
    autoScrollEnabled = false;
    updateFollowBottomClass();
    updateJumpBottomButton();
    requestAnimationFrame(() => {
      if (gen !== toolScrollGen) return;
      suppressScrollSync = false;
      notifyStaircaseNavRefresh();
    });
  }

  /** 先脱离贴底跟随，再滚到工具行。滚完保持钉住，避免末尾几毫秒贴底/虚拟列表把位置拽偏。 */
  function scrollToToolCall(toolCallId) {
    const block = findToolRowBlockByCallId(toolCallId);
    if (!block || typeof block.scrollIntoView !== 'function') return false;
    revealCollapsedToolTrace(block);
    userPinnedScroll = true;
    autoScrollEnabled = false;
    updateFollowBottomClass();
    updateJumpBottomButton();
    suppressScrollSync = true;
    stopPinnedToolScrollWatch();
    const gen = ++toolScrollGen;
    toolScrollEndHandler = function () {
      finishPinnedToolScroll(gen);
    };
    if (elMessages) {
      elMessages.addEventListener('scrollend', toolScrollEndHandler);
    }
    toolScrollFinishTimer = setTimeout(() => {
      finishPinnedToolScroll(gen);
    }, 800);
    requestAnimationFrame(() => {
      if (gen !== toolScrollGen) return;
      try {
        block.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (_e) {
        try { block.scrollIntoView(true); } catch (_e2) { /* ignore */ }
      }
    });
    return true;
  }

  function updateToolActionByCallId(toolCallId, toolName, status) {
    if (!elMessages) return;
    const block = toolCallId ? findToolRowBlockByCallId(toolCallId) : null;
    const row = block ? block.querySelector('.tool-action') : null;
    if (!row) {
      updateLastToolAction(toolName, status);
      return;
    }
    const iconEl = row.querySelector('.tool-icon');
    if (iconEl) {
      iconEl.className = `tool-icon ${status}`;
      iconEl.textContent = iconTextForStatus(status);
    }
    notifyContentLayoutChange();
  }

  function updateLastToolAction(toolName, status) {
    if (!elTailRoot || !elTailAnchor) return;
    let node = elTailAnchor.previousSibling;
    while (node) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-trace-group')) {
        const rows = node.querySelectorAll('.tool-action');
        for (let r = rows.length - 1; r >= 0; r--) {
          if (rows[r].getAttribute('data-tool') === toolName) {
            const iconEl = rows[r].querySelector('.tool-icon');
            if (iconEl) {
              iconEl.className = `tool-icon ${status}`;
              iconEl.textContent = iconTextForStatus(status);
            }
            notifyContentLayoutChange();
            return;
          }
        }
      }
      if (node.nodeType === 1 && isToolRowBlock(node)) {
        const rowInBlock = node.querySelector('.tool-action');
        if (rowInBlock && rowInBlock.getAttribute('data-tool') === toolName) {
          const iconEl3 = rowInBlock.querySelector('.tool-icon');
          if (iconEl3) {
            iconEl3.className = `tool-icon ${status}`;
            iconEl3.textContent = iconTextForStatus(status);
          }
          notifyContentLayoutChange();
          return;
        }
      }
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-action') && node.getAttribute('data-tool') === toolName) {
        const iconEl2 = node.querySelector('.tool-icon');
        if (iconEl2) {
          iconEl2.className = `tool-icon ${status}`;
          iconEl2.textContent = iconTextForStatus(status);
        }
        notifyContentLayoutChange();
        return;
      }
      node = node.previousSibling;
    }
  }

  function resetLiveToolRoundTargets() {
    liveToolRoundRoot = null;
    liveToolRoundVisible = null;
    liveToolRoundCollapsed = null;
    liveToolRoundToggle = null;
    liveToolRoundCount = 0;
  }

  /** 移除当前 live 工具区 DOM（F5 还原前清掉缓存占位，避免重复） */
  function clearLiveToolRoundDom() {
    liveToolRoundActive = false;
    if (liveToolRoundRoot && liveToolRoundRoot.parentNode) {
      liveToolRoundRoot.parentNode.removeChild(liveToolRoundRoot);
    }
    resetLiveToolRoundTargets();
    clearTrailingToolDomBeforeAnchor();
  }

  function setLiveToolRoundActive(active) {
    liveToolRoundActive = active;
  }

  function isLiveToolRoundActive() {
    return liveToolRoundActive;
  }

  // ---- 消息渲染 ----

  function formatMessageTime(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  function getMessageTimestamp(msg) {
    if (!msg) return null;
    if (msg.role === 'user' || msg.role === 'system') {
      return typeof msg.sentAt === 'number' && isFinite(msg.sentAt) ? msg.sentAt : null;
    }
    if (msg.role === 'agent') {
      return typeof msg.completedAt === 'number' && isFinite(msg.completedAt) ? msg.completedAt : null;
    }
    return null;
  }

  const restoreUiState = { canRestore: true, checkpointIds: {}, cursorMessageId: '', cursorRestored: false };
  const messageActionHandlers = { onDelete: null, onRestore: null };

  function rebindExistingMessageActionButtons() {
    if (!elMessages) return;
    const deleteBtns = elMessages.querySelectorAll('.msg-delete-btn');
    for (let i = 0; i < deleteBtns.length; i++) {
      const del = deleteBtns[i];
      if (!del._actionBound) bindMessageActionButton(del, 'delete', del.dataset.messageId || '');
    }
    const restoreBtns = elMessages.querySelectorAll('.msg-restore-btn');
    for (let j = 0; j < restoreBtns.length; j++) {
      const res = restoreBtns[j];
      if (!res._actionBound) bindMessageActionButton(res, 'restore', res.dataset.messageId || '');
    }
  }

  function setMessageActionHandlers(handlers) {
    handlers = handlers || {};
    messageActionHandlers.onDelete = typeof handlers.onDelete === 'function' ? handlers.onDelete : null;
    messageActionHandlers.onRestore = typeof handlers.onRestore === 'function' ? handlers.onRestore : null;
    rebindExistingMessageActionButtons();
  }

  function bindMessageActionButton(btn, type, messageId) {
    if (!btn || btn._actionBound) return;
    btn._actionBound = true;
    let lastInvokeAt = 0;
    let touchMoved = false;

    function invoke(e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const now = Date.now();
      if (now - lastInvokeAt < 350) return;
      lastInvokeAt = now;
      const fn = type === 'delete' ? messageActionHandlers.onDelete : messageActionHandlers.onRestore;
      if (typeof fn === 'function') fn(messageId, btn);
    }

    btn.addEventListener('click', invoke);
    btn.addEventListener('touchstart', () => {
      touchMoved = false;
    }, { passive: true });
    btn.addEventListener('touchmove', () => {
      touchMoved = true;
    }, { passive: true });
    btn.addEventListener('touchend', (e) => {
      if (touchMoved) return;
      invoke(e);
    });
  }

  function restoreButtonIconSvg() {
    return window.AppIcon ? window.AppIcon.html('restore', { width: 12, className: 'msg-restore-icon' }) : '';
  }

  function deleteButtonIconSvg() {
    return window.AppIcon ? window.AppIcon.html('trash', { width: 12, className: 'msg-delete-icon' }) : '';
  }

  function createRestoreButton(messageId, sentAt) {
    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'msg-restore-btn';
    restoreBtn.innerHTML = restoreButtonIconSvg();
    if (window.AppIcon) window.AppIcon.hydrate(restoreBtn);
    restoreBtn.dataset.messageId = messageId;
    if (sentAt) restoreBtn.dataset.sentAt = String(sentAt);
    restoreBtn.setAttribute('aria-label', '回滚到此消息');
    bindMessageActionButton(restoreBtn, 'restore', messageId);
    applyRestoreButtonState(restoreBtn);
    return restoreBtn;
  }

  function createDeleteButton(messageId, sentAt) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'msg-delete-btn';
    deleteBtn.innerHTML = deleteButtonIconSvg();
    if (window.AppIcon) window.AppIcon.hydrate(deleteBtn);
    deleteBtn.dataset.messageId = messageId;
    if (sentAt) deleteBtn.dataset.sentAt = String(sentAt);
    deleteBtn.setAttribute('aria-label', '删除此消息');
    deleteBtn.title = '删除此消息';
    bindMessageActionButton(deleteBtn, 'delete', messageId);
    return deleteBtn;
  }

  function createUserMessageActions(messageId, sentAt) {
    const actions = document.createElement('div');
    actions.className = 'msg-label-actions';
    actions.appendChild(createDeleteButton(messageId, sentAt));
    actions.appendChild(createRestoreButton(messageId, sentAt));
    return actions;
  }

  function ensureUserMessageActionButtons() {
    if (!elMessages) return;
    const userEls = elMessages.querySelectorAll('.message.user[data-message-id]');
    for (let i = 0; i < userEls.length; i++) {
      const el = userEls[i];
      const mid = el.getAttribute('data-message-id');
      if (!mid) continue;
      const row = el.querySelector('.msg-label-row');
      if (!row) continue;
      if (row.querySelector('.msg-label-actions')) continue;
      const looseDelete = row.querySelector('.msg-delete-btn');
      const looseRestore = row.querySelector('.msg-restore-btn');
      if (looseDelete) looseDelete.remove();
      if (looseRestore) looseRestore.remove();
      const sentAt = el.querySelector('.msg-time') && el.querySelector('.msg-time').dateTime
        ? Date.parse(el.querySelector('.msg-time').dateTime)
        : null;
      row.appendChild(createUserMessageActions(mid, sentAt));
    }
  }

  function ensureRestoreButtonsOnUserMessages() {
    ensureUserMessageActionButtons();
  }

  function refreshRestoreButtonsAfterVirtual() {
    ensureRestoreButtonsOnUserMessages();
    refreshRestoreButtonsVisibility();
    // 虚拟历史 refresh 是 rAF 异步重绘；不要为了改按钮态去拆 DOM。
    // 若别处触发了重绘，下一帧再刷一次，避免 --ready 被冲掉。
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        ensureRestoreButtonsOnUserMessages();
        refreshRestoreButtonsVisibility();
      });
    }
  }

  function setCheckpointMessageIds(ids) {
    const map = {};
    if (Array.isArray(ids)) {
      for (let i = 0; i < ids.length; i++) {
        if (ids[i]) map[ids[i]] = true;
      }
    }
    restoreUiState.checkpointIds = map;
    refreshRestoreButtonsAfterVirtual();
  }

  function setCursorMessageId(messageId, restored) {
    const next = messageId ? String(messageId) : '';
    const nextRestored = !!next && !!restored;
    if (restoreUiState.cursorMessageId === next && restoreUiState.cursorRestored === nextRestored) {
      refreshRestoreButtonsVisibility();
      return;
    }
    restoreUiState.cursorMessageId = next;
    restoreUiState.cursorRestored = nextRestored;
    refreshRestoreButtonsAfterVirtual();
  }

  function getCursorMessageId() {
    if (restoreUiState.cursorMessageId) return restoreUiState.cursorMessageId;
    try {
      if (window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.getSnapshotCursorMessageId === 'function') {
        return window.ChatExecutionPlan.getSnapshotCursorMessageId() || '';
      }
    } catch (_e) { /* ignore */ }
    return '';
  }

  function isCursorRestored() {
    if (restoreUiState.cursorRestored) return true;
    try {
      if (window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.isSnapshotCursorRestored === 'function') {
        return !!window.ChatExecutionPlan.isSnapshotCursorRestored();
      }
    } catch (_e) { /* ignore */ }
    return false;
  }

  function isCurrentRestoreCursor(messageId, sentAt) {
    const cursor = getCursorMessageId();
    if (!cursor || !messageId) return false;
    const aliases = collectMessageIdAliases(messageId);
    if (aliases.includes(cursor)) return true;
    const cursorAliases = collectMessageIdAliases(cursor);
    for (let i = 0; i < aliases.length; i++) {
      if (cursorAliases.includes(aliases[i])) return true;
    }
    try {
      if (window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.isSnapshotCursorMessage === 'function'
        && window.ChatExecutionPlan.isSnapshotCursorMessage(messageId)) {
        return true;
      }
    } catch (_e) { /* ignore */ }
    const resolved = resolveCheckpointMessageId(messageId, sentAt);
    return !!(resolved && (resolved === cursor || cursorAliases.includes(resolved)));
  }

  /** 已回滚到该节点才隐藏回滚；仅「当前位置」仍展示。 */
  function shouldHideRestoreAtCursor(messageId, sentAt) {
    if (!isCursorRestored()) return false;
    if (isCurrentRestoreCursor(messageId, sentAt)) return true;
    try {
      if (window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.isSnapshotRestoreHidden === 'function') {
        return !!window.ChatExecutionPlan.isSnapshotRestoreHidden(messageId);
      }
    } catch (_e) { /* ignore */ }
    return false;
  }

  /** 把时间轴等权威来源的 id 并入，不覆盖已有集合。 */
  function mergeCheckpointMessageIds(ids) {
    if (!Array.isArray(ids) || !ids.length) {
      refreshRestoreButtonsVisibility();
      return;
    }
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      if (!ids[i] || restoreUiState.checkpointIds[ids[i]]) continue;
      restoreUiState.checkpointIds[ids[i]] = true;
      changed = true;
    }
    if (!changed) {
      refreshRestoreButtonsVisibility();
      return;
    }
    refreshRestoreButtonsAfterVirtual();
  }

  function collectUserMessages() {
    try {
      if (!window.ChatSession || typeof window.ChatSession.getMessages !== 'function') return [];
      const msgs = window.ChatSession.getMessages() || [];
      const users = [];
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i] && msgs[i].role === 'user') users.push(msgs[i]);
      }
      return users;
    } catch (_e) {
      return [];
    }
  }

  function collectMessageIdAliases(messageId) {
    const ids = [];
    if (messageId) ids.push(messageId);
    const users = collectUserMessages();
    for (let i = 0; i < users.length; i++) {
      const m = users[i];
      if (m.id === messageId && m._prevId && !ids.includes(m._prevId)) ids.push(m._prevId);
      if (m._prevId === messageId && m.id && !ids.includes(m.id)) ids.push(m.id);
    }
    return ids;
  }

  function findUserMessageRecord(messageId) {
    const users = collectUserMessages();
    for (let i = 0; i < users.length; i++) {
      if (users[i].id === messageId || users[i]._prevId === messageId) return users[i];
    }
    return null;
  }

  function getSnapshotCheckpointEntriesSafe() {
    try {
      if (window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.getSnapshotCheckpointEntries === 'function') {
        const entries = window.ChatExecutionPlan.getSnapshotCheckpointEntries();
        return Array.isArray(entries) ? entries : [];
      }
    } catch (_e) { /* ignore */ }
    return [];
  }

  function normalizeRestorePreview(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function previewMatchesContent(preview, content) {
    const p = normalizeRestorePreview(preview).replace(/…$/, '').trim();
    const c = normalizeRestorePreview(content);
    if (!p || !c) return false;
    return c === p || c.startsWith(p) || p.startsWith(c);
  }

  function parseSnapshotEntryTime(entry) {
    if (!entry) return NaN;
    if (typeof entry.userMessageTime === 'number' && isFinite(entry.userMessageTime)) {
      return entry.userMessageTime;
    }
    if (entry.createdAt) {
      const parsed = Date.parse(entry.createdAt);
      if (isFinite(parsed)) return parsed;
    }
    return NaN;
  }

  function matchSnapshotEntryForMessage(messageId, sentAt) {
    const entries = getSnapshotCheckpointEntriesSafe();
    if (!entries.length) return null;
    const aliases = collectMessageIdAliases(messageId);
    let e;
    for (let i = 0; i < entries.length; i++) {
      e = entries[i];
      if (e && e.messageId && aliases.includes(e.messageId)) return e;
    }
    const users = collectUserMessages();
    const msg = findUserMessageRecord(messageId);
    if (users.length && users.length === entries.length) {
      for (let u = 0; u < users.length; u++) {
        if (users[u].id === messageId || users[u]._prevId === messageId) {
          return entries[u] || null;
        }
      }
    }
    const content = msg && typeof msg.content === 'string' ? msg.content : '';
    const ts = (typeof sentAt === 'number' && isFinite(sentAt))
      ? sentAt
      : (msg && typeof msg.sentAt === 'number' ? msg.sentAt : NaN);
    const contentHits = [];
    for (let j = 0; j < entries.length; j++) {
      if (previewMatchesContent(entries[j].preview, content)) contentHits.push(entries[j]);
    }
    if (contentHits.length === 1) return contentHits[0];
    if (isFinite(ts)) {
      const pool = contentHits.length ? contentHits : entries;
      let best = null;
      let bestDelta = Infinity;
      for (let k = 0; k < pool.length; k++) {
        const et = parseSnapshotEntryTime(pool[k]);
        if (!isFinite(et)) continue;
        const delta = Math.abs(et - ts);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = pool[k];
        }
      }
      if (best && bestDelta <= 8000) return best;
    }
    return contentHits[0] || null;
  }

  function idHasKnownCheckpoint(id) {
    if (!id) return false;
    if (restoreUiState.checkpointIds[id]) return true;
    try {
      if (window.ChatExecutionPlan
        && typeof window.ChatExecutionPlan.hasSnapshotCheckpoint === 'function') {
        return !!window.ChatExecutionPlan.hasSnapshotCheckpoint(id);
      }
    } catch (_e) { /* ignore */ }
    return false;
  }

  function hasCheckpointForMessage(messageId, sentAt) {
    const aliases = collectMessageIdAliases(messageId);
    for (let i = 0; i < aliases.length; i++) {
      if (idHasKnownCheckpoint(aliases[i])) return true;
    }
    const hit = matchSnapshotEntryForMessage(messageId, sentAt);
    return !!(hit && hit.messageId);
  }

  function resolveCheckpointMessageId(messageId, sentAt) {
    const aliases = collectMessageIdAliases(messageId);
    for (let i = 0; i < aliases.length; i++) {
      if (idHasKnownCheckpoint(aliases[i])) return aliases[i];
    }
    const hit = matchSnapshotEntryForMessage(messageId, sentAt);
    return (hit && hit.messageId) || messageId;
  }

  /** 与状态快照同一套门闩：WS.canRestoreRuntime = harnessCanRestore && !processing。 */
  function isChatRestoreAllowed() {
    try {
      if (window.ChatWebSocket && typeof window.ChatWebSocket.canRestoreRuntime === 'function') {
        return !!window.ChatWebSocket.canRestoreRuntime();
      }
    } catch (_e) { /* ignore */ }
    return !!restoreUiState.canRestore;
  }

  function applyRestoreButtonState(btn) {
    if (!btn) return;
    const mid = btn.dataset.messageId || btn.getAttribute('data-message-id') || '';
    const sentAtRaw = btn.dataset.sentAt || btn.getAttribute('data-sent-at') || '';
    const sentAt = sentAtRaw ? Number(sentAtRaw) : NaN;
    const atCursor = shouldHideRestoreAtCursor(mid, isFinite(sentAt) ? sentAt : undefined);
    btn.hidden = atCursor;
    if (atCursor) {
      btn.disabled = true;
      btn.classList.remove('msg-restore-btn--ready');
      btn.title = '已在该检查点，无需回滚';
      btn.setAttribute('aria-label', '已在该检查点，无需回滚');
      return;
    }
    const visible = hasCheckpointForMessage(mid, isFinite(sentAt) ? sentAt : undefined);
    const can = isChatRestoreAllowed();
    btn.classList.toggle('msg-restore-btn--ready', visible);
    btn.disabled = !visible || !can;
    btn.title = !visible
      ? '未找到检查点，无法回滚'
      : (can ? '回滚到此消息' : '运行中，请等待当前任务完成后再回滚');
    btn.setAttribute('aria-label', btn.title);
  }

  function refreshRestoreButtonsVisibility() {
    if (!elMessages) return;
    const restoreButtons = elMessages.querySelectorAll('.msg-restore-btn');
    for (let i = 0; i < restoreButtons.length; i++) {
      applyRestoreButtonState(restoreButtons[i]);
    }
    const can = isChatRestoreAllowed();
    const deleteButtons = elMessages.querySelectorAll('.msg-delete-btn');
    for (let j = 0; j < deleteButtons.length; j++) {
      const delBtn = deleteButtons[j];
      delBtn.disabled = !can;
      delBtn.title = can
        ? '删除此消息及对应回复'
        : '运行中，请等待当前任务完成后再删除';
    }
  }

  function setRestoreAvailability(canRestore) {
    restoreUiState.canRestore = !!canRestore;
    refreshRestoreButtonsVisibility();
  }

  function createMsgLabelRow(role, timestamp, restoreOpts) {
    const row = document.createElement('div');
    row.className = 'msg-label-row';
    const label = document.createElement('div');
    label.className = 'msg-label';
    if (role === 'system') {
      label.textContent = 'Runtime';
    } else if (role === 'user' && restoreOpts && restoreOpts.alsoNote) {
      label.textContent = '备注';
    } else {
      label.textContent = role === 'user' ? 'You' : 'Assistant';
    }
    row.appendChild(label);
    const timeText = formatMessageTime(timestamp);
    if (timeText) {
      const timeEl = document.createElement('time');
      timeEl.className = 'msg-time';
      timeEl.dateTime = new Date(timestamp).toISOString();
      timeEl.textContent = timeText;
      row.appendChild(timeEl);
    }
    if (role === 'user' && restoreOpts && restoreOpts.messageId) {
      row.appendChild(createUserMessageActions(restoreOpts.messageId, restoreOpts.sentAt));
    }
    return row;
  }

  function updateMsgLabelTime(el, timestamp) {
    if (!el) return;
    const timeText = formatMessageTime(timestamp);
    let row = el.querySelector('.msg-label-row');
    if (!row) {
      const label = el.querySelector('.msg-label');
      if (!label || label.classList.contains('msg-thinking-toggle')) return;
      row = document.createElement('div');
      row.className = 'msg-label-row';
      label.parentNode.insertBefore(row, label);
      row.appendChild(label);
    }
    let timeEl = row.querySelector('.msg-time');
    if (!timeText) {
      if (timeEl) timeEl.remove();
      return;
    }
    if (!timeEl) {
      timeEl = document.createElement('time');
      timeEl.className = 'msg-time';
      row.appendChild(timeEl);
    }
    timeEl.dateTime = new Date(timestamp).toISOString();
    timeEl.textContent = timeText;
  }

  function formatTokenCount(n) {
    const num = typeof n === 'number' && isFinite(n) ? Math.max(0, Math.round(n)) : 0;
    try {
      return num.toLocaleString();
    } catch (_e) {
      return String(num);
    }
  }

  function normalizeTurnTokenUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
    const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
    if (input <= 0 && output <= 0) return null;
    return { inputTokens: input, outputTokens: output };
  }

  function normalizeUsedModel(usedModel) {
    return typeof usedModel === 'string' ? usedModel.trim() : '';
  }

  function createTokenUsageBar(usage, usedModel) {
    const normalized = normalizeTurnTokenUsage(usage);
    const model = normalizeUsedModel(usedModel);
    if (!normalized && !model) return null;
    const total = normalized ? (normalized.inputTokens + normalized.outputTokens) : 0;
    const bar = document.createElement('div');
    bar.className = 'msg-token-usage';
    bar.setAttribute('aria-label', model ? (`Token 消耗，模型 ${model}`) : 'Token 消耗');

    function addItem(label, value, extraClass) {
      const item = document.createElement('span');
      item.className = extraClass ? `msg-token-usage__item ${extraClass}` : 'msg-token-usage__item';
      const lbl = document.createElement('span');
      lbl.className = 'msg-token-usage__label';
      lbl.textContent = label;
      const val = document.createElement('span');
      val.className = 'msg-token-usage__value';
      val.textContent = value;
      item.appendChild(lbl);
      item.appendChild(val);
      bar.appendChild(item);
      return item;
    }

    if (normalized) {
      addItem('输入', formatTokenCount(normalized.inputTokens));
      addItem('输出', formatTokenCount(normalized.outputTokens));
      addItem('合计', formatTokenCount(total));
    }
    if (model) {
      const modelItem = addItem('模型', model, 'msg-token-usage__item--model');
      modelItem.title = model;
    }
    return bar;
  }

  function mountTokenUsageBar(messageEl, usage, usedModel) {
    if (!messageEl) return;
    const normalized = normalizeTurnTokenUsage(usage);
    const model = normalizeUsedModel(usedModel);
    const existing = messageEl.querySelector('.msg-token-usage');
    if (!normalized && !model) {
      if (existing) existing.remove();
      return;
    }
    const bar = createTokenUsageBar(normalized, model);
    if (!bar) return;
    if (existing) {
      existing.replaceWith(bar);
      return;
    }
    const content = messageEl.querySelector('.msg-content');
    if (content) {
      if (content.nextSibling) {
        messageEl.insertBefore(bar, content.nextSibling);
      } else {
        messageEl.appendChild(bar);
      }
      return;
    }
    messageEl.appendChild(bar);
  }

  function updateMessageTokenUsage(msg) {
    if (!msg || (msg.role !== 'agent' && msg.role !== 'assistant')) return;
    let el = msg._el;
    if (!el && msg.id && elMessages) {
      el = elMessages.querySelector(`.message.agent[data-message-id="${msg.id}"]`)
        || elMessages.querySelector(`.message.assistant[data-message-id="${msg.id}"]`);
    }
    if (!el && typeof msg._msgIndex === 'number' && elMessages) {
      el = elMessages.querySelector(`.message.agent[data-msg-index="${msg._msgIndex}"]`)
        || elMessages.querySelector(`.message.assistant[data-msg-index="${msg._msgIndex}"]`);
    }
    if (!el) {
      const streamEl = document.getElementById('streaming-msg');
      if (streamEl && msg._streaming) el = streamEl;
    }
    if (!el && elTailRoot) {
      const nodes = elTailRoot.querySelectorAll('.message.agent, .message.assistant');
      if (nodes.length) el = nodes[nodes.length - 1];
    }
    if (el) mountTokenUsageBar(el, msg.turnTokenUsage, msg.usedModel);
  }

  function resolveSkillChipLabel(filename) {
    const fn = String(filename || '').replace(/^#/, '');
    if (!fn) return '';
    if (window.ChatSkills && typeof window.ChatSkills.getSkills === 'function') {
      const skills = window.ChatSkills.getSkills();
      for (let i = 0; i < skills.length; i++) {
        if (skills[i].filename === fn) {
          return skills[i].name || fn;
        }
      }
    }
    return fn;
  }

  function createMsgSkillChipsRow(skillFilenames) {
    if (!skillFilenames || !skillFilenames.length) return null;
    const row = document.createElement('div');
    row.className = 'msg-skill-chips';
    for (let i = 0; i < skillFilenames.length; i++) {
      const fn = String(skillFilenames[i] || '').replace(/^#/, '');
      if (!fn) continue;
      const chip = document.createElement('span');
      chip.className = 'msg-skill-chip';
      chip.title = fn;
      chip.textContent = `#${resolveSkillChipLabel(fn)}`;
      row.appendChild(chip);
    }
    return row.childNodes.length ? row : null;
  }

  function createMsgSlashCommandChip(command, title) {
    if (!command) return null;
    const row = document.createElement('div');
    row.className = 'msg-shell-command-chips';
    const chip = document.createElement('span');
    chip.className = 'msg-shell-command-chip';
    chip.title = title || command;
    chip.setAttribute('aria-label', title || command);
    const label = command === '/shell' ? '/shell' : command;
    if (window.AppIcon && command === '/shell') {
      chip.innerHTML =
        `${window.AppIcon.html('terminal', { width: 12 })}<span class="msg-shell-command-chip-label">${label}</span>`;
    } else {
      chip.innerHTML = `<span class="msg-shell-command-chip-label">${label}</span>`;
    }
    row.appendChild(chip);
    return row;
  }

  function createMsgShellCommandChip(shellCommand) {
    return createMsgSlashCommandChip(shellCommand, 'Shell 协作模式');
  }

  function basenameFromPath(fullPath) {
    if (!fullPath) return '';
    const parts = String(fullPath).replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || fullPath;
  }

  function createMsgFileRefChipsRow(filePaths) {
    if (!filePaths || !filePaths.length) return null;
    const row = document.createElement('div');
    row.className = 'msg-file-ref-chips';
    for (let i = 0; i < filePaths.length; i++) {
      const absPath = String(filePaths[i] || '').trim();
      if (!absPath) continue;
      const chip = document.createElement('span');
      chip.className = 'msg-file-ref-chip';
      chip.title = absPath;
      chip.textContent = `@${basenameFromPath(absPath)}`;
      row.appendChild(chip);
    }
    return row.childNodes.length ? row : null;
  }

  function createMessageEl(msg, stripStatusTagFn, msgIndex) {
    let displayMsg = msg;
    if (
      msg
      && msg.role === 'user'
      && window.ChatSession
      && typeof window.ChatSession.prepareUserMessageForDisplay === 'function'
    ) {
      displayMsg = window.ChatSession.prepareUserMessageForDisplay(msg);
    }
    const el = document.createElement('div');
    el.className = `message ${displayMsg.role}`;
    if (displayMsg.alsoNote) {
      el.classList.add('also-note');
    }

    const idx = typeof msgIndex === 'number' ? msgIndex : displayMsg._msgIndex;
    if (typeof idx === 'number') {
      el.setAttribute('data-msg-index', String(idx));
    }
    if (displayMsg.role === 'user') {
      el.setAttribute('data-user-turn', 'true');
      if (displayMsg.id) el.setAttribute('data-message-id', displayMsg.id);
    }
    if ((displayMsg.role === 'agent' || displayMsg.role === 'assistant') && displayMsg.id) {
      el.setAttribute('data-message-id', displayMsg.id);
    }

    let restoreOpts = null;
    if (displayMsg.role === 'user' && displayMsg.id) {
      restoreOpts = { messageId: displayMsg.id, sentAt: displayMsg.sentAt, alsoNote: !!displayMsg.alsoNote };
    }
    el.appendChild(createMsgLabelRow(displayMsg.role, getMessageTimestamp(displayMsg), restoreOpts));

    if (displayMsg.role === 'user' && displayMsg.shellCommand) {
      const shellRow = createMsgShellCommandChip(displayMsg.shellCommand);
      if (shellRow) {
        el.appendChild(shellRow);
        if (window.AppIcon) window.AppIcon.hydrate(shellRow);
      }
    }

    if (displayMsg.role === 'user' && displayMsg.planCommand) {
      const planRow = createMsgSlashCommandChip(displayMsg.planCommand, '规划模式');
      if (planRow) el.appendChild(planRow);
    }

    if (displayMsg.role === 'user' && displayMsg.openCommand) {
      const openRow = createMsgSlashCommandChip(displayMsg.openCommand, '目录浏览');
      if (openRow) el.appendChild(openRow);
    }

    if (displayMsg.role === 'user' && displayMsg.skills && displayMsg.skills.length) {
      const skillRow = createMsgSkillChipsRow(displayMsg.skills);
      if (skillRow) el.appendChild(skillRow);
    }

    if (displayMsg.role === 'user' && displayMsg.referencePaths && displayMsg.referencePaths.length) {
      const fileRefRow = createMsgFileRefChipsRow(displayMsg.referencePaths);
      if (fileRefRow) el.appendChild(fileRefRow);
    }

    if (displayMsg.images && displayMsg.images.length > 0) {
      const imgRow = document.createElement('div');
      imgRow.className = 'msg-images';
      for (let j = 0; j < displayMsg.images.length; j++) {
        const img = document.createElement('img');
        img.src = displayMsg.images[j];
        img.className = 'msg-image-thumb';
        img.alt = '图片 ' + (j + 1);
        img.title = '点击查看大图';
        imgRow.appendChild(img);
      }
      el.appendChild(imgRow);
    }

    const content = document.createElement('div');
    content.className = 'msg-content';
    if (displayMsg.role === 'system') {
      content.className = 'msg-content msg-system-content';
      content.textContent = displayMsg.content || '';
      el.appendChild(content);
    } else if (displayMsg.role === 'agent') {
      content.textContent = stripStatusTagFn(displayMsg.content);
      el.appendChild(content);
    } else if (displayMsg.content) {
      content.textContent = displayMsg.content;
      el.appendChild(content);
    }

    const tokenBar = createTokenUsageBar(displayMsg.turnTokenUsage, displayMsg.usedModel);
    if (tokenBar) el.appendChild(tokenBar);

    return el;
  }

  /** 挂载 diff（默认隐藏）；tool_result 后更新 diff 源 */
  function mountDiffForToolCallId(toolCallId, diffSource) {
    if (!elMessages || !toolCallId || !diffSource) return false;
    const block = findToolRowBlockByCallId(toolCallId);
    if (!block) return false;
    const ok = mountHiddenDiffInBlock(block, diffSource);
    if (ok) {
      const row = block.querySelector('.tool-action');
      const toolName = row ? row.getAttribute('data-tool') : '';
      bindDiffToggleRow(block, toolName || '');
      if (isNodeInHistoryRegion(block)) notifyHistoryLayoutChange(block);
      else notifyTailLayoutChange();
    }
    return ok;
  }

  /** @deprecated 使用 mountDiffForToolCallId（不再自动展开） */
  function showDiffForToolCallId(toolCallId, diffEl) {
    if (!elMessages || !diffEl || !toolCallId) return;
    const block = findToolRowBlockByCallId(toolCallId);
    if (block) {
      appendDiffToRowBlock(block, diffEl);
      return;
    }
    const fallback = document.createElement('div');
    fallback.className = 'tool-action-row-block';
    fallback.setAttribute('data-tool-call-id', toolCallId);
    appendDiffToRowBlock(fallback, diffEl);
    insertTailBefore(fallback);
    notifyContentLayoutChange();
  }

  function renderMessagesOnly(messages, toolTraces, stripStatusTagFn, shouldScroll, displayMap) {
    ensureChatLayout();
    invalidateToolDisplayCaches();
    setHistoryDisplayMapCache(displayMap);
    prefetchToolTraceDiffIndex();
    prefetchSessionWorkspaceRoot();
    lastStripStatusTagFn = stripStatusTagFn || lastStripStatusTagFn;
    liveToolRoundActive = false;
    resetLiveToolRoundTargets();

    clearTailDom();

    let tailStart = 0;
    if (window.ChatVirtualHistory && typeof window.ChatVirtualHistory.computeTailStartIndex === 'function') {
      tailStart = window.ChatVirtualHistory.computeTailStartIndex(
        messages,
        window.ChatVirtualHistory.TAIL_TURN_COUNT,
      );
    }

    if (virtualScroller && window.ChatVirtualHistory) {
      const historyUnits = window.ChatVirtualHistory.buildHistoryUnits(
        messages,
        toolTraces,
        displayMap,
        tailStart,
      );
      virtualScroller.setUnits(historyUnits);
    }

    for (let i = tailStart; i < messages.length; i++) {
      const msg = messages[i];
      const msgTraces = msg.id ? toolTraces[msg.id] : null;
      if (msgTraces && msgTraces.length > 0) {
        const msgDisplays = (displayMap && msg.id && displayMap[msg.id]) ? displayMap[msg.id] : [];
        insertFoldableToolTraceGroup(msgTraces, msgDisplays, msg.id);
      }
      insertTailBefore(createMessageEl(msg, stripStatusTagFn, i));
    }

    followBottomAfterContentPatch(shouldScroll);
    if (window.ChatPage && typeof window.ChatPage.syncWelcomeState === 'function') {
      window.ChatPage.syncWelcomeState();
    }
    notifyStaircaseNavRefresh();
    refreshRestoreButtonsVisibility();
  }
  function followBottomAfterContentPatch(shouldScroll) {
    if (shouldScroll === 'force') {
      enableAutoScroll();
    } else {
      scheduleScrollIfSticky();
    }
  }

  function repairMissingDiffMountsFromStructured(structured) {
    if (!window.ToolDisplayHistory
        || typeof window.ToolDisplayHistory.buildToolCallDiffIndex !== 'function') {
      return;
    }
    repairMissingDiffMounts(window.ToolDisplayHistory.buildToolCallDiffIndex(structured || []));
  }

  function appendMessageEl(msg, stripStatusTagFn) {
    ensureChatLayout();
    if (!elTailRoot) return;
    const msgIndex = typeof msg._msgIndex === 'number' ? msg._msgIndex : -1;
    const el = createMessageEl(msg, stripStatusTagFn, msgIndex >= 0 ? msgIndex : undefined);
    msg._el = el;
    insertTailBefore(el);
    notifyTailLayoutChange();
    if (window.ChatPage && typeof window.ChatPage.syncWelcomeState === 'function') {
      window.ChatPage.syncWelcomeState();
    }
    notifyStaircaseNavRefresh();
    if (msg.role === 'user' && msg.id) {
      refreshRestoreButtonsVisibility();
    }
    return el;
  }

  /**
   * 多端同步：在当前轮流式/工具/思考块之前插入远端用户消息 DOM。
   */
  function insertRemoteUserMessageEl(msg, stripStatusTagFn) {
    ensureChatLayout();
    if (!elTailRoot || !elTailAnchor) return null;
    let insertBefore = elTailAnchor;
    if (msg.id && elMessages && elMessages.querySelector(`.message.user[data-message-id="${msg.id}"]`)) {
      return elMessages.querySelector(`.message.user[data-message-id="${msg.id}"]`);
    }
    let node = elTailAnchor.previousElementSibling;
    while (node) {
      if (node.id === 'streaming-reasoning-msg' || node.id === 'streaming-msg') {
        insertBefore = node;
        node = node.previousElementSibling;
        continue;
      }
      if (node.classList && (
        node.classList.contains('tool-action')
        || isToolRowBlock(node)
        || isToolTraceContainer(node)
      )) {
        insertBefore = node;
        node = node.previousElementSibling;
        continue;
      }
      break;
    }
    const msgIndex = typeof msg._msgIndex === 'number' ? msg._msgIndex : -1;
    const el = createMessageEl(msg, stripStatusTagFn, msgIndex >= 0 ? msgIndex : undefined);
    msg._el = el;
    elTailRoot.insertBefore(el, insertBefore);
    notifyTailLayoutChange();
    if (window.ChatPage && typeof window.ChatPage.syncWelcomeState === 'function') {
      window.ChatPage.syncWelcomeState();
    }
    notifyStaircaseNavRefresh();
    if (msg.id) refreshRestoreButtonsVisibility();
    return el;
  }

  function notifyStaircaseNavRefresh() {
    if (window.ChatStaircaseNav && typeof window.ChatStaircaseNav.refresh === 'function') {
      window.ChatStaircaseNav.refresh();
    }
    if (window.ChatStaircaseNav && typeof window.ChatStaircaseNav.notifyScrollSync === 'function') {
      window.ChatStaircaseNav.notifyScrollSync();
    }
  }

  function scrollToMessageIndex(msgIndex, messages) {
    if (!elMessages || typeof msgIndex !== 'number' || msgIndex < 0) return;

    userPinnedScroll = true;
    autoScrollEnabled = false;
    updateFollowBottomClass();
    updateJumpBottomButton();

    const target = elMessages.querySelector(`.message[data-msg-index="${msgIndex}"]`);
    if (target) {
      suppressScrollSync = true;
      try {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (_e) {
        target.scrollIntoView(true);
      }
      setTimeout(() => {
        suppressScrollSync = false;
        syncAutoScrollFromViewport();
        notifyStaircaseNavRefresh();
      }, 400);
      return;
    }

    if (virtualScroller && typeof virtualScroller.scrollToMessageIndex === 'function') {
      suppressScrollSync = true;
      const scrolled = virtualScroller.scrollToMessageIndex(msgIndex);
      if (scrolled) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const mounted = elMessages.querySelector(`.message[data-msg-index="${msgIndex}"]`);
            if (mounted) {
              try {
                mounted.scrollIntoView({ block: 'start', behavior: 'smooth' });
              } catch (_e2) {
                mounted.scrollIntoView(true);
              }
            }
            suppressScrollSync = false;
            syncAutoScrollFromViewport();
            notifyStaircaseNavRefresh();
          });
        });
        return;
      }
      suppressScrollSync = false;
    }

    if (Array.isArray(messages) && msgIndex < messages.length) {
      let tailStart = 0;
      if (window.ChatVirtualHistory && typeof window.ChatVirtualHistory.computeTailStartIndex === 'function') {
        tailStart = window.ChatVirtualHistory.computeTailStartIndex(
          messages,
          window.ChatVirtualHistory.TAIL_TURN_COUNT,
        );
      }
      if (msgIndex >= tailStart) {
        scrollToBottom(true);
      }
    }
  }

  /** 视口顶部附近的用户消息索引（供楼梯导航高亮，兼容虚拟历史区） */
  function findMaxUserMsgIndexInDom(onlyVisible) {
    if (!elMessages) return -1;
    const nodes = elMessages.querySelectorAll('.message.user[data-msg-index]');
    const rootRect = elMessages.getBoundingClientRect();
    let maxIdx = -1;
    for (let i = 0; i < nodes.length; i++) {
      const idx = parseInt(nodes[i].getAttribute('data-msg-index') || '-1', 10);
      if (idx < 0) continue;
      if (onlyVisible) {
        const rect = nodes[i].getBoundingClientRect();
        if (rect.bottom <= rootRect.top + 12) continue;
        if (rect.top >= rootRect.bottom - 12) continue;
      }
      if (idx > maxIdx) maxIdx = idx;
    }
    return maxIdx;
  }

  function findLastUserMsgIndexAboveViewport() {
    if (!elMessages) return -1;
    const nodes = elMessages.querySelectorAll('.message.user[data-msg-index]');
    const rootRect = elMessages.getBoundingClientRect();
    let maxIdx = -1;
    for (let i = 0; i < nodes.length; i++) {
      const rect = nodes[i].getBoundingClientRect();
      if (rect.bottom > rootRect.top + 12) continue;
      const idx = parseInt(nodes[i].getAttribute('data-msg-index') || '-1', 10);
      if (idx > maxIdx) maxIdx = idx;
    }
    return maxIdx;
  }

  function getActiveUserMsgIndex() {
    if (!elMessages) return -1;

    if (isNearBottom()) {
      const atBottom = findMaxUserMsgIndexInDom(false);
      if (atBottom >= 0) return atBottom;
    }

    const rootRect = elMessages.getBoundingClientRect();
    const anchorY = rootRect.top + 80;
    let activeFromDom = -1;
    let bestTop = -Infinity;
    let fallbackIndex = -1;
    let fallbackTop = Infinity;

    const nodes = elMessages.querySelectorAll('.message.user[data-msg-index]');
    for (let n = 0; n < nodes.length; n++) {
      const el = nodes[n];
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= rootRect.top + 12) continue;
      if (rect.top >= rootRect.bottom - 12) continue;

      const msgIdx = parseInt(el.getAttribute('data-msg-index') || '-1', 10);
      if (msgIdx < 0) continue;

      if (rect.top <= anchorY && rect.top > bestTop) {
        bestTop = rect.top;
        activeFromDom = msgIdx;
      } else if (rect.top > anchorY && rect.top < fallbackTop) {
        fallbackTop = rect.top;
        fallbackIndex = msgIdx;
      }
    }

    if (activeFromDom >= 0) return activeFromDom;
    if (fallbackIndex >= 0) return fallbackIndex;

    const lastAbove = findLastUserMsgIndexAboveViewport();
    if (lastAbove >= 0) return lastAbove;

    if (virtualScroller && elHistoryOuter
        && typeof virtualScroller.resolveActiveUserMsgIndex === 'function') {
      const historyTop = elHistoryOuter.offsetTop;
      const viewTop = elMessages.scrollTop - historyTop;
      const totalH = typeof virtualScroller.getTotalHeight === 'function'
        ? virtualScroller.getTotalHeight()
        : 0;
      if (viewTop >= 0 && viewTop <= totalH + 1) {
        const fromVirtual = virtualScroller.resolveActiveUserMsgIndex(viewTop, 80);
        if (fromVirtual >= 0) return fromVirtual;
      }
      if (viewTop > totalH) {
        const inTail = findMaxUserMsgIndexInDom(false);
        if (inTail >= 0) return inTail;
      }
    }

    return findMaxUserMsgIndexInDom(false);
  }

  function updateMessageContent(msg, content, stripStatusTagFn) {
    if (!msg) return;
    msg.content = content;
    const root = msg._el;
    if (!root) return;
    const contentDiv = root.querySelector('.msg-content');
    if (!contentDiv) return;
    const text = msg.role === 'agent' ? stripStatusTagFn(content) : content;
    contentDiv.textContent = text;
    notifyTailLayoutChange();
    followBottomAfterContentPatch();
  }

  /** 服务端持久化后，将用户消息中的 data URL 替换为 /api/sessions/... URL 并刷新 DOM。 */
  function updateMessageImagesEl(messageId, images) {
    if (!messageId || !Array.isArray(images) || images.length === 0) return false;
    const persistable = images.filter((u) =>  typeof u === 'string' && u && !u.startsWith('data:'));
    if (persistable.length === 0) return false;

    let root = null;
    if (elMessages) {
      root = elMessages.querySelector(`.message[data-message-id="${messageId}"]`);
    }
    if (!root) return false;

    let imgRow = root.querySelector('.msg-images');
    if (!imgRow) {
      imgRow = document.createElement('div');
      imgRow.className = 'msg-images';
      const label = root.querySelector('.msg-label');
      const anchor = label ? label.nextElementSibling : root.firstChild;
      if (anchor) root.insertBefore(imgRow, anchor);
      else root.appendChild(imgRow);
    }
    imgRow.innerHTML = '';
    for (let j = 0; j < persistable.length; j++) {
      const img = document.createElement('img');
      img.src = persistable[j];
      img.className = 'msg-image-thumb';
      img.alt = '图片 ' + (j + 1);
      img.title = '点击查看大图';
      imgRow.appendChild(img);
    }
    if (isNodeInHistoryRegion(root)) notifyHistoryLayoutChange(root);
    else notifyTailLayoutChange();
    followBottomAfterContentPatch();
    return true;
  }

  /**
   * 尾部真实 DOM 中用户轮次超过 N 时，重绘以把更早轮次迁入虚拟历史区。
   * （仅靠 append 不重绘时，第 3+ 轮会一直堆在 tail-root）
   */
  function maybeRepartitionTailIfNeeded(messages, toolTraces, stripStatusTagFn, shouldScroll, displayMap) {
    if (!elTailRoot || !window.ChatVirtualHistory) return;
    const maxTurns = window.ChatVirtualHistory.TAIL_TURN_COUNT || 2;
    const userBubbles = elTailRoot.querySelectorAll('.message.user');
    if (userBubbles.length <= maxTurns) return;
    renderMessagesOnly(messages, toolTraces, stripStatusTagFn, shouldScroll, displayMap);
  }

  // ---- 流式输出 ----

  function clearReasoningStream() {
    streamReasoningBuffer = '';
    const el = document.getElementById('streaming-reasoning-msg');
    if (el) el.remove();
  }

  function discardIncompleteStream(messages) {
    clearReasoningStream();
    streamReplyBuffer = '';
    const streamEl = document.getElementById('streaming-msg');
    if (streamEl) streamEl.remove();
    if (Array.isArray(messages)) {
      const last = messages[messages.length - 1];
      if (last && last.role === 'agent' && last._streaming) {
        messages.pop();
      }
    }
  }

  /** 将误落入 Assistant 正文的规划/推理气泡转为 Thinking 样式（并合并进思考流缓冲）。 */
  function promoteAssistantBubbleToThinking(stripStatusTagFn) {
    const stripFn = stripStatusTagFn || lastStripStatusTagFn;
    let el = document.getElementById('streaming-msg');
    if (!el && elTailRoot) {
      const nodes = elTailRoot.querySelectorAll('.message.assistant:not(.message-thinking), .message.agent:not(.message-thinking)');
      if (nodes.length) el = nodes[nodes.length - 1];
    }
    if (!el || el.classList.contains('message-thinking')) return;

    const bodyText = stripFn(getStreamingBubbleBodyText(el));
    if (!bodyText) return;

    const wasStreaming = el.id === 'streaming-msg';
    if (el.parentNode) el.parentNode.removeChild(el);
    if (wasStreaming) streamReplyBuffer = '';

    if (streamReasoningBuffer && bodyText.length <= streamReasoningBuffer.length
        && streamReasoningBuffer.includes(bodyText)) {
      return;
    }
    appendReasoningStreamChunk(bodyText);
  }

  /** 非流式 / 流式回退时，由 harness thinking step 补齐思考块 */
  function appendReasoningStreamIfAbsent(text) {
    if (!text) return;
    if (streamReasoningBuffer && streamReasoningBuffer.includes(text)) return;
    appendReasoningStreamChunk(text);
  }

  function appendReasoningStreamChunk(text) {
    ensureChatLayout();
    if (!text) return;
    streamReasoningBuffer += text;
    let el = document.getElementById('streaming-reasoning-msg');
    if (!el) {
      el = document.createElement('div');
      el.className = 'message assistant message-thinking';
      el.setAttribute('id', 'streaming-reasoning-msg');
      el.appendChild(createThinkingToggleButton(false));
      const body = document.createElement('div');
      body.className = 'msg-thinking-body';
      el.appendChild(body);
      el.appendChild(createThinkingToggleButton(true));
      el._streamContentEl = body;
      insertTailBefore(el);
    }
    if (el._streamContentEl) {
      el._streamContentEl.textContent = streamReasoningBuffer;
    }
    notifyTailLayoutChange();
  }

  function appendStreamChunk(text, messages, stripStatusTagFn) {
    ensureChatLayout();
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'agent' && lastMsg._streaming) {
      streamReplyBuffer += text;
      lastMsg.content = streamReplyBuffer;
    } else {
      repairOrphanStreamingIfAny(messages, stripStatusTagFn);
      streamReplyBuffer += text;
      messages.push({ role: 'agent', content: streamReplyBuffer, _streaming: true });

      const el = document.createElement('div');
      el.className = 'message assistant';
      el.setAttribute('id', 'streaming-msg');

      el.appendChild(createMsgLabelRow('agent', null));

      const contentDiv = document.createElement('div');
      contentDiv.className = 'msg-content';
      contentDiv.textContent = stripStatusTagFn(streamReplyBuffer);
      el.appendChild(contentDiv);
      el._streamContentEl = contentDiv;

      insertTailBefore(el);
      if (autoScrollEnabled) scheduleScrollIfSticky();
      return;
    }

    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) {
      const wrap = document.createElement('div');
      wrap.className = 'message assistant';
      wrap.setAttribute('id', 'streaming-msg');
      wrap.appendChild(createMsgLabelRow('agent', null));
      const contentDiv = document.createElement('div');
      contentDiv.className = 'msg-content';
      contentDiv.textContent = stripStatusTagFn(streamReplyBuffer);
      wrap.appendChild(contentDiv);
      wrap._streamContentEl = contentDiv;
      insertTailBefore(wrap);
      if (autoScrollEnabled) scheduleScrollIfSticky();
      return;
    }
    if (streamEl && streamEl._streamContentEl) {
      streamEl._streamContentEl.textContent = stripStatusTagFn(streamReplyBuffer);
    } else if (streamEl) {
      const contentEl = streamEl.lastChild;
      if (contentEl) {
        contentEl.textContent = stripStatusTagFn(streamReplyBuffer);
        streamEl._streamContentEl = contentEl;
      }
    }
    if (autoScrollEnabled) scheduleScrollIfSticky();
  }

  function finalizeStreamResponse(messages, stripStatusTagFn) {
    const lastMsg = messages[messages.length - 1];
    const wasStreaming = !!(lastMsg && lastMsg._streaming);
    if (lastMsg && lastMsg._streaming) {
      delete lastMsg._streaming;
      lastMsg.content = stripStatusTagFn(lastMsg.content);
    }
    if (lastMsg && lastMsg.role === 'agent' && lastMsg.completedAt == null) {
      lastMsg.completedAt = Date.now();
    }
    streamReplyBuffer = '';
    const streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      if (streamEl._streamContentEl) {
        streamEl._streamContentEl.textContent = stripStatusTagFn(streamEl._streamContentEl.textContent || '');
      }
      if (lastMsg && lastMsg.completedAt != null) {
        updateMsgLabelTime(streamEl, lastMsg.completedAt);
      }
      streamEl.removeAttribute('id');
      delete streamEl._streamContentEl;
    } else if (wasStreaming && lastMsg && lastMsg.role === 'agent' && (lastMsg.content || '').length > 0) {
      appendMessageEl(lastMsg, stripStatusTagFn);
    }
    if (lastMsg && lastMsg.role === 'agent' && (lastMsg.turnTokenUsage || lastMsg.usedModel)) {
      updateMessageTokenUsage(lastMsg);
    }
    if (autoScrollEnabled) scheduleScrollIfSticky();
  }

  function getStreamingBubbleBodyText(streamEl) {
    if (!streamEl) return '';
    if (streamEl._streamContentEl) return streamEl._streamContentEl.textContent || '';
    const label = streamEl.querySelector('.msg-label');
    let n = label ? label.nextElementSibling : null;
    while (n && n.classList && n.classList.contains('msg-images')) {
      n = n.nextElementSibling;
    }
    return n ? (n.textContent || '') : '';
  }

  function repairOrphanStreamingIfAny(messages, stripStatusTagFn) {
    if (!elMessages) return;
    const streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;

    const bodyText = getStreamingBubbleBodyText(streamEl);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'agent' && messages[i]._streaming) {
        messages[i].content = stripStatusTagFn(bodyText);
        delete messages[i]._streaming;
        break;
      }
    }

    streamEl.removeAttribute('id');
    delete streamEl._streamContentEl;
    streamReplyBuffer = '';
  }

  function finalizeBeforeUserMessage(messages, stripStatusTagFn) {
    clearReasoningStream();
    const last = messages[messages.length - 1];
    if (last && last.role === 'agent' && last._streaming) {
      finalizeStreamResponse(messages, stripStatusTagFn);
    } else {
      repairOrphanStreamingIfAny(messages, stripStatusTagFn);
    }
  }

  // ---- 发送/停止按钮 ----

  function setStreamingState(streaming) {
    setComposerAction(streaming ? 'stop' : 'send');
  }

  function setComposerAction(action) {
    if (!elSendBtn) return;
    if (action === 'stop') {
      elSendBtn.innerHTML = window.AppIcon ? window.AppIcon.html('stop', { width: 16 }) : '';
      elSendBtn.title = 'Stop';
      elSendBtn.classList.add('btn-stop');
      elSendBtn.dataset.action = 'stop';
    } else {
      elSendBtn.innerHTML = window.AppIcon ? window.AppIcon.html('send', { width: 16 }) : '';
      elSendBtn.title = 'Send';
      elSendBtn.classList.remove('btn-stop');
      elSendBtn.dataset.action = 'send';
    }
    if (window.AppIcon) window.AppIcon.hydrate(elSendBtn);
    if (elInput) elInput.disabled = false;
  }

  function getInputValue() {
    return elInput ? elInput.value : '';
  }

  function setInputValue(val) {
    if (elInput) elInput.value = val;
  }

  function focusInput() {
    if (elInput) elInput.focus();
  }

  /** 从后往前找匹配 toolName 的工具行 */
  function findLastToolActionRow(toolName) {
    if (!elTailRoot || !elTailAnchor) return null;
    let node = elTailAnchor.previousSibling;
    while (node) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-trace-group')) {
        const rows = node.querySelectorAll('.tool-action');
        for (let r = rows.length - 1; r >= 0; r--) {
          if (!toolName || rows[r].getAttribute('data-tool') === toolName) {
            return rows[r];
          }
        }
      }
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-action')) {
        if (!toolName || node.getAttribute('data-tool') === toolName) {
          return node;
        }
      }
      node = node.previousSibling;
    }
    return null;
  }

  /** @deprecated 使用 showDiffForToolCallId */
  function showDiffAfterToolAction(toolName, diffEl) {
    if (!elMessages || !diffEl) return;
    const row = findLastToolActionRow(toolName);
    if (!row) return;
    const block = row.parentNode && row.parentNode.classList.contains('tool-action-row-block')
      ? row.parentNode
      : null;
    if (block) {
      appendDiffToRowBlock(block, diffEl);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'tool-diff-wrap';
    wrap.appendChild(diffEl);
    row.parentNode.insertBefore(wrap, row.nextSibling);
  }

  function removeMessageElById(messageId) {
    if (!elMessages || !messageId) return false;
    const root = elMessages.querySelector(`.message[data-message-id="${messageId}"]`);
    if (!root || !root.parentNode) return false;
    const inHistory = isNodeInHistoryRegion(root);
    root.parentNode.removeChild(root);
    if (inHistory) notifyHistoryLayoutChange(root);
    else notifyTailLayoutChange();
    return true;
  }

  /** 用最新 msg 替换已有用户气泡（保持 DOM 位置），用于 shellCommand/正文拆分同步。 */
  function replaceUserMessageEl(msg, stripStatusTagFn) {
    if (!msg || !msg.id || msg.role !== 'user') return false;
    let oldEl = msg._el && msg._el.isConnected ? msg._el : null;
    if (!oldEl && elMessages) {
      oldEl = elMessages.querySelector(`.message.user[data-message-id="${msg.id}"]`);
    }
    if (!oldEl && elMessages && msg._prevId) {
      oldEl = elMessages.querySelector(`.message.user[data-message-id="${msg._prevId}"]`);
    }
    if (!oldEl || !oldEl.parentNode) return false;
    const msgIndex = typeof msg._msgIndex === 'number' ? msg._msgIndex : undefined;
    const newEl = createMessageEl(msg, stripStatusTagFn, msgIndex);
    oldEl.parentNode.replaceChild(newEl, oldEl);
    msg._el = newEl;
    if (isNodeInHistoryRegion(newEl)) notifyHistoryLayoutChange(newEl);
    else notifyTailLayoutChange();
    refreshRestoreButtonsVisibility();
    return true;
  }

  return {
    init,
    scrollToBottom,
    scrollToMessageIndex,
    getActiveUserMsgIndex,
    enableAutoScroll,
    followBottomAfterContentPatch,
    scheduleScrollIfSticky,
    isNearBottom,
    isAutoScrollEnabled() { return autoScrollEnabled; },
    getScrollStickyThresholdPx() { return SCROLL_STICKY_THRESHOLD_PX; },
    autoResizeInput,
    renderMessagesOnly,
    maybeRepartitionTailIfNeeded,
    appendMessageEl,
    removeMessageElById,
    replaceUserMessageEl,
    insertRemoteUserMessageEl,
    updateMessageContent,
    updateMessageImagesEl,
    updateMessageTokenUsage,
    appendStreamChunk,
    appendReasoningStreamChunk,
    appendReasoningStreamIfAbsent,
    clearReasoningStream,
    discardIncompleteStream,
    promoteAssistantBubbleToThinking,
    finalizeStreamResponse,
    updateMsgLabelTime,
    finalizeBeforeUserMessage,
    repairOrphanStreamingIfAny,
    appendToolAction,
    updateLastToolAction,
    resetLiveToolRoundTargets,
    clearLiveToolRoundDom,
    setLiveToolRoundActive,
    isLiveToolRoundActive,
    repairLiveToolGroupFold,
    setStreamingState,
    setComposerAction,
    getInputValue,
    setInputValue,
    focusInput,
    updateToolActionByCallId,
    scrollToToolCall,
    mountDiffForToolCallId,
    repairMissingDiffMountsFromStructured,
    showDiffForToolCallId,
    showDiffAfterToolAction,
    setRestoreAvailability,
    setCheckpointMessageIds,
    mergeCheckpointMessageIds,
    setCursorMessageId,
    isCurrentRestoreCursor,
    shouldHideRestoreAtCursor,
    isCursorRestored,
    hasCheckpointForMessage,
    resolveCheckpointMessageId,
    isChatRestoreAllowed,
    refreshRestoreButtonsVisibility,
    setMessageActionHandlers,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatUI = ChatUI;
}
