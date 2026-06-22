/**
 * 聊天历史区虚拟滚动（translateY + 前缀偏移 + 二分可见区 + 逐条 ResizeObserver）。
 * 尾部最近 1 轮用户对话由 chat-ui 真实 DOM 负责。
 */

/* exported ChatVirtualHistory */

window.ChatVirtualHistory = (function () {
  'use strict';

  /** 尾部保留的真实 DOM：最近 1 轮（从最后一条 user 消息起） */
  var TAIL_TURN_COUNT = 1;
  var UNIT_GAP_PX = 12;
  var OVERSCAN_PX = 400;
  var OVERSCAN_ITEMS = 5;
  var SCROLL_RENDER_DEBOUNCE_MS = 32;
  var RO_DEBOUNCE_MS = 50;
  var CONTAINER_RESIZE_DEBOUNCE_MS = 500;
  var DEFAULT_MESSAGE_HEIGHT = 96;
  var DEFAULT_TOOLS_ROW_HEIGHT = 36;
  var DEFAULT_TOOLS_GROUP_EXTRA = 8;
  /** 与 chat-ui.js TOOL_TRACE_VISIBLE_MAX 一致 */
  var TOOL_TRACE_VISIBLE_MAX = 3;

  function computeTailStartIndex(messages, tailTurnCount) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    var n = typeof tailTurnCount === 'number' && tailTurnCount > 0 ? tailTurnCount : TAIL_TURN_COUNT;
    var userIndices = [];
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') userIndices.push(i);
    }
    if (userIndices.length <= n) return 0;
    return userIndices[userIndices.length - n];
  }

  function buildHistoryUnits(messages, toolTraces, displayMap, tailStartIndex) {
    var units = [];
    if (!Array.isArray(messages) || tailStartIndex <= 0) return units;
    var end = Math.min(tailStartIndex, messages.length);
    for (var i = 0; i < end; i++) {
      var msg = messages[i];
      var traces = msg.id && toolTraces ? toolTraces[msg.id] : null;
      if (traces && traces.length > 0) {
        units.push({
          type: 'tools',
          key: 'tools:' + (msg.id || i),
          msgId: msg.id || '',
          traces: traces,
          displays: (displayMap && msg.id && displayMap[msg.id]) ? displayMap[msg.id] : [],
        });
      }
      units.push({
        type: 'message',
        key: 'msg:' + (msg.id || i) + ':' + msg.role,
        msg: msg,
        msgIndex: i,
      });
    }
    return units;
  }

  function estimateUnitHeight(unit) {
    if (!unit) return DEFAULT_MESSAGE_HEIGHT;
    if (unit.type === 'tools') {
      var n = unit.traces ? unit.traces.length : 0;
      var visibleRows = n > 0 ? Math.min(n, TOOL_TRACE_VISIBLE_MAX) : 0;
      var collapsedBtn = n > TOOL_TRACE_VISIBLE_MAX ? 28 : 0;
      return DEFAULT_TOOLS_GROUP_EXTRA + visibleRows * DEFAULT_TOOLS_ROW_HEIGHT + collapsedBtn;
    }
    if (unit.type === 'message' && unit.msg) {
      var text = typeof unit.msg.content === 'string' ? unit.msg.content : '';
      var lineBreaks = (text.match(/\n/g) || []).length + 1;
      var codeBlocks = (text.match(/```/g) || []).length / 2;
      var tableRows = (text.match(/^\|/gm) || []).length;
      var lines = Math.max(lineBreaks, Math.ceil(text.length / 40));
      var imgExtra = (unit.msg.images && unit.msg.images.length > 0) ? 120 : 0;
      var codeExtra = Math.floor(codeBlocks) * 120;
      var tableExtra = tableRows * 28;
      return Math.max(
        DEFAULT_MESSAGE_HEIGHT,
        48 + lines * 24 + imgExtra + codeExtra + tableExtra,
      );
    }
    return DEFAULT_MESSAGE_HEIGHT;
  }

  function createScroller() {
    var outerEl = null;
    var windowEl = null;
    var scrollRoot = null;
    var renderUnitFn = null;
    var onAfterVisibleRender = null;
    var units = [];
    var heightCache = {};
    /** offsets[i] = 第 i 个单元顶部距列表起点；offsets[n] = 总高度 */
    var offsets = [];
    var totalHeight = 0;
    var phantomEl = null;
    var layerEl = null;
    var roDebounceTimer = 0;
    var roDirtyFrom = -1;
    var heightCommitTimer = 0;
    var heightDirtyFrom = -1;
    var containerResizeObserver = null;
    var containerResizeTimer = 0;
    var lastContainerWidth = 0;
    var suppressSlotResize = false;
    var rafPending = 0;
    var pendingRender = false;
    var scrollDebounceTimer = 0;
    var scrollIdleTimer = 0;
    var isScrolling = false;
    var lastRangeStart = -1;
    var lastRangeEnd = -2;
    var restoringScroll = false;
    var stickyThresholdPx = 80;

    function getHeight(unit) {
      if (!unit || !unit.key) return DEFAULT_MESSAGE_HEIGHT;
      if (heightCache[unit.key] > 0) return heightCache[unit.key];
      return estimateUnitHeight(unit);
    }

    function indexOfKey(key) {
      for (var i = 0; i < units.length; i++) {
        if (units[i].key === key) return i;
      }
      return -1;
    }

    function rebuildOffsets(fromIndex) {
      var n = units.length;
      if (!n) {
        offsets = [0];
        totalHeight = 0;
        return;
      }
      var start = typeof fromIndex === 'number' && fromIndex >= 0 ? fromIndex : 0;
      if (start === 0) {
        if (offsets.length !== n + 1) offsets = new Array(n + 1);
        offsets[0] = 0;
      } else {
        if (offsets.length !== n + 1) {
          var next = new Array(n + 1);
          for (var c = 0; c <= start && c < offsets.length; c++) next[c] = offsets[c];
          offsets = next;
        }
      }
      for (var i = start; i < n; i++) {
        var gap = i < n - 1 ? UNIT_GAP_PX : 0;
        offsets[i + 1] = offsets[i] + getHeight(units[i]) + gap;
      }
      totalHeight = offsets[n];
    }

    function getViewCoords() {
      if (!scrollRoot || !outerEl) return { viewTop: 0, viewBottom: 0 };
      var historyTop = outerEl.offsetTop;
      var viewTop = scrollRoot.scrollTop - historyTop;
      return {
        viewTop: viewTop,
        viewBottom: viewTop + scrollRoot.clientHeight,
      };
    }

    function isNearChatBottom() {
      if (!scrollRoot) return false;
      var dist = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight;
      return dist < stickyThresholdPx;
    }

    function isViewingHistoryContent(viewTop) {
      if (!units.length) return false;
      return viewTop < totalHeight;
    }

    /** 二分：首个满足单元底边 > target 的索引 */
    function findFirstIndexByOffset(target) {
      var n = units.length;
      if (!n) return 0;
      var lo = 0;
      var hi = n - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (offsets[mid + 1] <= target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    /** 二分：最后一个满足单元顶边 <= target 的索引 */
    function findLastIndexByOffset(target) {
      var n = units.length;
      if (!n) return -1;
      var lo = 0;
      var hi = n - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (offsets[mid] > target) hi = mid - 1;
        else lo = mid;
      }
      return lo;
    }

    function findIndexRange(viewTop, viewBottom) {
      if (!units.length) return { start: 0, end: -1 };
      var start = findFirstIndexByOffset(viewTop - OVERSCAN_PX);
      var end = findLastIndexByOffset(viewBottom + OVERSCAN_PX);
      start = Math.max(0, start - OVERSCAN_ITEMS);
      end = Math.min(units.length - 1, end + OVERSCAN_ITEMS);
      return { start: start, end: Math.max(start, end) };
    }

    function applyHeights() {
      var px = totalHeight > 0 ? (totalHeight + 'px') : '0px';
      if (phantomEl) phantomEl.style.height = px;
      if (windowEl) {
        windowEl.style.height = px;
        windowEl.style.minHeight = px;
      }
      if (outerEl) {
        outerEl.style.minHeight = px;
        outerEl.style.height = 'auto';
      }
      if (layerEl) layerEl.style.height = px;
    }

    /** 滚动中用 transform（性能）；静止后用 top（避免合成层导致文字发糊） */
    function positionSlot(slot, idx) {
      if (!slot || idx < 0 || idx >= units.length) return;
      var y = Math.round(offsets[idx]);
      if (isScrolling) {
        slot.style.top = '0';
        slot.style.transform = 'translateY(' + y + 'px)';
      } else {
        slot.style.transform = '';
        slot.style.top = y + 'px';
      }
      slot.setAttribute('data-vindex', String(idx));
    }

    function setLayerScrollingClass(active) {
      if (!layerEl) return;
      if (active) layerEl.classList.add('is-scrolling');
      else layerEl.classList.remove('is-scrolling');
    }

    function measureSlotHeight(slot) {
      if (!slot) return 0;
      return Math.max(slot.offsetHeight, slot.scrollHeight || 0);
    }

    function disconnectSlotRo(slot) {
      if (!slot || !slot._vhistoryRo) return;
      slot._vhistoryRo.disconnect();
      slot._vhistoryRo = null;
    }

    /**
     * 更新偏移/总高前后用 DOM 锚点保持视口稳定（避免 F5 后首次遇到长消息时 scrollHeight 跳变）。
     */
    function applyHeightDirty(dirtyFrom, opts) {
      if (dirtyFrom < 0 || !units.length) return;
      opts = opts || {};
      var coords = getViewCoords();
      var useContentAnchor = !!opts.contentAnchor;
      var contentViewTop = coords.viewTop;
      var domAnchor = !useContentAnchor && isViewingHistoryContent(contentViewTop) && !isNearChatBottom()
        ? captureScrollAnchor(contentViewTop)
        : null;
      rebuildOffsets(dirtyFrom);
      applyHeights();
      repositionMountedSlots();
      if (useContentAnchor && isViewingHistoryContent(contentViewTop)) {
        applyContentOffsetAnchor(contentViewTop);
      } else if (domAnchor) {
        applyScrollCompensation(domAnchor);
      }
    }

    function scheduleHeightCommit(dirtyFrom) {
      if (suppressSlotResize) return;
      if (dirtyFrom >= 0 && (heightDirtyFrom < 0 || dirtyFrom < heightDirtyFrom)) {
        heightDirtyFrom = dirtyFrom;
      }
      if (heightCommitTimer) clearTimeout(heightCommitTimer);
      heightCommitTimer = setTimeout(function () {
        heightCommitTimer = 0;
        var from = heightDirtyFrom;
        heightDirtyFrom = -1;
        if (from >= 0) applyHeightDirty(from);
      }, RO_DEBOUNCE_MS);
    }

    function scheduleRoFlush() {
      if (roDebounceTimer) clearTimeout(roDebounceTimer);
      roDebounceTimer = setTimeout(flushRoDirty, RO_DEBOUNCE_MS);
    }

    function flushRoDirty() {
      roDebounceTimer = 0;
      if (roDirtyFrom < 0 || !units.length) return;
      var from = roDirtyFrom;
      roDirtyFrom = -1;
      applyHeightDirty(from);
      if (!isScrolling) scheduleRenderImmediate();
    }

    function onSlotResize(slot, key) {
      if (suppressSlotResize) return;
      var idx = indexOfKey(key);
      if (idx < 0) return;
      if (measureSlotIntoCache(slot, key, idx) >= 0) scheduleHeightCommit(idx);
    }

    function flushPendingHeightCommit() {
      if (heightCommitTimer) {
        clearTimeout(heightCommitTimer);
        heightCommitTimer = 0;
      }
      if (heightDirtyFrom >= 0) {
        var from = heightDirtyFrom;
        heightDirtyFrom = -1;
        applyHeightDirty(from);
      }
    }

    function cancelPendingHeightCommit() {
      if (heightCommitTimer) {
        clearTimeout(heightCommitTimer);
        heightCommitTimer = 0;
      }
      heightDirtyFrom = -1;
    }

    /** 侧栏展开、页面缩放等导致聊天区变窄时，批量重测避免逐条 RO 连续补偿抖动 */
    function remeasureMountedSlotsBatch() {
      if (!layerEl || !units.length) return false;
      var coords = getViewCoords();
      var keepContentTop = isViewingHistoryContent(coords.viewTop) && !isNearChatBottom();
      var contentViewTop = coords.viewTop;
      var dirtyFrom = -1;
      var slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (var i = 0; i < slots.length; i++) {
        var key = slots[i].getAttribute('data-vkey') || '';
        var idx = indexOfKey(key);
        if (idx < 0) continue;
        var measured = measureSlotHeight(slots[i]);
        if (measured <= 0) continue;
        heightCache[key] = measured;
        if (dirtyFrom < 0 || idx < dirtyFrom) dirtyFrom = idx;
      }
      if (dirtyFrom < 0) return false;
      rebuildOffsets(dirtyFrom);
      applyHeights();
      repositionMountedSlots();
      if (keepContentTop) applyContentOffsetAnchor(contentViewTop);
      return true;
    }

    function handleContainerResize() {
      containerResizeTimer = 0;
      if (!units.length) return;
      cancelPendingHeightCommit();
      if (roDebounceTimer) {
        clearTimeout(roDebounceTimer);
        roDebounceTimer = 0;
        roDirtyFrom = -1;
      }
      suppressSlotResize = true;
      remeasureMountedSlotsBatch();
      suppressSlotResize = false;
      scheduleRenderImmediate();
    }

    function scheduleContainerResize() {
      if (containerResizeTimer) clearTimeout(containerResizeTimer);
      containerResizeTimer = setTimeout(handleContainerResize, CONTAINER_RESIZE_DEBOUNCE_MS);
    }

    function ensureContainerResizeObserver() {
      if (containerResizeObserver || typeof ResizeObserver === 'undefined' || !scrollRoot) return;
      lastContainerWidth = scrollRoot.clientWidth;
      containerResizeObserver = new ResizeObserver(function (entries) {
        var entry = entries[0];
        if (!entry) return;
        var w = entry.contentRect.width;
        if (lastContainerWidth <= 0) {
          lastContainerWidth = w;
          return;
        }
        if (Math.abs(w - lastContainerWidth) < 1) return;
        lastContainerWidth = w;
        scheduleContainerResize();
      });
      containerResizeObserver.observe(scrollRoot);
    }

    function attachSlotResizeObserver(slot, key) {
      if (!slot || typeof ResizeObserver === 'undefined') return;
      disconnectSlotRo(slot);
      var ro = new ResizeObserver(function () {
        onSlotResize(slot, key);
      });
      ro.observe(slot);
      slot._vhistoryRo = ro;
    }

    function findSlotByKey(key) {
      if (!layerEl || !key) return null;
      var slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (var si = 0; si < slots.length; si++) {
        if (slots[si].getAttribute('data-vkey') === key) return slots[si];
      }
      return null;
    }

    function findAnchorIndex(viewTop) {
      if (!units.length) return 0;
      return findFirstIndexByOffset(viewTop);
    }

    function captureScrollAnchor(viewTop) {
      if (!scrollRoot || !units.length || !isViewingHistoryContent(viewTop)) return null;
      var rootRect = scrollRoot.getBoundingClientRect();
      /* 优先用已挂载 DOM：预估偏移不准时（F5 后首次滚到长消息）仍能对齐视口 */
      if (layerEl) {
        var slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
        var bestKey = '';
        var bestOffset = Infinity;
        for (var s = 0; s < slots.length; s++) {
          var rect = slots[s].getBoundingClientRect();
          if (rect.bottom <= rootRect.top + 1) continue;
          var off = rect.top - rootRect.top;
          if (off < bestOffset) {
            bestOffset = off;
            bestKey = slots[s].getAttribute('data-vkey') || '';
          }
        }
        if (bestKey) {
          return { key: bestKey, offsetFromViewport: bestOffset };
        }
      }
      var idx = findAnchorIndex(viewTop);
      var key = units[idx].key;
      var slot = findSlotByKey(key);
      var offsetFromViewport = viewTop - offsets[idx];
      if (slot) {
        offsetFromViewport = slot.getBoundingClientRect().top - rootRect.top;
      }
      return {
        key: key,
        offsetFromViewport: offsetFromViewport,
        fallbackOffsetPx: viewTop - offsets[idx],
      };
    }

    function applyScrollCompensation(anchor) {
      if (!scrollRoot || !anchor || isNearChatBottom()) return;
      var anchorSlot = findSlotByKey(anchor.key);
      if (!anchorSlot) return;
      var rootRect = scrollRoot.getBoundingClientRect();
      var currentOffset = anchorSlot.getBoundingClientRect().top - rootRect.top;
      var drift = currentOffset - anchor.offsetFromViewport;
      if (Math.abs(drift) <= 1) return;
      restoringScroll = true;
      scrollRoot.scrollTop += drift;
      requestAnimationFrame(function () {
        restoringScroll = false;
      });
    }

    /** 按历史区内容坐标锚定，布局批量更新后比逐帧 getBoundingClientRect 更稳 */
    function applyContentOffsetAnchor(contentViewTop) {
      if (!scrollRoot || !outerEl || isNearChatBottom()) return;
      restoringScroll = true;
      scrollRoot.scrollTop = outerEl.offsetTop + contentViewTop;
      requestAnimationFrame(function () {
        restoringScroll = false;
      });
    }

    function ensureDomShell() {
      if (!windowEl) return;
      if (!phantomEl) {
        phantomEl = document.createElement('div');
        phantomEl.className = 'chat-vhistory-phantom';
        phantomEl.setAttribute('aria-hidden', 'true');
      }
      if (!layerEl) {
        layerEl = document.createElement('div');
        layerEl.className = 'chat-vhistory-layer';
      }
      if (!phantomEl.parentNode) windowEl.appendChild(phantomEl);
      if (!layerEl.parentNode) windowEl.appendChild(layerEl);
    }

    function teardownAllSlots() {
      if (!layerEl) return;
      var slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (var i = 0; i < slots.length; i++) disconnectSlotRo(slots[i]);
      layerEl.innerHTML = '';
    }

    function mountUnitInSlot(slot, unit, idx) {
      var key = unit.key;
      if (slot._vhistoryKey !== key) {
        disconnectSlotRo(slot);
        slot.innerHTML = '';
        slot._vhistoryKey = key;
        slot.setAttribute('data-vkey', key);
        renderUnitFn(unit, slot);
        attachSlotResizeObserver(slot, key);
      }
      positionSlot(slot, idx);
    }

    function measureSlotIntoCache(slot, key, idx) {
      if (!slot || !key || idx < 0) return -1;
      var measured = measureSlotHeight(slot);
      if (measured <= 0) return -1;
      if (heightCache[key] === measured) return -1;
      heightCache[key] = measured;
      return idx;
    }

    function scanMeasureRange(range) {
      if (!range || range.end < range.start) return false;
      var dirtyFrom = -1;
      for (var idx = range.start; idx <= range.end; idx++) {
        var key = units[idx].key;
        var slot = findSlotByKey(key);
        if (!slot) continue;
        var d = measureSlotIntoCache(slot, key, idx);
        if (d >= 0 && (dirtyFrom < 0 || d < dirtyFrom)) dirtyFrom = d;
      }
      if (dirtyFrom >= 0) applyHeightDirty(dirtyFrom);
      return dirtyFrom >= 0;
    }

    function createSlotForUnit(unit, idx) {
      var slot = document.createElement('div');
      slot.className = 'chat-vhistory-slot';
      slot.setAttribute('data-vkey', unit.key);
      slot.style.width = '100%';
      slot.style.boxSizing = 'border-box';
      mountUnitInSlot(slot, unit, idx);
      layerEl.appendChild(slot);
      return slot;
    }

    function repositionMountedSlots() {
      if (!layerEl) return;
      var slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (var s = 0; s < slots.length; s++) {
        var k = slots[s].getAttribute('data-vkey') || '';
        var idx = indexOfKey(k);
        if (idx >= 0) positionSlot(slots[s], idx);
      }
    }

    function patchVisibleRange(range, recycle) {
      ensureDomShell();
      var needed = {};
      for (var ni = range.start; ni <= range.end; ni++) {
        needed[units[ni].key] = true;
      }

      var existing = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (var ex = 0; ex < existing.length; ex++) {
        var exKey = existing[ex].getAttribute('data-vkey') || '';
        if (!needed[exKey]) {
          disconnectSlotRo(existing[ex]);
          existing[ex].remove();
        }
      }

      for (var idx = range.start; idx <= range.end; idx++) {
        var unit = units[idx];
        var slot = recycle[unit.key];
        if (!slot) {
          createSlotForUnit(unit, idx);
          continue;
        }
        mountUnitInSlot(slot, unit, idx);
      }
    }

    function measureMountedRows(force) {
      if (!layerEl) return false;
      if (isScrolling && !force) return false;
      var children = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      var changed = false;
      var dirtyFrom = -1;
      for (var c = 0; c < children.length; c++) {
        var key = children[c].getAttribute('data-vkey') || '';
        var measured = measureSlotHeight(children[c]);
        if (measured <= 0 || !key) continue;
        if (heightCache[key] !== measured) {
          heightCache[key] = measured;
          var idx = indexOfKey(key);
          if (idx >= 0 && (dirtyFrom < 0 || idx < dirtyFrom)) dirtyFrom = idx;
          changed = true;
        }
      }
      if (changed && dirtyFrom >= 0) scheduleHeightCommit(dirtyFrom);
      return changed;
    }

    function runLayoutSettle() {
      if (!scrollRoot || !outerEl) return;
      measureMountedRows(true);
      flushPendingHeightCommit();
    }

    function clearVirtualDom() {
      teardownAllSlots();
      lastRangeStart = -1;
      lastRangeEnd = -2;
      if (phantomEl) phantomEl.style.height = '0px';
      if (windowEl) {
        windowEl.style.height = '0px';
        windowEl.style.minHeight = '0px';
      }
    }

    function wouldRangeChange(viewTop, viewBottom) {
      if (!units.length) return lastRangeStart >= 0;
      if (viewBottom < -OVERSCAN_PX || viewTop > totalHeight + OVERSCAN_PX) {
        return lastRangeStart >= 0 || lastRangeEnd >= 0;
      }
      var range = findIndexRange(viewTop, viewBottom);
      if (range.end < range.start) return false;
      return range.start !== lastRangeStart || range.end !== lastRangeEnd;
    }

    function renderVisible() {
      if (!windowEl || !renderUnitFn || !scrollRoot || !outerEl) return;

      ensureDomShell();
      if (offsets.length !== units.length + 1) rebuildOffsets(0);

      var coords = getViewCoords();
      var viewTop = coords.viewTop;
      var viewBottom = coords.viewBottom;

      if (viewBottom < -OVERSCAN_PX || viewTop > totalHeight + OVERSCAN_PX) {
        clearVirtualDom();
        applyHeights();
        return;
      }

      var range = findIndexRange(viewTop, viewBottom);
      if (range.end < range.start) return;

      var rangeChanged = range.start !== lastRangeStart || range.end !== lastRangeEnd;

      if (!rangeChanged) {
        repositionMountedSlots();
        if (!isScrolling) runLayoutSettle();
        return;
      }

      var neededKeys = {};
      for (var nk = range.start; nk <= range.end; nk++) {
        neededKeys[units[nk].key] = true;
      }

      var prevSlots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      var recycle = {};
      for (var ps = 0; ps < prevSlots.length; ps++) {
        var pk = prevSlots[ps].getAttribute('data-vkey');
        if (neededKeys[pk]) recycle[pk] = prevSlots[ps];
      }

      patchVisibleRange(range, recycle);
      if (!scanMeasureRange(range)) {
        requestAnimationFrame(function () {
          scanMeasureRange(range);
        });
      }

      lastRangeStart = range.start;
      lastRangeEnd = range.end;
      applyHeights();

      if (!isScrolling) runLayoutSettle();

      if (typeof onAfterVisibleRender === 'function' && rangeChanged) {
        onAfterVisibleRender(range.start, range.end);
      }
    }

    function requestRenderFrame() {
      if (rafPending) {
        pendingRender = true;
        return;
      }
      rafPending = requestAnimationFrame(function () {
        rafPending = 0;
        renderVisible();
        if (pendingRender) {
          pendingRender = false;
          requestRenderFrame();
        }
      });
    }

    function remeasureLayout() {
      runLayoutSettle();
    }

    function scheduleRender() {
      if (scrollRoot && outerEl && units.length) {
        var coords = getViewCoords();
        if (wouldRangeChange(coords.viewTop, coords.viewBottom)) {
          scheduleRenderImmediate();
          return;
        }
      }
      if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = setTimeout(function () {
        scrollDebounceTimer = 0;
        requestRenderFrame();
      }, SCROLL_RENDER_DEBOUNCE_MS);
    }

    function scheduleRenderImmediate() {
      if (scrollDebounceTimer) {
        clearTimeout(scrollDebounceTimer);
        scrollDebounceTimer = 0;
      }
      requestRenderFrame();
    }

    function onScrollIdle() {
      isScrolling = false;
      setLayerScrollingClass(false);
      repositionMountedSlots();
      if (!scrollRoot || !outerEl) return;
      if (roDebounceTimer) {
        clearTimeout(roDebounceTimer);
        flushRoDirty();
      }
      flushPendingHeightCommit();
      runLayoutSettle();
    }

    function resetScrollerState() {
      teardownAllSlots();
      isScrolling = false;
      setLayerScrollingClass(false);
      heightCache = {};
      offsets = [];
      totalHeight = 0;
      lastRangeStart = -1;
      lastRangeEnd = -2;
      roDirtyFrom = -1;
      heightDirtyFrom = -1;
      if (roDebounceTimer) {
        clearTimeout(roDebounceTimer);
        roDebounceTimer = 0;
      }
      if (heightCommitTimer) {
        clearTimeout(heightCommitTimer);
        heightCommitTimer = 0;
      }
      if (containerResizeTimer) {
        clearTimeout(containerResizeTimer);
        containerResizeTimer = 0;
      }
    }

    return {
      TAIL_TURN_COUNT: TAIL_TURN_COUNT,
      init: function (opts) {
        outerEl = opts.outerEl || null;
        windowEl = opts.windowEl || null;
        scrollRoot = opts.scrollRoot || null;
        renderUnitFn = opts.renderUnit || null;
        onAfterVisibleRender = opts.onAfterVisibleRender || null;
        if (typeof opts.stickyThresholdPx === 'number' && opts.stickyThresholdPx > 0) {
          stickyThresholdPx = opts.stickyThresholdPx;
        }
        ensureDomShell();
        ensureContainerResizeObserver();
      },
      setUnits: function (nextUnits) {
        units = Array.isArray(nextUnits) ? nextUnits : [];
        resetScrollerState();
        rebuildOffsets(0);
        applyHeights();
        scheduleRenderImmediate();
      },
      clear: function () {
        units = [];
        resetScrollerState();
        if (windowEl) {
          windowEl.innerHTML = '';
          phantomEl = null;
          layerEl = null;
          windowEl.style.minHeight = '0px';
          windowEl.style.height = '0px';
        }
        if (outerEl) {
          outerEl.style.minHeight = '0px';
          outerEl.style.height = 'auto';
        }
      },
      handleScroll: function () {
        if (restoringScroll) return;
        if (!isScrolling) {
          isScrolling = true;
          setLayerScrollingClass(true);
        }
        if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(onScrollIdle, 120);
        scheduleRender();
      },
      refresh: function () {
        rebuildOffsets(0);
        applyHeights();
        scheduleRenderImmediate();
      },
      remeasureLayout: remeasureLayout,
      invalidateHeight: function (key) {
        var idx = key ? indexOfKey(key) : -1;
        if (key) delete heightCache[key];
        else heightCache = {};
        applyHeightDirty(idx >= 0 ? idx : 0);
        scheduleRenderImmediate();
      },
      getTotalHeight: function () {
        return totalHeight;
      },
      scrollToMessageIndex: function (msgIndex) {
        if (!scrollRoot || !outerEl || !units.length) return false;
        if (typeof msgIndex !== 'number' || msgIndex < 0) return false;
        var targetIdx = -1;
        for (var ui = 0; ui < units.length; ui++) {
          if (units[ui].type === 'message' && units[ui].msgIndex === msgIndex) {
            targetIdx = ui;
            break;
          }
        }
        if (targetIdx < 0) return false;
        restoringScroll = true;
        var contentViewTop = offsets[targetIdx];
        scrollRoot.scrollTop = outerEl.offsetTop + contentViewTop;
        scheduleRenderImmediate();
        requestAnimationFrame(function () {
          restoringScroll = false;
          runLayoutSettle();
          scheduleRenderImmediate();
        });
        return true;
      },
      /** 历史区内容坐标下，视口顶部的用户消息索引（无 DOM 时供楼梯导航高亮） */
      resolveActiveUserMsgIndex: function (contentViewTop, anchorPx) {
        if (!units.length) return -1;
        var anchor = (typeof contentViewTop === 'number' ? contentViewTop : 0)
          + (typeof anchorPx === 'number' ? anchorPx : 80);
        var active = -1;
        for (var ri = 0; ri < units.length; ri++) {
          var unit = units[ri];
          if (unit.type !== 'message' || !unit.msg || unit.msg.role !== 'user') continue;
          if (offsets[ri] <= anchor) active = unit.msgIndex;
        }
        return active;
      },
    };
  }

  return {
    TAIL_TURN_COUNT: TAIL_TURN_COUNT,
    TOOL_TRACE_VISIBLE_MAX: TOOL_TRACE_VISIBLE_MAX,
    computeTailStartIndex: computeTailStartIndex,
    buildHistoryUnits: buildHistoryUnits,
    estimateUnitHeight: estimateUnitHeight,
    createScroller: createScroller,
  };
})();
