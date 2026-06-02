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
  var elInput = null;
  var elSendBtn = null;

  var streamReplyBuffer = '';

  /** 距底部小于该值时视为「贴底」，新内容会自动跟随滚动 */
  var SCROLL_STICKY_THRESHOLD_PX = 80;
  var autoScrollEnabled = true;
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
    ensureJumpBottomButton();
    setupContentResizeObserver();
    ensureDiffOutsideClose();
  }

  function distanceFromBottom() {
    if (!elMessages) return 0;
    return elMessages.scrollHeight - elMessages.scrollTop - elMessages.clientHeight;
  }

  function isNearBottom() {
    return distanceFromBottom() < SCROLL_STICKY_THRESHOLD_PX;
  }

  function syncAutoScrollFromViewport() {
    autoScrollEnabled = isNearBottom();
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
      updateJumpBottomButton();
    });
  }

  /** 用户发送等场景：强制恢复贴底并滚到底 */
  function enableAutoScroll() {
    autoScrollEnabled = true;
    scrollToBottom(true);
  }

  function scheduleScrollIfSticky() {
    if (!elMessages) return;
    if (!autoScrollEnabled && !isNearBottom()) {
      updateJumpBottomButton();
      return;
    }
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(function () {
      scrollRafId = 0;
      if (!elMessages) return;
      if (!autoScrollEnabled && !isNearBottom()) {
        updateJumpBottomButton();
        return;
      }
      suppressScrollSync = true;
      elMessages.scrollTop = elMessages.scrollHeight;
      requestAnimationFrame(function () {
        if (!elMessages) return;
        elMessages.scrollTop = elMessages.scrollHeight;
        suppressScrollSync = false;
        autoScrollEnabled = true;
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
      scheduleScrollIfSticky();
    });
    contentResizeObserver.observe(elMessages);
  }

  function notifyContentLayoutChange() {
    scheduleScrollIfSticky();
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
    var toolCallId = block.getAttribute('data-tool-call-id') || '';
    if (!toolCallId || !window.ToolDisplayHistory) return null;
    var structured = window.ChatSession && window.ChatSession.getStructuredMessages
      ? window.ChatSession.getStructuredMessages()
      : [];
    if (structured.length > 0 && typeof window.ToolDisplayHistory.buildToolCallDiffIndex === 'function') {
      var idx = window.ToolDisplayHistory.buildToolCallDiffIndex(structured);
      if (idx[toolCallId]) return idx[toolCallId];
    }
    if (structured.length > 0 && typeof window.ToolDisplayHistory.flattenStructuredToolEntries === 'function') {
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
    var resolved = lookupDiffSourceForBlock(block, toolName);

    function finish(ds) {
      if (!ds || !mountHiddenDiffInBlock(block, ds)) {
        if (done) done(false);
        return;
      }
      var nameEl = block.querySelector('.tool-action .tool-name');
      if (nameEl) {
        nameEl.classList.add('tool-diff-toggle');
        nameEl.classList.remove('tool-diff-toggle-pending');
        nameEl.setAttribute('title', '点击查看/关闭文件变更');
      }
      if (done) done(true);
    }

    if (resolved) {
      finish(resolved);
      return;
    }

    if (!toolCallId || !window.ChatSession || typeof window.ChatSession.fetchStructuredMessages !== 'function') {
      if (done) done(false);
      return;
    }

    window.ChatSession.fetchStructuredMessages(function (structured) {
      if (structured.length > 0 && window.ToolDisplayHistory
          && typeof window.ToolDisplayHistory.buildToolCallDiffIndex === 'function') {
        var index = window.ToolDisplayHistory.buildToolCallDiffIndex(structured);
        if (index[toolCallId]) {
          finish(index[toolCallId]);
          return;
        }
      }
      if (done) done(false);
    });
  }

  function toggleDiffPanelForBlock(block) {
    var wrap = block.querySelector('.tool-diff-wrap');
    if (!wrap) return;
    if (wrap.classList.contains('is-open')) {
      hideDiffWrap(wrap, block);
    } else {
      showDiffWrap(wrap, block);
    }
    notifyContentLayoutChange();
  }

  function bindDiffToggleRow(block, toolName) {
    if (!isDiffCapableToolName(toolName)) return;
    var nameEl = block.querySelector('.tool-action .tool-name');
    if (!nameEl) return;

    nameEl.classList.add('tool-diff-toggle');
    if (block.getAttribute('data-has-diff') === '1') {
      nameEl.classList.remove('tool-diff-toggle-pending');
      nameEl.setAttribute('title', '点击查看/关闭文件变更');
    } else {
      nameEl.classList.add('tool-diff-toggle-pending');
      nameEl.setAttribute('title', '点击加载文件变更');
    }

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
  function repairMissingDiffMounts(diffByCallId) {
    if (!elMessages || !diffByCallId) return;
    var blocks = elMessages.querySelectorAll('.tool-action-row-block[data-tool-call-id]');
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.getAttribute('data-has-diff') === '1') continue;
      var toolCallId = block.getAttribute('data-tool-call-id') || '';
      var diffSource = diffByCallId[toolCallId];
      if (!diffSource) continue;
      var row = block.querySelector('.tool-action');
      var toolName = row ? row.getAttribute('data-tool') : '';
      if (!toolName || !isDiffCapableToolName(toolName)) continue;
      if (mountHiddenDiffInBlock(block, diffSource)) {
        bindDiffToggleRow(block, toolName);
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
    notifyContentLayoutChange();
  }

  function createToolRowBlock(toolName, detail, status, toolCallId, diffSource) {
    var block = document.createElement('div');
    block.className = 'tool-action-row-block';
    if (toolCallId) block.setAttribute('data-tool-call-id', toolCallId);

    var row = createToolActionRow(toolName, detail, status, toolCallId);
    block.appendChild(row);

    if (diffSource) {
      mountHiddenDiffInBlock(block, diffSource);
    }
    bindDiffToggleRow(block, toolName);
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

  function bindToolTraceToggle(btn, collapsedEl) {
    btn.addEventListener('click', function () {
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
      notifyContentLayoutChange();
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

  /** 清掉 anchor 前连续的平铺工具行 / 工具组（F5 还原或新一轮发送前） */
  function clearTrailingToolDomBeforeAnchor() {
    if (!elAnchor) return;
    var node = elAnchor.previousElementSibling;
    while (node) {
      if (node.id === 'streaming-msg') {
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

  /** 把 anchor 前平铺的 tool-action 收进 live 折叠组 */
  function coalesceFlatToolActionsBeforeAnchor() {
    if (!elAnchor) return;
    var flats = [];
    var node = elAnchor.previousElementSibling;
    while (node) {
      if (node.id === 'streaming-msg') {
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

  function insertFoldableToolTraceGroup(traces, displays, insertBeforeNode) {
    if (!elMessages || !traces || traces.length === 0) return;
    displays = displays || [];

    function appendTraceRow(parent, tr, idx) {
      var disp = displays[idx];
      var diffSource = (tr.diffSource) || (disp && disp.diffSource) || null;
      var toolCallId = (disp && disp.toolCallId) || tr.toolCallId || '';
      parent.appendChild(createToolRowBlock(
        tr.toolName || '',
        tr.detail || '',
        tr.status || 'pending',
        toolCallId,
        diffSource,
      ));
    }

    var wrap = document.createElement('div');
    wrap.className = 'tool-trace-group';
    var visible = document.createElement('div');
    visible.className = 'tool-trace-visible';

    var max = TOOL_TRACE_VISIBLE_MAX;
    if (traces.length <= max) {
      for (var i = 0; i < traces.length; i++) {
        appendTraceRow(visible, traces[i], i);
      }
      wrap.appendChild(visible);
      elMessages.insertBefore(wrap, insertBeforeNode);
      return;
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
    bindToolTraceToggle(toggle, collapsed);

    for (var k = olderCount; k < traces.length; k++) {
      appendTraceRow(visible, traces[k], k);
    }

    wrap.appendChild(collapsed);
    wrap.appendChild(toggle);
    wrap.appendChild(visible);
    elMessages.insertBefore(wrap, insertBeforeNode);
  }

  function adoptOrCreateLiveToolGroupDom() {
    if (liveToolRoundRoot) {
      rebalanceToolTraceVisible(liveToolRoundVisible, liveToolRoundCollapsed, liveToolRoundToggle);
      return;
    }
    var prev = elAnchor ? elAnchor.previousElementSibling : null;
    while (prev && prev.id === 'streaming-msg') {
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
    bindToolTraceToggle(liveToolRoundToggle, liveToolRoundCollapsed);
    elMessages.insertBefore(liveToolRoundRoot, elAnchor);
  }

  function appendToolAction(toolName, detail, status, toolCallId, diffSource) {
    if (!elMessages) return null;
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

    elMessages.insertBefore(block, elAnchor);
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
    if (!elMessages || !toolCallId) return null;
    var escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(toolCallId) : toolCallId.replace(/"/g, '\\"');
    var blocks = elMessages.querySelectorAll('.tool-action-row-block[data-tool-call-id="' + escaped + '"]');
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
    if (!elMessages) return;
    var node = elAnchor ? elAnchor.previousSibling : elMessages.lastChild;
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
      notifyContentLayoutChange();
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
    if (elAnchor) elMessages.insertBefore(fallback, elAnchor);
    notifyContentLayoutChange();
  }

  function renderMessagesOnly(messages, toolTraces, stripStatusTagFn, shouldScroll, displayMap) {
    liveToolRoundActive = false;
    resetLiveToolRoundTargets();

    while (elMessages.firstChild !== elAnchor) {
      elMessages.removeChild(elMessages.firstChild);
    }

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var traces = msg.id ? toolTraces[msg.id] : null;
      if (traces && traces.length > 0) {
        var displays = (displayMap && msg.id && displayMap[msg.id]) ? displayMap[msg.id] : [];
        insertFoldableToolTraceGroup(traces, displays, elAnchor);
      }
      elMessages.insertBefore(createMessageEl(msg, stripStatusTagFn), elAnchor);
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
    if (!elMessages) return;
    elMessages.insertBefore(createMessageEl(msg, stripStatusTagFn), elAnchor);
    scheduleScrollIfSticky();
  }

  // ---- 流式输出 ----

  function appendStreamChunk(text, messages, stripStatusTagFn) {
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

      elMessages.insertBefore(el, elAnchor);
      scheduleScrollIfSticky();
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
      elMessages.insertBefore(wrap, elAnchor);
      scheduleScrollIfSticky();
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
    scheduleScrollIfSticky();
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
    scheduleScrollIfSticky();
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
    if (!elMessages) return null;
    var node = elAnchor ? elAnchor.previousSibling : elMessages.lastChild;
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
    appendMessageEl: appendMessageEl,
    appendStreamChunk: appendStreamChunk,
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
