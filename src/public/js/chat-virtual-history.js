/**
 * 聊天历史区虚拟滚动：仅渲染视口内单元，尾部 N 轮由 chat-ui 真实 DOM 负责。
 */

/* exported ChatVirtualHistory */

window.ChatVirtualHistory = (function () {
  'use strict';

  var TAIL_TURN_COUNT = 2;
  var UNIT_GAP_PX = 12;
  var OVERSCAN_PX = 720;
  var SCROLL_RENDER_DEBOUNCE_MS = 32;
  var DEFAULT_MESSAGE_HEIGHT = 96;
  var DEFAULT_TOOLS_ROW_HEIGHT = 36;
  var DEFAULT_TOOLS_GROUP_EXTRA = 8;
  /** 与 chat-ui.js TOOL_TRACE_VISIBLE_MAX 一致：折叠时仅最后 N 条在 DOM 中占位 */
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
    var mountedKeys = {};
    var rafPending = 0;
    var pendingRender = false;
    var scrollDebounceTimer = 0;
    var scrollIdleTimer = 0;
    var isScrolling = false;
    var lastRangeStart = -1;
    var lastRangeEnd = -2;
    var topSpacerEl = null;
    var bottomSpacerEl = null;
    var resizeObserver = null;

    function getHeight(unit) {
      if (!unit || !unit.key) return DEFAULT_MESSAGE_HEIGHT;
      if (heightCache[unit.key] > 0) return heightCache[unit.key];
      return estimateUnitHeight(unit);
    }

    function totalContentHeight() {
      if (!units.length) return 0;
      var h = 0;
      for (var i = 0; i < units.length; i++) {
        h += getHeight(units[i]);
        if (i < units.length - 1) h += UNIT_GAP_PX;
      }
      return h;
    }

    function offsetTopForIndex(index) {
      var y = 0;
      for (var i = 0; i < index; i++) {
        y += getHeight(units[i]) + UNIT_GAP_PX;
      }
      return y;
    }

    function findIndexRange(viewTop, viewBottom) {
      if (!units.length) return { start: 0, end: -1 };
      var start = 0;
      var end = units.length - 1;
      for (var i = 0; i < units.length; i++) {
        var top = offsetTopForIndex(i);
        var bottom = top + getHeight(units[i]);
        if (bottom >= viewTop - OVERSCAN_PX) {
          start = i;
          break;
        }
      }
      for (var j = units.length - 1; j >= 0; j--) {
        var t2 = offsetTopForIndex(j);
        if (t2 <= viewBottom + OVERSCAN_PX) {
          end = j;
          break;
        }
      }
      return { start: start, end: Math.max(start, end) };
    }

    function findUnitByKey(key) {
      if (!key) return null;
      for (var ui = 0; ui < units.length; ui++) {
        if (units[ui].key === key) return units[ui];
      }
      return null;
    }

    function resetHeightCacheToEstimate(key) {
      var unit = findUnitByKey(key);
      if (!unit || !key) return;
      heightCache[key] = estimateUnitHeight(unit);
    }

    function applyOuterHeight() {
      if (!outerEl) return;
      var h = totalContentHeight();
      var px = h > 0 ? (h + 'px') : '0px';
      outerEl.style.minHeight = px;
      outerEl.style.height = 'auto';
      if (windowEl) {
        windowEl.style.minHeight = px;
        windowEl.style.height = 'auto';
      }
    }

    function measureSlotHeight(slot) {
      if (!slot) return 0;
      return Math.max(slot.offsetHeight, slot.scrollHeight || 0);
    }

    function cacheSlotHeight(slot, key) {
      if (!slot || !key) return false;
      var measured = measureSlotHeight(slot);
      if (measured <= 0) return false;
      if (heightCache[key] === measured) return false;
      heightCache[key] = measured;
      return true;
    }

    function ensureResizeObserver() {
      if (resizeObserver || typeof ResizeObserver === 'undefined' || !windowEl) return;
      resizeObserver = new ResizeObserver(function () {
        if (isScrolling) return;
        if (measureMountedRows(true)) {
          applyOuterHeight();
          updateSpacerHeights();
        }
      });
      resizeObserver.observe(windowEl);
    }

    function ensureSpacers() {
      if (!windowEl) return;
      if (!topSpacerEl) {
        topSpacerEl = document.createElement('div');
        topSpacerEl.className = 'chat-vhistory-spacer chat-vhistory-spacer-top';
        topSpacerEl.setAttribute('aria-hidden', 'true');
      }
      if (!bottomSpacerEl) {
        bottomSpacerEl = document.createElement('div');
        bottomSpacerEl.className = 'chat-vhistory-spacer chat-vhistory-spacer-bottom';
        bottomSpacerEl.setAttribute('aria-hidden', 'true');
      }
    }

    function updateSpacerHeights() {
      if (!windowEl || lastRangeEnd < lastRangeStart) return;
      ensureSpacers();
      var topHeight = lastRangeStart > 0 ? offsetTopForIndex(lastRangeStart) : 0;
      var bottomStart = offsetTopForIndex(lastRangeEnd + 1);
      var bottomHeight = Math.max(0, totalContentHeight() - bottomStart);
      topSpacerEl.style.height = topHeight > 0 ? (topHeight + 'px') : '0px';
      bottomSpacerEl.style.height = bottomHeight > 0 ? (bottomHeight + 'px') : '0px';
    }

    function measureMountedRows(force) {
      if (!windowEl) return false;
      if (isScrolling && !force) return false;
      var children = windowEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      var changed = false;
      for (var c = 0; c < children.length; c++) {
        if (cacheSlotHeight(children[c], children[c].getAttribute('data-vkey') || '')) {
          changed = true;
        }
      }
      return changed;
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

    function createSlotForUnit(unit, idx) {
      var slot = document.createElement('div');
      slot.className = 'chat-vhistory-slot';
      slot.setAttribute('data-vkey', unit.key);
      slot.setAttribute('data-vindex', String(idx));
      slot.style.width = '100%';
      slot.style.boxSizing = 'border-box';
      if (idx < units.length - 1) slot.style.marginBottom = UNIT_GAP_PX + 'px';
      renderUnitFn(unit, slot);
      cacheSlotHeight(slot, unit.key);
      return slot;
    }

    function renderVisible() {
      if (!windowEl || !renderUnitFn || !scrollRoot || !outerEl) return;

      ensureResizeObserver();
      ensureSpacers();

      var historyTop = outerEl.offsetTop;
      var scrollTop = scrollRoot.scrollTop;
      var viewTop = scrollTop - historyTop;
      var viewBottom = viewTop + scrollRoot.clientHeight;

      if (viewBottom < -OVERSCAN_PX || viewTop > totalContentHeight() + OVERSCAN_PX) {
        windowEl.innerHTML = '';
        topSpacerEl = null;
        bottomSpacerEl = null;
        mountedKeys = {};
        return;
      }

      var range = findIndexRange(viewTop, viewBottom);
      if (range.end < range.start) return;

      var rangeChanged = range.start !== lastRangeStart || range.end !== lastRangeEnd;

      if (!rangeChanged) {
        updateSpacerHeights();
        if (!isScrolling && measureMountedRows(false)) {
          applyOuterHeight();
          updateSpacerHeights();
        }
        return;
      }

      var needed = {};
      for (var ni = range.start; ni <= range.end; ni++) {
        needed[units[ni].key] = true;
      }

      var prevSlots = windowEl.querySelectorAll('.chat-vhistory-slot[data-vkey]');
      var recycle = {};
      for (var ps = 0; ps < prevSlots.length; ps++) {
        var prev = prevSlots[ps];
        var pk = prev.getAttribute('data-vkey');
        if (needed[pk]) {
          recycle[pk] = prev;
        } else {
          resetHeightCacheToEstimate(pk);
        }
      }

      windowEl.innerHTML = '';
      ensureSpacers();
      windowEl.appendChild(topSpacerEl);
      mountedKeys = {};

      for (var idx = range.start; idx <= range.end; idx++) {
        var unit = units[idx];
        var slot = recycle[unit.key] || createSlotForUnit(unit, idx);
        if (recycle[unit.key]) {
          slot.setAttribute('data-vindex', String(idx));
          if (idx < units.length - 1) slot.style.marginBottom = UNIT_GAP_PX + 'px';
          else slot.style.marginBottom = '';
          cacheSlotHeight(slot, unit.key);
        }
        mountedKeys[unit.key] = true;
        windowEl.appendChild(slot);
      }

      windowEl.appendChild(bottomSpacerEl);

      lastRangeStart = range.start;
      lastRangeEnd = range.end;
      updateSpacerHeights();

      if (measureMountedRows(false)) {
        applyOuterHeight();
        updateSpacerHeights();
      } else {
        applyOuterHeight();
      }

      if (typeof onAfterVisibleRender === 'function' && rangeChanged) {
        onAfterVisibleRender(range.start, range.end);
      }
    }

    function remeasureLayout() {
      measureMountedRows(true);
      applyOuterHeight();
      updateSpacerHeights();
    }

    function scheduleRender() {
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
      if (measureMountedRows(true)) {
        applyOuterHeight();
        updateSpacerHeights();
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
      },
      setUnits: function (nextUnits) {
        units = Array.isArray(nextUnits) ? nextUnits : [];
        mountedKeys = {};
        heightCache = {};
        topSpacerEl = null;
        bottomSpacerEl = null;
        if (windowEl) windowEl.innerHTML = '';
        applyOuterHeight();
        lastRangeStart = -1;
        lastRangeEnd = -2;
        scheduleRenderImmediate();
      },
      clear: function () {
        units = [];
        mountedKeys = {};
        heightCache = {};
        lastRangeStart = -1;
        lastRangeEnd = -2;
        topSpacerEl = null;
        bottomSpacerEl = null;
        if (windowEl) windowEl.innerHTML = '';
        if (outerEl) {
          outerEl.style.minHeight = '0px';
          outerEl.style.height = 'auto';
        }
        if (windowEl) {
          windowEl.style.minHeight = '0px';
          windowEl.style.height = 'auto';
        }
      },
      handleScroll: function () {
        isScrolling = true;
        if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(onScrollIdle, 120);
        scheduleRender();
      },
      refresh: function () {
        applyOuterHeight();
        scheduleRenderImmediate();
      },
      remeasureLayout: remeasureLayout,
      invalidateHeight: function (key) {
        if (key) delete heightCache[key];
        else heightCache = {};
        applyOuterHeight();
        updateSpacerHeights();
        scheduleRender();
      },
      getTotalHeight: totalContentHeight,
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
