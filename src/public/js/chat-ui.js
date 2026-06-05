/**
 * 聊天 UI 渲染模块
 * 负责：消息渲染、流式输出、工具调用展示、滚动控制、输入框管理
 */

/* exported ChatUI */

window.ChatUI = (function () {
  'use strict';

  var TOOL_TRACE_VISIBLE_MAX = 3;

  var elMessages = null;
  var elAnchor = null;
  var elHistoryOuter = null;
  var elHistoryWindow = null;
  var elTailRoot = null;
  var elTailAnchor = null;
  var virtualScroller = null;
  var lastStripStatusTagFn = function (t) { return t; };
  var elInput = null;
  var elSendBtn = null;

  var streamReplyBuffer = '';
  var streamReasoningBuffer = '';

  /** 距底部小于该值时视为「贴底」，新内容会自动跟随滚动 */
  var SCROLL_STICKY_THRESHOLD_PX = 80;
  var autoScrollEnabled = true;
  /** 用户主动离开底部后保持，避免阈值附近误恢复贴底跟滚 */
  var userPinnedScroll = false;
  var scrollRafId = 0;
  var suppressScrollSync = false;
  var elJumpBottom = null;
  var contentResizeObserver = null;

  // 实时工具区 DOM
  var liveToolRoundActive = false;
  var liveToolRoundRoot = null;
  var liveToolRoundVisible = null;
  var liveToolRoundCollapsed = null;
  var liveToolRoundToggle = null;
  var liveToolRoundCount = 0;
  var diffOutsideCloseBound = false;

  function init(els) {
    elMessages = els.elMessages;
    elAnchor = els.elAnchor;
    elInput = els.elInput;
    elSendBtn = els.elSendBtn;

    if (elMessages) {
      elMessages.addEventListener('scroll', onMessagesScroll, { passive: true });
    }
    ensureChatLayout();
    ensureJumpBottomButton();
    setupContentResizeObserver();
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
      var existingOuter = elMessages.querySelector('.chat-history-outer');
      var existingTail = elMessages.querySelector('.chat-tail-root');
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
    var t = e && e.target;
    if (!t) return null;
    return t.nodeType === 1 ? t : t.parentElement;
  }

  function handleHistoryToolNameClick(block, toolName, e) {
    if (!block || !toolName) return;
    var group = block.closest('.tool-trace-group');
    bindDiffToggleRow(block, toolName, true);
    if (block.getAttribute('data-has-diff') !== '1') {
      var ds = block._diffSource || resolveDiffSourceForHistoryBlock(block, group);
      if (ds && !mountHiddenDiffInBlock(block, ds)) {
        delete block._diffSource;
      }
    }
    if (block.getAttribute('data-has-diff') === '1') {
      toggleDiffPanelForBlock(block);
      return;
    }
    tryLazyMountDiffForBlock(block, toolName, function (ok) {
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
      var target = eventTargetElement(e);
      if (!target || !target.closest) return;
      var nameEl = target.closest('.tool-name');
      if (!nameEl || !elHistoryWindow.contains(nameEl)) return;
      var row = nameEl.closest('.tool-action');
      if (!row) return;
      var block = row.closest('.tool-action-row-block');
      if (!block) return;
      var toolName = row.getAttribute('data-tool') || '';
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
      var target = eventTargetElement(e);
      if (!target || !target.closest) return;
      var btn = target.closest('button.tool-trace-toggle, .tool-trace-toggle');
      if (!btn || btn.disabled || !elHistoryWindow.contains(btn)) return;
      var group = btn.closest('.tool-trace-group');
      if (!group) return;
      var collapsed = group.querySelector('.tool-trace-collapsed');
      if (!collapsed) return;
      e.preventDefault();
      e.stopPropagation();
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        collapsed.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '还有 ' + collapsed.children.length + ' 条历史 · 展开';
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

  function createThinkingToggleButton(footer) {
    var label = document.createElement('button');
    label.type = 'button';
    label.className = 'msg-label msg-thinking-toggle'
      + (footer ? ' msg-thinking-toggle-footer' : ' msg-thinking-toggle-header');
    label.setAttribute('aria-expanded', 'true');
    label.setAttribute('aria-label', '折叠思考内容');
    var labelText = document.createElement('span');
    labelText.className = 'msg-thinking-toggle-text';
    labelText.textContent = 'Thinking';
    label.appendChild(labelText);
    var labelIcon = document.createElement('span');
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
    var toggles = block.querySelectorAll('.msg-thinking-toggle');
    for (var i = 0; i < toggles.length; i++) {
      var t = toggles[i];
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
      var target = eventTargetElement(e);
      if (!target || !target.closest) return;
      var btn = target.closest('.msg-thinking-toggle');
      if (!btn || !elMessages.contains(btn)) return;
      var block = btn.closest('.message-thinking');
      if (!block) return;
      e.preventDefault();
      e.stopPropagation();
      var isExpanded = btn.getAttribute('aria-expanded') !== 'false';
      setThinkingBlockCollapsed(block, isExpanded);
      notifyTailLayoutChange();
    };
    elMessages.addEventListener('click', elMessages._thinkingToggleHandler);
  }

  var cachedToolCallDiffIndex = null;
  var cachedToolCallDiffIndexRef = null;
  var cachedTraceDiffIndex = null;
  var cachedTraceDiffSessionId = null;
  var cachedSessionWorkspaceRoot = null;
  var cachedSessionWorkspaceSessionId = null;
  var historyDisplayMapCache = null;

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
    var sid = getActiveSessionIdForApi();
    if (cachedTraceDiffIndex && cachedTraceDiffSessionId === sid) return;
    fetch('/api/sessions/' + encodeURIComponent(sid) + '/tool-trace-diffs', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : { index: {} }; })
      .then(function (data) {
        cachedTraceDiffIndex = (data && data.index) ? data.index : {};
        cachedTraceDiffSessionId = sid;
        cachedToolCallDiffIndex = null;
        cachedToolCallDiffIndexRef = null;
      })
      .catch(function () {
        cachedTraceDiffIndex = {};
        cachedTraceDiffSessionId = sid;
      });
  }

  function getToolCallDiffIndex() {
    if (!window.ToolDisplayHistory
        || typeof window.ToolDisplayHistory.buildToolCallDiffIndex !== 'function') {
      return cachedTraceDiffIndex || null;
    }
    var structured = getStructuredMessagesLocal();
    var fromStructured = structured.length > 0
      ? window.ToolDisplayHistory.buildToolCallDiffIndex(structured)
      : {};
    var fromTrace = cachedTraceDiffIndex || {};
    if (!structured.length && !Object.keys(fromTrace).length) return null;
    if (cachedToolCallDiffIndex && cachedToolCallDiffIndexRef === structured
        && cachedTraceDiffSessionId === getActiveSessionIdForApi()) {
      return cachedToolCallDiffIndex;
    }
    cachedToolCallDiffIndexRef = structured;
    cachedToolCallDiffIndex = Object.assign({}, fromStructured, fromTrace);
    return cachedToolCallDiffIndex;
  }

  function getSessionWorkspaceRoot(callback) {
    var sid = getActiveSessionIdForApi();
    if (cachedSessionWorkspaceRoot && cachedSessionWorkspaceSessionId === sid) {
      if (callback) callback(cachedSessionWorkspaceRoot);
      return;
    }
    fetch('/api/sessions/workspace/' + encodeURIComponent(sid), { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (data) {
        cachedSessionWorkspaceRoot = (data && data.workspaceRoot) ? String(data.workspaceRoot) : '';
        cachedSessionWorkspaceSessionId = sid;
        if (callback) callback(cachedSessionWorkspaceRoot);
      })
      .catch(function () {
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
    var group = block && block.closest ? block.closest('.tool-trace-group') : null;
    var relPath = block ? (block.getAttribute('data-diff-rel-path') || '') : '';
    var row = block ? block.querySelector('.tool-action') : null;
    if (!relPath && row) {
      var detailEl = row.querySelector('.tool-detail');
      if (detailEl && detailEl.textContent) relPath = detailEl.textContent.trim();
    }
    if (!relPath && group) {
      var msgId = group.getAttribute('data-agent-msg-id') || '';
      var traceIdx = getTraceIndexForBlock(block, group);
      var traces = msgId && window.ChatSession && window.ChatSession.getToolTraces
        ? (window.ChatSession.getToolTraces()[msgId] || [])
        : [];
      if (traceIdx >= 0 && traces[traceIdx] && traces[traceIdx].detail) {
        relPath = traces[traceIdx].detail;
      }
    }
    return relPath;
  }

  function fetchToolDiffFromServer(block, toolName, toolCallId, done) {
    var sid = getActiveSessionIdForApi();
    var relPath = resolveDiffRelPathForBlock(block);
    if (!shouldFetchToolDiffFromServer(toolName, relPath, block)) {
      if (done) done(null);
      return;
    }
    function doFetch(workspaceRoot) {
      var qs = '?toolName=' + encodeURIComponent(toolName || 'write_file');
      if (toolCallId) qs += '&toolCallId=' + encodeURIComponent(toolCallId);
      if (relPath) qs += '&path=' + encodeURIComponent(relPath);
      if (workspaceRoot) qs += '&workspaceRoot=' + encodeURIComponent(workspaceRoot);
      fetch('/api/sessions/' + encodeURIComponent(sid) + '/tool-diff' + qs, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('not found');
          return res.json();
        })
        .then(function (data) {
          if (data && data.diffSource) {
            block._diffSource = data.diffSource;
            done(data.diffSource);
          } else {
            done(null);
          }
        })
        .catch(function () { done(null); });
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
    var structured = getStructuredMessagesLocal();
    for (var i = 0; i < structured.length; i++) {
      var sm = structured[i];
      if (!sm || sm.role !== 'tool' || sm.toolCallId !== toolCallId) continue;
      if (typeof sm.content !== 'string') continue;
      var ds = window.ToolDisplayHistory.extractDiffSource(toolName, sm.content, null);
      if (ds) return ds;
    }
    return null;
  }

  function collectToolBlocksInTraceOrder(group) {
    var out = [];
    if (!group) return out;
    var collapsed = group.querySelector('.tool-trace-collapsed');
    var visible = group.querySelector('.tool-trace-visible');
    if (collapsed) {
      for (var c = 0; c < collapsed.children.length; c++) {
        if (isToolRowBlock(collapsed.children[c])) out.push(collapsed.children[c]);
      }
    }
    if (visible) {
      for (var v = 0; v < visible.children.length; v++) {
        if (isToolRowBlock(visible.children[v])) out.push(visible.children[v]);
      }
    }
    return out;
  }

  function getTraceIndexForBlock(block, group) {
    if (!block) return -1;
    var attr = block.getAttribute('data-trace-idx');
    if (attr !== null && attr !== '') {
      var parsed = parseInt(attr, 10);
      if (!isNaN(parsed) && parsed >= 0) return parsed;
    }
    if (!group) return -1;
    var blocks = collectToolBlocksInTraceOrder(group);
    for (var bi = 0; bi < blocks.length; bi++) {
      if (blocks[bi] === block) return bi;
    }
    return -1;
  }

  function resolveDiffSourceForHistoryBlock(block, group) {
    if (!block) return null;
    if (block._diffSource) return block._diffSource;

    var row = block.querySelector('.tool-action');
    var toolName = row ? row.getAttribute('data-tool') : '';
    var toolCallId = block.getAttribute('data-tool-call-id') || '';
    var msgId = group ? (group.getAttribute('data-agent-msg-id') || '') : '';
    var traceIdx = getTraceIndexForBlock(block, group);

    if (msgId && traceIdx >= 0 && historyDisplayMapCache && historyDisplayMapCache[msgId]) {
      var cachedDisp = historyDisplayMapCache[msgId][traceIdx];
      if (cachedDisp && cachedDisp.diffSource) return cachedDisp.diffSource;
    }

    var diffIndex = getToolCallDiffIndex();
    var traces = msgId && window.ChatSession && typeof window.ChatSession.getToolTraces === 'function'
      ? (window.ChatSession.getToolTraces()[msgId] || [])
      : [];
    var tr = traceIdx >= 0 && traces[traceIdx] ? traces[traceIdx] : null;

    if (toolCallId && diffIndex && diffIndex[toolCallId]) return diffIndex[toolCallId];

    var fromOutput = extractDiffFromStructuredToolOutput(toolName, toolCallId);
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
    var row = block.querySelector('.tool-action');
    var toolName = row ? row.getAttribute('data-tool') : '';
    if (!toolName || !isDiffCapableToolName(toolName)) return;
    var ds = resolveDiffSourceForHistoryBlock(block, group);
    if (ds) block._diffSource = ds;
    bindDiffToggleRow(block, toolName, true);
  }

  function primeHistoryDiffSourcesInGroup(group) {
    if (!group || !isNodeInHistoryRegion(group)) return;
    var blocks = collectToolBlocksInTraceOrder(group);
    for (var i = 0; i < blocks.length; i++) {
      primeHistoryDiffSource(blocks[i], group);
    }
  }

  function notifyTailLayoutChange() {
    if (!autoScrollEnabled) return;
    scheduleScrollIfSticky();
  }

  function notifyHistoryLayoutChange(originNode) {
    if (originNode && virtualScroller && typeof virtualScroller.invalidateHeight === 'function') {
      var slot = originNode.closest ? originNode.closest('.chat-vhistory-slot[data-vkey]') : null;
      if (slot) {
        var vkey = slot.getAttribute('data-vkey') || '';
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
      slot.appendChild(createMessageEl(unit.msg, lastStripStatusTagFn));
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
    var dist = distanceFromBottom();
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

  function onMessagesScroll() {
    if (suppressScrollSync) return;
    syncAutoScrollFromViewport();
    onVirtualHistoryScroll();
  }

  function scrollToBottom(force) {
    if (!elMessages) return;
    if (force !== true && !autoScrollEnabled) return;
    suppressScrollSync = true;
    elMessages.scrollTop = elMessages.scrollHeight;
    requestAnimationFrame(function () {
      if (!elMessages) return;
      elMessages.scrollTop = elMessages.scrollHeight;
      suppressScrollSync = false;
      autoScrollEnabled = true;
      updateFollowBottomClass();
      updateJumpBottomButton();
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
    scrollRafId = requestAnimationFrame(function () {
      scrollRafId = 0;
      if (!elMessages) return;
      if (userPinnedScroll || (!autoScrollEnabled && !isNearBottom())) {
        updateJumpBottomButton();
        return;
      }
      suppressScrollSync = true;
      elMessages.scrollTop = elMessages.scrollHeight;
      requestAnimationFrame(function () {
        if (!elMessages) return;
        elMessages.scrollTop = elMessages.scrollHeight;
        suppressScrollSync = false;
        userPinnedScroll = false;
        autoScrollEnabled = true;
        updateFollowBottomClass();
        updateJumpBottomButton();
      });
    });
  }

  function ensureJumpBottomButton() {
    if (elJumpBottom || !elMessages) return;
    var host = elMessages.parentElement;
    if (!host) return;
    elJumpBottom = document.createElement('button');
    elJumpBottom.type = 'button';
    elJumpBottom.className = 'chat-jump-bottom hidden';
    elJumpBottom.setAttribute('aria-label', '回到底部');
    elJumpBottom.title = '回到底部';
    elJumpBottom.innerHTML = '<span class="chat-jump-bottom-icon" aria-hidden="true">↓</span>';
    elJumpBottom.addEventListener('click', function () {
      enableAutoScroll();
    });
    host.appendChild(elJumpBottom);
  }

  function setupContentResizeObserver() {
    if (typeof ResizeObserver === 'undefined' || !elMessages || contentResizeObserver) return;
    contentResizeObserver = new ResizeObserver(function () {
      if (userPinnedScroll || (!autoScrollEnabled && !isNearBottom())) return;
      scheduleScrollIfSticky();
    });
    contentResizeObserver.observe(elMessages);
  }

  function notifyContentLayoutChange() {
    notifyTailLayoutChange();
  }

  function ensureDiffOutsideClose() {
    if (diffOutsideCloseBound) return;
    diffOutsideCloseBound = true;
    document.addEventListener('click', function (e) {
      if (!elMessages) return;
      if (!elMessages.querySelector('.tool-diff-wrap.is-open')) return;
      var target = e.target;
      if (target.closest && target.closest('.tool-diff-wrap.is-open')) return;
      if (target.closest && target.closest('.tool-name.tool-diff-toggle')) return;
      closeAllDiffPanels(null);
    });
  }

  function autoResizeInput() {
    if (!elInput) return;
    elInput.style.height = 'auto';
    elInput.style.height = Math.min(elInput.scrollHeight, 120) + 'px';
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
    var el = document.createElement('div');
    el.className = 'tool-action';
    el.setAttribute('data-tool', toolName);
    if (toolCallId) el.setAttribute('data-tool-call-id', toolCallId);

    var iconEl = document.createElement('span');
    iconEl.className = 'tool-icon ' + (status || 'pending');
    iconEl.textContent = iconTextForStatus(status || 'pending');
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
      var nameEl = block.querySelector('.tool-action .tool-name');
      if (nameEl) nameEl.classList.remove('is-diff-open');
    }
  }

  function closeAllDiffPanels(exceptBlock) {
    if (!elMessages) return;
    var openWraps = elMessages.querySelectorAll('.tool-diff-wrap.is-open');
    for (var i = 0; i < openWraps.length; i++) {
      var wrap = openWraps[i];
      var block = wrap.closest('.tool-action-row-block');
      if (block !== exceptBlock) hideDiffWrap(wrap, block);
    }
  }

  function showDiffWrap(wrap, block) {
    if (!wrap || !block) return;
    closeAllDiffPanels(block);
    wrap.classList.remove('is-hidden');
    wrap.classList.add('is-open');
    var nameEl = block.querySelector('.tool-action .tool-name');
    if (nameEl) nameEl.classList.add('is-diff-open');
  }

  function renderDiffElementFromSource(diffSource) {
    if (!diffSource) return null;
    var diffEl = null;
    if (window.ToolDisplayHistory && typeof window.ToolDisplayHistory.renderDiffElement === 'function') {
      diffEl = window.ToolDisplayHistory.renderDiffElement(diffSource);
    }
    if (!diffEl && window.DiffViewer && typeof DiffViewer.renderFromText === 'function') {
      diffEl = DiffViewer.renderFromText(diffSource, { compact: true });
    }
    return diffEl;
  }

  function wrapDiffWithPanel(diffEl) {
    var panel = document.createElement('div');
    panel.className = 'tool-diff-panel';
    panel.appendChild(diffEl);
    return panel;
  }

  /** 挂载 diff 内容但默认隐藏 */
  function mountHiddenDiffInBlock(block, diffSource) {
    if (!block || !diffSource) return false;
    var diffEl = renderDiffElementFromSource(diffSource);
    if (!diffEl) return false;

    block.setAttribute('data-has-diff', '1');
    block._diffSource = diffSource;

    var wrap = block.querySelector('.tool-diff-wrap');
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
      var group = block.closest('.tool-trace-group');
      return resolveDiffSourceForHistoryBlock(block, group);
    }
    var toolCallId = block.getAttribute('data-tool-call-id') || '';
    if (!window.ToolDisplayHistory) return null;
    if (toolCallId) {
      var diffIndex = getToolCallDiffIndex();
      if (diffIndex && diffIndex[toolCallId]) return diffIndex[toolCallId];
      var fromOutput = extractDiffFromStructuredToolOutput(toolName, toolCallId);
      if (fromOutput) return fromOutput;
    }
    var structured = getStructuredMessagesLocal();
    if (toolCallId && structured.length > 0
        && typeof window.ToolDisplayHistory.flattenStructuredToolEntries === 'function') {
      var flat = window.ToolDisplayHistory.flattenStructuredToolEntries(structured);
      for (var i = 0; i < flat.length; i++) {
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
    var toolCallId = block.getAttribute('data-tool-call-id') || '';

    function finishMounted(ds) {
      if (!ds || !mountHiddenDiffInBlock(block, ds)) {
        if (ds) delete block._diffSource;
        return false;
      }
      var nameEl = block.querySelector('.tool-action .tool-name');
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
      fetchToolDiffFromServer(block, toolName, toolCallId, function (fromApi) {
        if (finishMounted(fromApi)) return;
        if (thenFn) thenFn();
        else if (done) done(false);
      });
    }

    function afterStructuredFetch() {
      var retry = lookupDiffSourceForBlock(block, toolName);
      if (finishMounted(retry)) return;
      var relPath = resolveDiffRelPathForBlock(block);
      if (!shouldFetchToolDiffFromServer(toolName, relPath, block)) {
        if (done) done(false);
        return;
      }
      fetchFromApi(function () { if (done) done(false); });
    }

    function fetchStructuredThenTryApi() {
      if (!window.ChatSession || typeof window.ChatSession.fetchStructuredMessages !== 'function') {
        afterStructuredFetch();
        return;
      }
      window.ChatSession.fetchStructuredMessages(function (structured) {
        if (structured.length > 0 && window.ToolDisplayHistory
            && typeof window.ToolDisplayHistory.buildToolCallDiffIndex === 'function') {
          var index = window.ToolDisplayHistory.buildToolCallDiffIndex(structured);
          cachedToolCallDiffIndex = Object.assign({}, index, cachedTraceDiffIndex || {});
          cachedToolCallDiffIndexRef = structured;
          if (toolCallId && index[toolCallId] && finishMounted(index[toolCallId])) return;
        }
        afterStructuredFetch();
      });
    }

    var resolved = lookupDiffSourceForBlock(block, toolName);
    if (finishMounted(resolved)) return;

    fetchStructuredThenTryApi();
  }

  function toggleDiffPanelForBlock(block) {
    var wrap = block.querySelector('.tool-diff-wrap');
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
    var nameEl = block.querySelector('.tool-action .tool-name');
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
    nameEl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (block.getAttribute('data-has-diff') === '1') {
        toggleDiffPanelForBlock(block);
        return;
      }
      tryLazyMountDiffForBlock(block, toolName, function (ok) {
        if (ok) toggleDiffPanelForBlock(block);
      });
    });
  }

  /** 历史重绘后：按 toolCallId 补挂 structured / tool_trace 中的 diff */
  function queryToolRowBlocks(toolCallId) {
    var escaped = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(toolCallId)
      : toolCallId.replace(/"/g, '\\"');
    var sel = '.tool-action-row-block[data-tool-call-id="' + escaped + '"]';
    var out = [];
    if (elTailRoot) {
      var tailBlocks = elTailRoot.querySelectorAll(sel);
      for (var t = 0; t < tailBlocks.length; t++) out.push(tailBlocks[t]);
    }
    if (elHistoryWindow) {
      var histBlocks = elHistoryWindow.querySelectorAll(sel);
      for (var h = 0; h < histBlocks.length; h++) out.push(histBlocks[h]);
    }
    if (!out.length && elMessages) {
      var fallback = elMessages.querySelectorAll(sel);
      for (var f = 0; f < fallback.length; f++) out.push(fallback[f]);
    }
    return out;
  }

  function repairMissingDiffMounts(diffByCallId) {
    if (!diffByCallId) return;
    var blocks = elMessages
      ? elMessages.querySelectorAll('.tool-action-row-block[data-tool-call-id]')
      : [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.getAttribute('data-has-diff') === '1') continue;
      var toolCallId = block.getAttribute('data-tool-call-id') || '';
      var diffSource = diffByCallId[toolCallId];
      if (!diffSource) continue;
      var row = block.querySelector('.tool-action');
      var toolName = row ? row.getAttribute('data-tool') : '';
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
    var wrap = block.querySelector('.tool-diff-wrap');
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
    var row = block.querySelector('.tool-action');
    var toolName = row ? row.getAttribute('data-tool') : '';
    bindDiffToggleRow(block, toolName || '');
    if (isNodeInHistoryRegion(block)) notifyHistoryLayoutChange(block);
    else notifyTailLayoutChange();
  }

  function createToolRowBlock(toolName, detail, status, toolCallId, diffSource, forHistory) {
    var block = document.createElement('div');
    block.className = 'tool-action-row-block';
    if (toolCallId) block.setAttribute('data-tool-call-id', toolCallId);

    var row = createToolActionRow(toolName, detail, status, toolCallId);
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
    var group = groupEl || (btn.closest ? btn.closest('.tool-trace-group') : null);
    if (btn.getAttribute('data-trace-toggle-bound') === '1') return;
    btn.setAttribute('data-trace-toggle-bound', '1');
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        collapsedEl.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '还有 ' + collapsedEl.children.length + ' 条历史 · 展开';
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
    btn.textContent = btn.getAttribute('aria-expanded') === 'true' ? '收起' : '还有 ' + collapsedEl.children.length + ' 条历史 · 展开';
  }

  function rebalanceToolTraceVisible(visibleEl, collapsedEl, toggleEl) {
    if (!visibleEl || !collapsedEl) return;
    while (visibleEl.children.length > TOOL_TRACE_VISIBLE_MAX) {
      var oldest = visibleEl.firstChild;
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
    var node = elTailAnchor.previousElementSibling;
    while (node) {
      if (node.id === 'streaming-msg' || node.id === 'streaming-reasoning-msg') {
        node = node.previousElementSibling;
        continue;
      }
      if (node.classList && isToolTraceContainer(node)) {
        var rm = node;
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
    var flats = [];
    var node = elTailAnchor.previousElementSibling;
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
    for (var i = 0; i < flats.length; i++) {
      liveToolRoundVisible.appendChild(flats[i]);
    }
    rebalanceToolTraceVisible(liveToolRoundVisible, liveToolRoundCollapsed, liveToolRoundToggle);
  }

  function buildToolTraceGroupElement(traces, displays, opts) {
    if (!traces || traces.length === 0) return null;
    displays = displays || [];
    opts = opts || {};
    var forHistory = !!opts.forHistory;

    function appendTraceRow(parent, tr, idx) {
      var disp = displays[idx];
      var diffSource = (tr.diffSource) || (disp && disp.diffSource) || null;
      var toolCallId = tr.toolCallId || '';
      if (!diffSource && toolCallId) {
        diffSource = extractDiffFromStructuredToolOutput(tr.toolName || '', toolCallId);
      }
      var block = createToolRowBlock(
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

    var wrap = document.createElement('div');
    wrap.className = 'tool-trace-group';
    if (opts.agentMsgId) wrap.setAttribute('data-agent-msg-id', opts.agentMsgId);
    var visible = document.createElement('div');
    visible.className = 'tool-trace-visible';

    var max = TOOL_TRACE_VISIBLE_MAX;
    if (traces.length <= max) {
      for (var i = 0; i < traces.length; i++) {
        appendTraceRow(visible, traces[i], i);
      }
      wrap.appendChild(visible);
      return wrap;
    }

    var olderCount = traces.length - max;
    var collapsed = document.createElement('div');
    collapsed.className = 'tool-trace-collapsed';
    collapsed.style.display = 'none';
    for (var j = 0; j < olderCount; j++) {
      appendTraceRow(collapsed, traces[j], j);
    }
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-trace-toggle';
    toggle.textContent = '还有 ' + olderCount + ' 条历史 · 展开';

    for (var k = olderCount; k < traces.length; k++) {
      appendTraceRow(visible, traces[k], k);
    }

    wrap.appendChild(collapsed);
    wrap.appendChild(toggle);
    wrap.appendChild(visible);
    bindToolTraceToggle(toggle, collapsed, wrap, forHistory);
    return wrap;
  }

  function insertFoldableToolTraceGroup(traces, displays, agentMsgId) {
    var wrap = buildToolTraceGroupElement(traces, displays, {
      agentMsgId: agentMsgId || '',
    });
    if (wrap) insertTailBefore(wrap);
  }

  function adoptOrCreateLiveToolGroupDom() {
    if (liveToolRoundRoot) {
      rebalanceToolTraceVisible(liveToolRoundVisible, liveToolRoundCollapsed, liveToolRoundToggle);
      return;
    }
    var prev = elTailAnchor ? elTailAnchor.previousElementSibling : null;
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
    var block = createToolRowBlock(toolName, detail, status || 'pending', toolCallId || '', diffSource || null);

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
    var blocks = queryToolRowBlocks(toolCallId);
    if (blocks.length > 0) return blocks[blocks.length - 1];
    return null;
  }

  function updateToolActionByCallId(toolCallId, toolName, status) {
    if (!elMessages) return;
    var block = toolCallId ? findToolRowBlockByCallId(toolCallId) : null;
    var row = block ? block.querySelector('.tool-action') : null;
    if (!row) {
      updateLastToolAction(toolName, status);
      return;
    }
    var iconEl = row.querySelector('.tool-icon');
    if (iconEl) {
      iconEl.className = 'tool-icon ' + status;
      iconEl.textContent = iconTextForStatus(status);
    }
    notifyContentLayoutChange();
  }

  function updateLastToolAction(toolName, status) {
    if (!elTailRoot || !elTailAnchor) return;
    var node = elTailAnchor.previousSibling;
    while (node) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-trace-group')) {
        var rows = node.querySelectorAll('.tool-action');
        for (var r = rows.length - 1; r >= 0; r--) {
          if (rows[r].getAttribute('data-tool') === toolName) {
            var iconEl = rows[r].querySelector('.tool-icon');
            if (iconEl) {
              iconEl.className = 'tool-icon ' + status;
              iconEl.textContent = iconTextForStatus(status);
            }
            notifyContentLayoutChange();
            return;
          }
        }
      }
      if (node.nodeType === 1 && isToolRowBlock(node)) {
        var rowInBlock = node.querySelector('.tool-action');
        if (rowInBlock && rowInBlock.getAttribute('data-tool') === toolName) {
          var iconEl3 = rowInBlock.querySelector('.tool-icon');
          if (iconEl3) {
            iconEl3.className = 'tool-icon ' + status;
            iconEl3.textContent = iconTextForStatus(status);
          }
          notifyContentLayoutChange();
          return;
        }
      }
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-action') && node.getAttribute('data-tool') === toolName) {
        var iconEl2 = node.querySelector('.tool-icon');
        if (iconEl2) {
          iconEl2.className = 'tool-icon ' + status;
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

  function createMessageEl(msg, stripStatusTagFn) {
    var el = document.createElement('div');
    el.className = 'message ' + msg.role;

    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = msg.role === 'user' ? 'You' : 'Assistant';
    el.appendChild(label);

    if (msg.images && msg.images.length > 0) {
      var imgRow = document.createElement('div');
      imgRow.className = 'msg-images';
      for (var j = 0; j < msg.images.length; j++) {
        var img = document.createElement('img');
        img.src = msg.images[j];
        img.className = 'msg-image-thumb';
        img.alt = '图片 ' + (j + 1);
        imgRow.appendChild(img);
      }
      el.appendChild(imgRow);
    }

    var content = document.createElement('div');
    content.textContent = msg.role === 'agent' ? stripStatusTagFn(msg.content) : msg.content;
    el.appendChild(content);

    return el;
  }

  /** 挂载 diff（默认隐藏）；tool_result 后更新 diff 源 */
  function mountDiffForToolCallId(toolCallId, diffSource) {
    if (!elMessages || !toolCallId || !diffSource) return false;
    var block = findToolRowBlockByCallId(toolCallId);
    if (!block) return false;
    var ok = mountHiddenDiffInBlock(block, diffSource);
    if (ok) {
      var row = block.querySelector('.tool-action');
      var toolName = row ? row.getAttribute('data-tool') : '';
      bindDiffToggleRow(block, toolName || '');
      if (isNodeInHistoryRegion(block)) notifyHistoryLayoutChange(block);
      else notifyTailLayoutChange();
    }
    return ok;
  }

  /** @deprecated 使用 mountDiffForToolCallId（不再自动展开） */
  function showDiffForToolCallId(toolCallId, diffEl) {
    if (!elMessages || !diffEl || !toolCallId) return;
    var block = findToolRowBlockByCallId(toolCallId);
    if (block) {
      appendDiffToRowBlock(block, diffEl);
      return;
    }
    var fallback = document.createElement('div');
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

    var tailStart = 0;
    if (window.ChatVirtualHistory && typeof window.ChatVirtualHistory.computeTailStartIndex === 'function') {
      tailStart = window.ChatVirtualHistory.computeTailStartIndex(
        messages,
        window.ChatVirtualHistory.TAIL_TURN_COUNT,
      );
    }

    if (virtualScroller && window.ChatVirtualHistory) {
      var historyUnits = window.ChatVirtualHistory.buildHistoryUnits(
        messages,
        toolTraces,
        displayMap,
        tailStart,
      );
      virtualScroller.setUnits(historyUnits);
    }

    for (var i = tailStart; i < messages.length; i++) {
      var msg = messages[i];
      var msgTraces = msg.id ? toolTraces[msg.id] : null;
      if (msgTraces && msgTraces.length > 0) {
        var msgDisplays = (displayMap && msg.id && displayMap[msg.id]) ? displayMap[msg.id] : [];
        insertFoldableToolTraceGroup(msgTraces, msgDisplays, msg.id);
      }
      insertTailBefore(createMessageEl(msg, stripStatusTagFn));
    }

    if (shouldScroll === 'force') {
      enableAutoScroll();
    } else if (shouldScroll !== false) {
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
    insertTailBefore(createMessageEl(msg, stripStatusTagFn));
    if (autoScrollEnabled) scheduleScrollIfSticky();
  }

  /**
   * 尾部真实 DOM 中用户轮次超过 N 时，重绘以把更早轮次迁入虚拟历史区。
   * （仅靠 append 不重绘时，第 3+ 轮会一直堆在 tail-root）
   */
  function maybeRepartitionTailIfNeeded(messages, toolTraces, stripStatusTagFn, shouldScroll, displayMap) {
    if (!elTailRoot || !window.ChatVirtualHistory) return;
    var maxTurns = window.ChatVirtualHistory.TAIL_TURN_COUNT || 2;
    var userBubbles = elTailRoot.querySelectorAll('.message.user');
    if (userBubbles.length <= maxTurns) return;
    renderMessagesOnly(messages, toolTraces, stripStatusTagFn, shouldScroll, displayMap);
  }

  // ---- 流式输出 ----

  function clearReasoningStream() {
    streamReasoningBuffer = '';
    var el = document.getElementById('streaming-reasoning-msg');
    if (el) el.remove();
  }

  /** 将误落入 Assistant 正文的规划/推理气泡转为 Thinking 样式（并合并进思考流缓冲）。 */
  function promoteAssistantBubbleToThinking(stripStatusTagFn) {
    var stripFn = stripStatusTagFn || lastStripStatusTagFn;
    var el = document.getElementById('streaming-msg');
    if (!el && elTailRoot) {
      var nodes = elTailRoot.querySelectorAll('.message.assistant:not(.message-thinking), .message.agent:not(.message-thinking)');
      if (nodes.length) el = nodes[nodes.length - 1];
    }
    if (!el || el.classList.contains('message-thinking')) return;

    var bodyText = stripFn(getStreamingBubbleBodyText(el));
    if (!bodyText) return;

    var wasStreaming = el.id === 'streaming-msg';
    if (el.parentNode) el.parentNode.removeChild(el);
    if (wasStreaming) streamReplyBuffer = '';

    if (streamReasoningBuffer && bodyText.length <= streamReasoningBuffer.length
        && streamReasoningBuffer.indexOf(bodyText) >= 0) {
      return;
    }
    appendReasoningStreamChunk(bodyText);
  }

  /** 非流式 / 流式回退时，由 harness thinking step 补齐思考块 */
  function appendReasoningStreamIfAbsent(text) {
    if (!text) return;
    if (streamReasoningBuffer && streamReasoningBuffer.indexOf(text) >= 0) return;
    appendReasoningStreamChunk(text);
  }

  function appendReasoningStreamChunk(text) {
    ensureChatLayout();
    if (!text) return;
    streamReasoningBuffer += text;
    var el = document.getElementById('streaming-reasoning-msg');
    if (!el) {
      el = document.createElement('div');
      el.className = 'message assistant message-thinking';
      el.setAttribute('id', 'streaming-reasoning-msg');
      el.appendChild(createThinkingToggleButton(false));
      var body = document.createElement('div');
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
    var lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'agent' && lastMsg._streaming) {
      streamReplyBuffer += text;
      lastMsg.content = streamReplyBuffer;
    } else {
      repairOrphanStreamingIfAny(messages, stripStatusTagFn);
      streamReplyBuffer += text;
      messages.push({ role: 'agent', content: streamReplyBuffer, _streaming: true });

      var el = document.createElement('div');
      el.className = 'message assistant';
      el.setAttribute('id', 'streaming-msg');

      var label = document.createElement('div');
      label.className = 'msg-label';
      label.textContent = 'Assistant';
      el.appendChild(label);

      var contentDiv = document.createElement('div');
      contentDiv.textContent = stripStatusTagFn(streamReplyBuffer);
      el.appendChild(contentDiv);
      el._streamContentEl = contentDiv;

      insertTailBefore(el);
      if (autoScrollEnabled) scheduleScrollIfSticky();
      return;
    }

    var streamEl = document.getElementById('streaming-msg');
    if (!streamEl) {
      var wrap = document.createElement('div');
      wrap.className = 'message assistant';
      wrap.setAttribute('id', 'streaming-msg');
      var lab = document.createElement('div');
      lab.className = 'msg-label';
      lab.textContent = 'Assistant';
      wrap.appendChild(lab);
      var contentDiv = document.createElement('div');
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
      var contentEl = streamEl.lastChild;
      if (contentEl) {
        contentEl.textContent = stripStatusTagFn(streamReplyBuffer);
        streamEl._streamContentEl = contentEl;
      }
    }
    if (autoScrollEnabled) scheduleScrollIfSticky();
  }

  function finalizeStreamResponse(messages, stripStatusTagFn) {
    var lastMsg = messages[messages.length - 1];
    var wasStreaming = !!(lastMsg && lastMsg._streaming);
    if (lastMsg && lastMsg._streaming) {
      delete lastMsg._streaming;
      lastMsg.content = stripStatusTagFn(lastMsg.content);
    }
    streamReplyBuffer = '';
    var streamEl = document.getElementById('streaming-msg');
    if (streamEl) {
      if (streamEl._streamContentEl) {
        streamEl._streamContentEl.textContent = stripStatusTagFn(streamEl._streamContentEl.textContent || '');
      }
      streamEl.removeAttribute('id');
      delete streamEl._streamContentEl;
    } else if (wasStreaming && lastMsg && lastMsg.role === 'agent' && (lastMsg.content || '').length > 0) {
      appendMessageEl(lastMsg, stripStatusTagFn);
    }
    if (autoScrollEnabled) scheduleScrollIfSticky();
  }

  function getStreamingBubbleBodyText(streamEl) {
    if (!streamEl) return '';
    if (streamEl._streamContentEl) return streamEl._streamContentEl.textContent || '';
    var label = streamEl.querySelector('.msg-label');
    var n = label ? label.nextElementSibling : null;
    while (n && n.classList && n.classList.contains('msg-images')) {
      n = n.nextElementSibling;
    }
    return n ? (n.textContent || '') : '';
  }

  function repairOrphanStreamingIfAny(messages, stripStatusTagFn) {
    if (!elMessages) return;
    var streamEl = document.getElementById('streaming-msg');
    if (!streamEl) return;

    var bodyText = getStreamingBubbleBodyText(streamEl);
    for (var i = messages.length - 1; i >= 0; i--) {
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
    var last = messages[messages.length - 1];
    if (last && last.role === 'agent' && last._streaming) {
      finalizeStreamResponse(messages, stripStatusTagFn);
    } else {
      repairOrphanStreamingIfAny(messages, stripStatusTagFn);
    }
  }

  // ---- 发送/停止按钮 ----

  function setStreamingState(streaming) {
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
    var node = elTailAnchor.previousSibling;
    while (node) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('tool-trace-group')) {
        var rows = node.querySelectorAll('.tool-action');
        for (var r = rows.length - 1; r >= 0; r--) {
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
    var row = findLastToolActionRow(toolName);
    if (!row) return;
    var block = row.parentNode && row.parentNode.classList.contains('tool-action-row-block')
      ? row.parentNode
      : null;
    if (block) {
      appendDiffToRowBlock(block, diffEl);
      return;
    }
    var wrap = document.createElement('div');
    wrap.className = 'tool-diff-wrap';
    wrap.appendChild(diffEl);
    row.parentNode.insertBefore(wrap, row.nextSibling);
  }

  return {
    init: init,
    scrollToBottom: scrollToBottom,
    enableAutoScroll: enableAutoScroll,
    scheduleScrollIfSticky: scheduleScrollIfSticky,
    isNearBottom: isNearBottom,
    isAutoScrollEnabled: function () { return autoScrollEnabled; },
    getScrollStickyThresholdPx: function () { return SCROLL_STICKY_THRESHOLD_PX; },
    autoResizeInput: autoResizeInput,
    renderMessagesOnly: renderMessagesOnly,
    maybeRepartitionTailIfNeeded: maybeRepartitionTailIfNeeded,
    appendMessageEl: appendMessageEl,
    appendStreamChunk: appendStreamChunk,
    appendReasoningStreamChunk: appendReasoningStreamChunk,
    appendReasoningStreamIfAbsent: appendReasoningStreamIfAbsent,
    clearReasoningStream: clearReasoningStream,
    promoteAssistantBubbleToThinking: promoteAssistantBubbleToThinking,
    finalizeStreamResponse: finalizeStreamResponse,
    finalizeBeforeUserMessage: finalizeBeforeUserMessage,
    repairOrphanStreamingIfAny: repairOrphanStreamingIfAny,
    appendToolAction: appendToolAction,
    updateLastToolAction: updateLastToolAction,
    resetLiveToolRoundTargets: resetLiveToolRoundTargets,
    clearLiveToolRoundDom: clearLiveToolRoundDom,
    setLiveToolRoundActive: setLiveToolRoundActive,
    isLiveToolRoundActive: isLiveToolRoundActive,
    repairLiveToolGroupFold: repairLiveToolGroupFold,
    setStreamingState: setStreamingState,
    getInputValue: getInputValue,
    setInputValue: setInputValue,
    focusInput: focusInput,
    updateToolActionByCallId: updateToolActionByCallId,
    mountDiffForToolCallId: mountDiffForToolCallId,
    repairMissingDiffMountsFromStructured: repairMissingDiffMountsFromStructured,
    showDiffForToolCallId: showDiffForToolCallId,
    showDiffAfterToolAction: showDiffAfterToolAction,
  };
})();
