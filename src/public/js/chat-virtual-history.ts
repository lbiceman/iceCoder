// @ts-nocheck
/**
 * 聊天历史区虚拟滚动（translateY + 前缀偏移 + 二分可见区 + 逐条 ResizeObserver）。
 * 尾部最近 1 轮用户对话由 chat-ui 真实 DOM 负责。
 */

/* exported ChatVirtualHistory */

export const ChatVirtualHistory = (() => {

  /** 尾部保留的真实 DOM：最近 1 轮（从最后一条 user 消息起） */
  const TAIL_TURN_COUNT = 1;
  const UNIT_GAP_PX = 12;
  const OVERSCAN_PX = 400;
  const OVERSCAN_ITEMS = 5;
  const SCROLL_RENDER_DEBOUNCE_MS = 32;
  const RO_DEBOUNCE_MS = 50;
  const CONTAINER_RESIZE_DEBOUNCE_MS = 500;
  const DEFAULT_MESSAGE_HEIGHT = 96;
  const DEFAULT_TOOLS_ROW_HEIGHT = 36;
  const DEFAULT_TOOLS_GROUP_EXTRA = 8;
  /** 与 chat-ui.js TOOL_TRACE_VISIBLE_MAX 一致 */
  const TOOL_TRACE_VISIBLE_MAX = 3;

  function computeTailStartIndex(messages, tailTurnCount) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    const n = typeof tailTurnCount === 'number' && tailTurnCount > 0 ? tailTurnCount : TAIL_TURN_COUNT;
    const userIndices = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') userIndices.push(i);
    }
    if (userIndices.length <= n) return 0;
    return userIndices[userIndices.length - n];
  }

  function buildHistoryUnits(messages, toolTraces, displayMap, tailStartIndex) {
    const units = [];
    if (!Array.isArray(messages) || tailStartIndex <= 0) return units;
    const end = Math.min(tailStartIndex, messages.length);
    for (let i = 0; i < end; i++) {
      const msg = messages[i];
      const traces = msg.id && toolTraces ? toolTraces[msg.id] : null;
      if (traces && traces.length > 0) {
        units.push({
          type: 'tools',
          key: 'tools:' + (msg.id || i),
          msgId: msg.id || '',
          traces,
          displays: (displayMap && msg.id && displayMap[msg.id]) ? displayMap[msg.id] : [],
        });
      }
      units.push({
        type: 'message',
        key: 'msg:' + (msg.id || i) + ':' + msg.role,
        msg,
        msgIndex: i,
      });
    }
    return units;
  }

  function clampIndexRange(range, length) {
    if (!range || typeof length !== 'number' || length <= 0) return null;
    const start = Math.max(0, range.start | 0);
    const end = Math.min(length - 1, range.end | 0);
    if (end < start) return null;
    return { start, end };
  }

  function estimateUnitHeight(unit) {
    if (!unit) return DEFAULT_MESSAGE_HEIGHT;
    if (unit.type === 'tools') {
      const n = unit.traces ? unit.traces.length : 0;
      const visibleRows = n > 0 ? Math.min(n, TOOL_TRACE_VISIBLE_MAX) : 0;
      const collapsedBtn = n > TOOL_TRACE_VISIBLE_MAX ? 28 : 0;
      return DEFAULT_TOOLS_GROUP_EXTRA + visibleRows * DEFAULT_TOOLS_ROW_HEIGHT + collapsedBtn;
    }
    if (unit.type === 'message' && unit.msg) {
      const text = typeof unit.msg.content === 'string' ? unit.msg.content : '';
      const lineBreaks = (text.match(/\n/g) || []).length + 1;
      const codeBlocks = (text.match(/```/g) || []).length / 2;
      const tableRows = (text.match(/^\|/gm) || []).length;
      const lines = Math.max(lineBreaks, Math.ceil(text.length / 40));
      const imgExtra = (unit.msg.images && unit.msg.images.length > 0) ? 120 : 0;
      const codeExtra = Math.floor(codeBlocks) * 120;
      const tableExtra = tableRows * 28;
      return Math.max(
        DEFAULT_MESSAGE_HEIGHT,
        48 + lines * 24 + imgExtra + codeExtra + tableExtra,
      );
    }
    return DEFAULT_MESSAGE_HEIGHT;
  }

  function createScroller() {
    let outerEl = null;
    let windowEl = null;
    let scrollRoot = null;
    let renderUnitFn = null;
    let onAfterVisibleRender = null;
    let units = [];
    let heightCache = {};
    /** offsets[i] = 第 i 个单元顶部距列表起点；offsets[n] = 总高度 */
    let offsets = [];
    let totalHeight = 0;
    let phantomEl = null;
    let layerEl = null;
    let roDebounceTimer = 0;
    let roDirtyFrom = -1;
    let heightCommitTimer = 0;
    let heightDirtyFrom = -1;
    let containerResizeObserver = null;
    let containerResizeTimer = 0;
    let lastContainerWidth = 0;
    let suppressSlotResize = false;
    let rafPending = 0;
    let pendingRender = false;
    let scrollDebounceTimer = 0;
    let scrollIdleTimer = 0;
    let isScrolling = false;
    let lastRangeStart = -1;
    let lastRangeEnd = -2;
    let restoringScroll = false;
    let stickyThresholdPx = 80;
    let layoutGen = 0;

    function getHeight(unit) {
      if (!unit || !unit.key) return DEFAULT_MESSAGE_HEIGHT;
      if (heightCache[unit.key] > 0) return heightCache[unit.key];
      return estimateUnitHeight(unit);
    }

    function indexOfKey(key) {
      for (let i = 0; i < units.length; i++) {
        if (units[i].key === key) return i;
      }
      return -1;
    }

    function rebuildOffsets(fromIndex) {
      const n = units.length;
      if (!n) {
        offsets = [0];
        totalHeight = 0;
        return;
      }
      const start = typeof fromIndex === 'number' && fromIndex >= 0 ? fromIndex : 0;
      if (start === 0) {
        if (offsets.length !== n + 1) offsets = new Array(n + 1);
        offsets[0] = 0;
      } else {
        if (offsets.length !== n + 1) {
          const next = new Array(n + 1);
          for (let c = 0; c <= start && c < offsets.length; c++) next[c] = offsets[c];
          offsets = next;
        }
      }
      for (let i = start; i < n; i++) {
        const gap = i < n - 1 ? UNIT_GAP_PX : 0;
        offsets[i + 1] = offsets[i] + getHeight(units[i]) + gap;
      }
      totalHeight = offsets[n];
    }

    function getViewCoords() {
      if (!scrollRoot || !outerEl) return { viewTop: 0, viewBottom: 0 };
      const historyTop = outerEl.offsetTop;
      const viewTop = scrollRoot.scrollTop - historyTop;
      return {
        viewTop,
        viewBottom: viewTop + scrollRoot.clientHeight,
      };
    }

    function isNearChatBottom() {
      if (!scrollRoot) return false;
      const dist = scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight;
      return dist < stickyThresholdPx;
    }

    function isViewingHistoryContent(viewTop) {
      if (!units.length) return false;
      return viewTop < totalHeight;
    }

    /** 二分：首个满足单元底边 > target 的索引 */
    function findFirstIndexByOffset(target) {
      const n = units.length;
      if (!n) return 0;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid + 1] <= target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    /** 二分：最后一个满足单元顶边 <= target 的索引 */
    function findLastIndexByOffset(target) {
      const n = units.length;
      if (!n) return -1;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] > target) hi = mid - 1;
        else lo = mid;
      }
      return lo;
    }

    function findIndexRange(viewTop, viewBottom) {
      if (!units.length) return { start: 0, end: -1 };
      let start = findFirstIndexByOffset(viewTop - OVERSCAN_PX);
      let end = findLastIndexByOffset(viewBottom + OVERSCAN_PX);
      start = Math.max(0, start - OVERSCAN_ITEMS);
      end = Math.min(units.length - 1, end + OVERSCAN_ITEMS);
      return { start, end: Math.max(start, end) };
    }

    function applyHeights() {
      const px = totalHeight > 0 ? (`${totalHeight}px`) : '0px';
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
      const y = Math.round(offsets[idx]);
      if (isScrolling) {
        slot.style.top = '0';
        slot.style.transform = `translateY(${y}px)`;
      } else {
        slot.style.transform = '';
        slot.style.top = `${y}px`;
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
      const coords = getViewCoords();
      const useContentAnchor = !!opts.contentAnchor;
      const contentViewTop = coords.viewTop;
      const domAnchor = !useContentAnchor && isViewingHistoryContent(contentViewTop) && !isNearChatBottom()
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
      heightCommitTimer = setTimeout(() => {
        heightCommitTimer = 0;
        const from = heightDirtyFrom;
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
      const from = roDirtyFrom;
      roDirtyFrom = -1;
      applyHeightDirty(from);
      if (!isScrolling) scheduleRenderImmediate();
    }

    function onSlotResize(slot, key) {
      if (suppressSlotResize) return;
      const idx = indexOfKey(key);
      if (idx < 0) return;
      if (measureSlotIntoCache(slot, key, idx) >= 0) scheduleHeightCommit(idx);
    }

    function flushPendingHeightCommit() {
      if (heightCommitTimer) {
        clearTimeout(heightCommitTimer);
        heightCommitTimer = 0;
      }
      if (heightDirtyFrom >= 0) {
        const from = heightDirtyFrom;
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
      const coords = getViewCoords();
      const keepContentTop = isViewingHistoryContent(coords.viewTop) && !isNearChatBottom();
      const contentViewTop = coords.viewTop;
      let dirtyFrom = -1;
      const slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (let i = 0; i < slots.length; i++) {
        const key = slots[i].getAttribute('data-vkey') || '';
        const idx = indexOfKey(key);
        if (idx < 0) continue;
        const measured = measureSlotHeight(slots[i]);
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
      containerResizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const w = entry.contentRect.width;
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
      const ro = new ResizeObserver(() => {
        onSlotResize(slot, key);
      });
      ro.observe(slot);
      slot._vhistoryRo = ro;
    }

    function findSlotByKey(key) {
      if (!layerEl || !key) return null;
      const slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (let si = 0; si < slots.length; si++) {
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
      const rootRect = scrollRoot.getBoundingClientRect();
      /* 优先用已挂载 DOM：预估偏移不准时（F5 后首次滚到长消息）仍能对齐视口 */
      if (layerEl) {
        const slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
        let bestKey = '';
        let bestOffset = Infinity;
        for (let s = 0; s < slots.length; s++) {
          const rect = slots[s].getBoundingClientRect();
          if (rect.bottom <= rootRect.top + 1) continue;
          const off = rect.top - rootRect.top;
          if (off < bestOffset) {
            bestOffset = off;
            bestKey = slots[s].getAttribute('data-vkey') || '';
          }
        }
        if (bestKey) {
          return { key: bestKey, offsetFromViewport: bestOffset };
        }
      }
      const idx = findAnchorIndex(viewTop);
      const unit = units[idx];
      if (!unit) return null;
      const key = unit.key;
      const slot = findSlotByKey(key);
      let offsetFromViewport = viewTop - offsets[idx];
      if (slot) {
        offsetFromViewport = slot.getBoundingClientRect().top - rootRect.top;
      }
      return {
        key,
        offsetFromViewport,
        fallbackOffsetPx: viewTop - offsets[idx],
      };
    }

    function applyScrollCompensation(anchor) {
      if (!scrollRoot || !anchor || isNearChatBottom()) return;
      const anchorSlot = findSlotByKey(anchor.key);
      if (!anchorSlot) return;
      const rootRect = scrollRoot.getBoundingClientRect();
      const currentOffset = anchorSlot.getBoundingClientRect().top - rootRect.top;
      const drift = currentOffset - anchor.offsetFromViewport;
      if (Math.abs(drift) <= 1) return;
      restoringScroll = true;
      scrollRoot.scrollTop += drift;
      requestAnimationFrame(() => {
        restoringScroll = false;
      });
    }

    /** 按历史区内容坐标锚定，布局批量更新后比逐帧 getBoundingClientRect 更稳 */
    function applyContentOffsetAnchor(contentViewTop) {
      if (!scrollRoot || !outerEl || isNearChatBottom()) return;
      restoringScroll = true;
      scrollRoot.scrollTop = outerEl.offsetTop + contentViewTop;
      requestAnimationFrame(() => {
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
      const slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (let i = 0; i < slots.length; i++) disconnectSlotRo(slots[i]);
      layerEl.innerHTML = '';
    }

    function mountUnitInSlot(slot, unit, idx) {
      const key = unit.key;
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
      const measured = measureSlotHeight(slot);
      if (measured <= 0) return -1;
      if (heightCache[key] === measured) return -1;
      heightCache[key] = measured;
      return idx;
    }

    function scanMeasureRange(range) {
      range = clampIndexRange(range, units.length);
      if (!range) return false;
      let dirtyFrom = -1;
      for (let idx = range.start; idx <= range.end; idx++) {
        const unit = units[idx];
        if (!unit) continue;
        const key = unit.key;
        const slot = findSlotByKey(key);
        if (!slot) continue;
        const d = measureSlotIntoCache(slot, key, idx);
        if (d >= 0 && (dirtyFrom < 0 || d < dirtyFrom)) dirtyFrom = d;
      }
      if (dirtyFrom >= 0) applyHeightDirty(dirtyFrom);
      return dirtyFrom >= 0;
    }

    function createSlotForUnit(unit, idx) {
      const slot = document.createElement('div');
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
      const slots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (let s = 0; s < slots.length; s++) {
        const k = slots[s].getAttribute('data-vkey') || '';
        const idx = indexOfKey(k);
        if (idx >= 0) positionSlot(slots[s], idx);
      }
    }

    function patchVisibleRange(range, recycle) {
      range = clampIndexRange(range, units.length);
      if (!range) return;
      ensureDomShell();
      const needed = {};
      for (let ni = range.start; ni <= range.end; ni++) {
        const neededUnit = units[ni];
        if (neededUnit) needed[neededUnit.key] = true;
      }

      const existing = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      for (let ex = 0; ex < existing.length; ex++) {
        const exKey = existing[ex].getAttribute('data-vkey') || '';
        if (!needed[exKey]) {
          disconnectSlotRo(existing[ex]);
          existing[ex].remove();
        }
      }

      for (let idx = range.start; idx <= range.end; idx++) {
        const unit = units[idx];
        if (!unit) continue;
        const slot = recycle[unit.key];
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
      const children = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      let changed = false;
      let dirtyFrom = -1;
      for (let c = 0; c < children.length; c++) {
        const key = children[c].getAttribute('data-vkey') || '';
        const measured = measureSlotHeight(children[c]);
        if (measured <= 0 || !key) continue;
        if (heightCache[key] !== measured) {
          heightCache[key] = measured;
          const idx = indexOfKey(key);
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
      const range = findIndexRange(viewTop, viewBottom);
      if (range.end < range.start) return false;
      return range.start !== lastRangeStart || range.end !== lastRangeEnd;
    }

    function renderVisible() {
      if (!windowEl || !renderUnitFn || !scrollRoot || !outerEl) return;

      ensureDomShell();
      if (offsets.length !== units.length + 1) rebuildOffsets(0);

      const coords = getViewCoords();
      const viewTop = coords.viewTop;
      const viewBottom = coords.viewBottom;

      if (viewBottom < -OVERSCAN_PX || viewTop > totalHeight + OVERSCAN_PX) {
        clearVirtualDom();
        applyHeights();
        return;
      }

      const range = clampIndexRange(findIndexRange(viewTop, viewBottom), units.length);
      if (!range) return;

      const rangeChanged = range.start !== lastRangeStart || range.end !== lastRangeEnd;

      if (!rangeChanged) {
        repositionMountedSlots();
        if (!isScrolling) runLayoutSettle();
        return;
      }

      const neededKeys = {};
      for (let nk = range.start; nk <= range.end; nk++) {
        const rangeUnit = units[nk];
        if (rangeUnit) neededKeys[rangeUnit.key] = true;
      }

      const prevSlots = layerEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      const recycle = {};
      for (let ps = 0; ps < prevSlots.length; ps++) {
        const pk = prevSlots[ps].getAttribute('data-vkey');
        if (neededKeys[pk]) recycle[pk] = prevSlots[ps];
      }

      const gen = layoutGen;
      patchVisibleRange(range, recycle);
      if (!scanMeasureRange(range)) {
        requestAnimationFrame(() => {
          if (gen !== layoutGen) return;
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
      rafPending = requestAnimationFrame(() => {
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
        const coords = getViewCoords();
        if (wouldRangeChange(coords.viewTop, coords.viewBottom)) {
          scheduleRenderImmediate();
          return;
        }
      }
      if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = setTimeout(() => {
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
      layoutGen += 1;
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
      TAIL_TURN_COUNT,
      init(opts) {
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
      setUnits(nextUnits) {
        units = Array.isArray(nextUnits) ? nextUnits : [];
        resetScrollerState();
        rebuildOffsets(0);
        applyHeights();
        scheduleRenderImmediate();
      },
      clear() {
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
      handleScroll() {
        if (restoringScroll) return;
        if (!isScrolling) {
          isScrolling = true;
          setLayerScrollingClass(true);
        }
        if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(onScrollIdle, 120);
        scheduleRender();
      },
      refresh() {
        rebuildOffsets(0);
        applyHeights();
        scheduleRenderImmediate();
      },
      remeasureLayout,
      invalidateHeight(key) {
        const idx = key ? indexOfKey(key) : -1;
        if (key) delete heightCache[key];
        else heightCache = {};
        applyHeightDirty(idx >= 0 ? idx : 0);
        scheduleRenderImmediate();
      },
      getTotalHeight() {
        return totalHeight;
      },
      scrollToMessageIndex(msgIndex) {
        if (!scrollRoot || !outerEl || !units.length) return false;
        if (typeof msgIndex !== 'number' || msgIndex < 0) return false;
        let targetIdx = -1;
        for (let ui = 0; ui < units.length; ui++) {
          if (units[ui].type === 'message' && units[ui].msgIndex === msgIndex) {
            targetIdx = ui;
            break;
          }
        }
        if (targetIdx < 0) return false;
        restoringScroll = true;
        const contentViewTop = offsets[targetIdx];
        scrollRoot.scrollTop = outerEl.offsetTop + contentViewTop;
        scheduleRenderImmediate();
        requestAnimationFrame(() => {
          restoringScroll = false;
          runLayoutSettle();
          scheduleRenderImmediate();
        });
        return true;
      },
      /** 历史区内容坐标下，视口顶部的用户消息索引（无 DOM 时供楼梯导航高亮） */
      resolveActiveUserMsgIndex(contentViewTop, anchorPx) {
        if (!units.length) return -1;
        const anchor = (typeof contentViewTop === 'number' ? contentViewTop : 0)
          + (typeof anchorPx === 'number' ? anchorPx : 80);
        let active = -1;
        for (let ri = 0; ri < units.length; ri++) {
          const unit = units[ri];
          if (unit.type !== 'message' || !unit.msg || unit.msg.role !== 'user') continue;
          if (offsets[ri] <= anchor) active = unit.msgIndex;
        }
        return active;
      },
    };
  }

  return {
    TAIL_TURN_COUNT,
    TOOL_TRACE_VISIBLE_MAX,
    computeTailStartIndex,
    buildHistoryUnits,
    estimateUnitHeight,
    clampIndexRange,
    createScroller,
  };
})();

if (typeof window !== 'undefined') {
  window.ChatVirtualHistory = ChatVirtualHistory;
}
