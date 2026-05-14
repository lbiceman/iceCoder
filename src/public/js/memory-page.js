/**
 * 记忆图谱页面：每条记忆为纯色小圆结点，共用 tags 时连线；
 * 结点颜色取自冰豆色板哈希；画布支持滚轮缩放与拖拽平移。
 */

import { SESSION_PET_PALETTE_COLORS } from './session-pet-palette.js';

const PREVIEW_LEN = 50;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PAN_DRAG_THRESHOLD_PX = 6;
/** 结点中心占位半径（像素）：对齐 .memory-node 宽度与圆+芯片的视觉包络，用于留白与靠边夹紧 */
const MEMORY_LAYOUT_NODE_EXTENT_R = 92;
/** 螺旋半径系数 r = b*√k，越大结点越疏 */
const MEMORY_SPIRAL_B = 98;
/** 画布外边距（像素） */
const MEMORY_LAYOUT_MARGIN = 112;
/** 画布单边上限，极端多文件时仍可滚轮缩放浏览 */
const MEMORY_LAYOUT_CANVAS_CAP = 5600;
/** 圆内文件名 / 摘要多语言：按 Unicode 字符数截断近似 */
const DISC_TITLE_MAX = 9;
const DISC_SUMMARY_MAX = 11;
/** 记忆详情浮层距离视口边与锚点（圆）间隙 */
const MEMORY_POPOVER_MARGIN = 12;
const MEMORY_POPOVER_ANCHOR_GAP = 8;

function hashDjb2(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return Math.abs(h);
}

function paletteFillForKey(key) {
  var arr = SESSION_PET_PALETTE_COLORS;
  var idx = arr.length ? hashDjb2(key) % arr.length : 0;
  return arr[idx];
}

/** @returns {{ r:number, g:number, b:number }} */
function hexRgbComponents(hex) {
  var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 200, g: 200, b: 220 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

function isLightPaletteFill(hex) {
  var c = hexRgbComponents(hex);
  var y = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  return y > 0.72;
}

/**
 * @typedef {object} MemFileApi
 * @property {string} filename
 * @property {string} name
 * @property {string} type
 * @property {string} description
 * @property {string} contentPreview
 * @property {string} level project|user
 * @property {string} memoryLevel
 * @property {string} evidenceStrength
 * @property {string[]} tags
 * @property {string} [createdAt]
 * @property {string} [modifiedAt]
 */

function shortenText(t, len) {
  if (!t) return '';
  if (t.length <= len) return t;
  return t.slice(0, len) + '…';
}

function baseFilenameSansExt(pathOrName) {
  var leaf = pathOrName.replace(/^.*[/\\]/, '');
  leaf = leaf.replace(/\.md$/i, '');
  return leaf || pathOrName;
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str || ''));
  return div.innerHTML;
}

/** @param {string | undefined} iso */
function formatZhMemoryIso(iso) {
  if (!iso) return '—';
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (_e) {
    return '—';
  }
}

window.MemoryPage = (function () {
  var containerEl = null;
  var svgEl = null;
  var nodesLayerEl = null;
  /** @type {{ el: HTMLElement, x: number, y: number, cxGraph: number, cyGraph: number, data: MemFileApi }[]} */
  var nodeLayouts = [];

  /** @type {HTMLElement | null} */
  var popoverEl = null;
  /** @type {MemFileApi | null} */
  var popoverData = null;
  /** @type {string} */
  var popoverFocused = '';

  /** @type {MemFileApi[]} */
  var allFiles = [];
  /** @type {string | null} */
  var filterTag = null;
  /** @type {HTMLElement | null} 左侧标签侧栏 DOM，圆形点击时联动高亮 */
  var tagSidebarAsideEl = null;
  /** @type {AbortController | null} */
  var panZoomAbort = null;
  /** 画布平移缩放：合成 rAF，避免每条 wheel/move 都触发布局/绘制 */
  var graphPanZoomWheelRaf = 0;
  var graphPanZoomDragRaf = 0;

  function detachPanZoom() {
    if (graphPanZoomWheelRaf) {
      cancelAnimationFrame(graphPanZoomWheelRaf);
      graphPanZoomWheelRaf = 0;
    }
    if (graphPanZoomDragRaf) {
      cancelAnimationFrame(graphPanZoomDragRaf);
      graphPanZoomDragRaf = 0;
    }
    if (panZoomAbort) {
      panZoomAbort.abort();
      panZoomAbort = null;
    }
  }

  /** @type {(() => void) | null} */
  var resizeBound = null;
  /** 离开页或重新进入递增，丢弃过期异步（常数时间与零轮询）。 */
  var memoryPageEpoch = 0;
  /** @type {AbortController | null} */
  var listFetchAbort = null;
  var finishBusyRaf1 = 0;
  var finishBusyRaf2 = 0;
  var finishBusyRaf3 = 0;

  function cancelFinishBusyRafs() {
    if (finishBusyRaf1) {
      cancelAnimationFrame(finishBusyRaf1);
      finishBusyRaf1 = 0;
    }
    if (finishBusyRaf2) {
      cancelAnimationFrame(finishBusyRaf2);
      finishBusyRaf2 = 0;
    }
    if (finishBusyRaf3) {
      cancelAnimationFrame(finishBusyRaf3);
      finishBusyRaf3 = 0;
    }
  }

  function abortListFetch() {
    if (listFetchAbort) {
      try {
        listFetchAbort.abort();
      } catch (_e) {
        /* ignore */
      }
      listFetchAbort = null;
    }
  }

  function teardownMemoryPageRuntime() {
    cancelFinishBusyRafs();
    abortListFetch();
    closePopover();
    detachPanZoom();
    if (resizeBound) {
      window.removeEventListener('resize', resizeBound);
      resizeBound = null;
    }
  }

  function destroy() {
    teardownMemoryPageRuntime();
    memoryPageEpoch++;
    containerEl = null;
    svgEl = null;
    nodesLayerEl = null;
    nodeLayouts = [];
    allFiles = [];
    filterTag = null;
    tagSidebarAsideEl = null;
  }

  /**
   * 首帧连线 + 再两帧后移除遮罩，避免与 pan-zoom 初始 center 抢同一帧。
   * @param {HTMLElement} busyOverlay
   * @param {number} epochSnap
   */
  function scheduleRemoveBusyOverlay(busyOverlay, epochSnap) {
    cancelFinishBusyRafs();
    finishBusyRaf1 = requestAnimationFrame(function () {
      finishBusyRaf1 = 0;
      if (epochSnap !== memoryPageEpoch) return;
      redrawEdges();
      finishBusyRaf2 = requestAnimationFrame(function () {
        finishBusyRaf2 = 0;
        if (epochSnap !== memoryPageEpoch) return;
        finishBusyRaf3 = requestAnimationFrame(function () {
          finishBusyRaf3 = 0;
          if (epochSnap !== memoryPageEpoch) return;
          if (busyOverlay && busyOverlay.parentNode) {
            busyOverlay.parentNode.removeChild(busyOverlay);
          }
        });
      });
    });
  }

  /**
   * @param {HTMLElement} busyOverlay
   * @param {number} epochSnap
   */
  function dismissBusyOverlayNow(busyOverlay, epochSnap) {
    if (epochSnap !== memoryPageEpoch) return;
    if (busyOverlay && busyOverlay.parentNode) {
      busyOverlay.parentNode.removeChild(busyOverlay);
    }
  }

  function closePopover() {
    if (popoverEl && popoverEl.parentNode) {
      popoverEl.parentNode.removeChild(popoverEl);
    }
    popoverEl = null;
    popoverData = null;
    popoverFocused = '';
    document.removeEventListener('mousedown', onDocMouseDownPopover, true);
  }

  /** @param {MouseEvent} e */
  function onDocMouseDownPopover(e) {
    if (!popoverEl) return;
    if (popoverEl.contains(/** @type {Node} */(e.target))) return;
    closePopover();
  }

  /**
   * 把浮层塞进视口：优先贴在圆下方，不够则翻到圆上方。
   * @param {HTMLElement} el
   * @param {{ left: number, anchorTop: number, anchorBottom: number }} anchor viewport 像素，来自 getBoundingClientRect
   */
  function layoutMemoryPopoverInViewport(el, anchor) {
    var m = MEMORY_POPOVER_MARGIN;
    var gap = MEMORY_POPOVER_ANCHOR_GAP;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var r = el.getBoundingClientRect();
    var w = r.width || el.offsetWidth;
    var h = r.height || el.offsetHeight;
    var topBelow = anchor.anchorBottom + gap;
    var topAbove = anchor.anchorTop - gap - h;
    var fitsBelow = topBelow + h <= vh - m;
    var fitsAbove = topAbove >= m;
    var top;
    if (fitsBelow) {
      top = topBelow;
    } else if (fitsAbove) {
      top = topAbove;
    } else {
      var roomBelow = vh - anchor.anchorBottom - gap - m;
      var roomAbove = anchor.anchorTop - gap - m;
      if (roomBelow >= roomAbove) {
        top = Math.min(topBelow, vh - m - h);
      } else {
        top = Math.max(m, Math.min(topAbove, vh - m - h));
      }
    }
    var maxTopClamp = Math.max(m, vh - m - h);
    top = Math.max(m, Math.min(top, maxTopClamp));
    var left = Math.max(m, Math.min(anchor.left, vw - m - w));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  /**
   * @param {MemFileApi} file
   * @param {string} focusKey name|type|level|tag|body|filename
   * @param {{ left: number, anchorTop: number, anchorBottom: number }} anchor
   */
  function openPopover(file, focusKey, anchor) {
    closePopover();
    popoverData = file;
    popoverFocused = focusKey;

    var wrap = document.createElement('div');
    wrap.className = 'memory-popover';
    wrap.style.position = 'fixed';
    wrap.style.left = '0';
    wrap.style.top = '0';
    wrap.style.zIndex = '200';

    var title = file.name || file.filename;
    var focusLabel = {
      name: '名称',
      type: '类型',
      level: '存储层级',
      tag: '标签',
      body: '正文',
      filename: '文件名',
      memoryLevel: '记忆层级',
      evidenceStrength: '证据强度',
    }[focusKey] || '详情';

    var preview = file.contentPreview || '';
    var shortBody = shortenText(preview, PREVIEW_LEN);

    function kv(label, dk, text) {
      return (
        '<div class="memory-pop-dl-pair">' +
        '<dt>' +
        escapeHtml(label) +
        '</dt>' +
        '<dd data-k="' +
        dk +
        '" class="memory-pop-k">' +
        escapeHtml(text) +
        '</dd></div>'
      );
    }

    var tagsInline =
      file.tags && file.tags.length
        ? file.tags
          .map(function (t) {
            return (
              '<span class="memory-tag-pill" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>'
            );
          })
          .join(' ')
        : '—';

    wrap.innerHTML =
      '<div class="memory-popover-focus">' +
      escapeHtml(focusLabel) +
      '</div>' +
      '<div class="memory-popover-created">创建时间 · ' +
      escapeHtml(formatZhMemoryIso(file.createdAt || file.modifiedAt)) +
      '</div>' +
      '<div class="memory-popover-title">' +
      escapeHtml(title) +
      '</div>' +
      '<div class="memory-pop-dl-grid">' +
      kv('文件名', 'filename', file.filename) +
      kv('名称', 'name', file.name || '—') +
      kv('类型', 'type', file.type || '—') +
      kv('存储', 'level', file.level || '—') +
      kv('记忆层级', 'memoryLevel', file.memoryLevel || '—') +
      kv('证据', 'evidenceStrength', file.evidenceStrength || '—') +
      '<div class="memory-pop-dl-pair">' +
      '<dt>描述</dt>' +
      '<dd class="memory-pop-desc-dd">' +
      escapeHtml(file.description || '—') +
      '</dd></div>' +
      '<div class="memory-pop-dl-pair">' +
      '<dt>标签</dt>' +
      '<dd data-k="tag" class="memory-pop-tags memory-pop-k">' +
      tagsInline +
      '</dd></div>' +
      '</div>' +
      '<div class="memory-popover-body-label">记忆正文</div>' +
      '<div class="memory-popover-body memory-pop-body-short" data-full="0">' +
      escapeHtml(shortBody) +
      (preview.length > PREVIEW_LEN ? '' : '') +
      '</div>' +
      '<div class="memory-popover-actions">' +
      '<div class="memory-popover-actions-left">' +
      (preview.length > PREVIEW_LEN
        ? '<button type="button" class="memory-popover-more">更多</button>'
        : '') +
      '<button type="button" class="memory-popover-close">关闭</button>' +
      '</div>' +
      '<button type="button" class="memory-popover-delete">删除</button>' +
      '</div>' +
      '<div class="memory-popover-body memory-pop-body-full hidden"></div>';

    containerEl.appendChild(wrap);
    popoverEl = wrap;

    requestAnimationFrame(function () {
      layoutMemoryPopoverInViewport(wrap, anchor);
    });

    var bodyShort = wrap.querySelector('.memory-pop-body-short');
    var bodyFull = wrap.querySelector('.memory-pop-body-full');
    var moreBtn = wrap.querySelector('.memory-popover-more');

    wrap.querySelectorAll('.memory-tag-pill').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (focusKey === 'tag') return;
        var pillDd = /** @type {HTMLElement | null} */ (el.closest('.memory-pop-tags'));
        if (pillDd && pillDd.classList.contains('memory-pop-highlight')) return;
        openPopover(file, 'tag', anchor);
      });
    });

    if (moreBtn && bodyFull && bodyShort) {
      moreBtn.addEventListener('click', function () {
        if (moreBtn.dataset.loading === '1') return;
        if (bodyFull.textContent && bodyFull.classList.contains('hidden') === false) {
          bodyFull.classList.add('hidden');
          bodyShort.classList.remove('hidden');
          moreBtn.textContent = '更多';
          requestAnimationFrame(function () {
            layoutMemoryPopoverInViewport(wrap, anchor);
          });
          return;
        }
        if (bodyFull.dataset.loaded === '1') {
          bodyShort.classList.add('hidden');
          bodyFull.classList.remove('hidden');
          moreBtn.textContent = '收起';
          requestAnimationFrame(function () {
            layoutMemoryPopoverInViewport(wrap, anchor);
          });
          return;
        }
        moreBtn.dataset.loading = '1';
        moreBtn.textContent = '加载中…';
        fetch('/api/memory/files/' + encodeURIComponent(file.filename))
          .then(function (r) {
            return r.json();
          })
          .then(function (data) {
            moreBtn.dataset.loading = '0';
            if (!data.success) {
              moreBtn.textContent = '加载失败';
              return;
            }
            bodyFull.textContent = data.content || '';
            bodyFull.dataset.loaded = '1';
            bodyShort.classList.add('hidden');
            bodyFull.classList.remove('hidden');
            moreBtn.textContent = '收起';
            requestAnimationFrame(function () {
              layoutMemoryPopoverInViewport(wrap, anchor);
            });
          })
          .catch(function () {
            moreBtn.dataset.loading = '0';
            moreBtn.textContent = '重试';
          });
      });
    }

    wrap.querySelector('.memory-popover-close').addEventListener('click', function () {
      closePopover();
    });

    var deleteBtn = wrap.querySelector('.memory-popover-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var fn = file.filename;
        if (!fn || !containerEl) return;
        var label = file.name || fn;
        if (!confirm('确定删除记忆「' + label + '」？删除后不可恢复。')) return;
        deleteBtn.disabled = true;
        fetch('/api/memory/files/' + encodeURIComponent(fn), { method: 'DELETE' })
          .then(function (r) {
            return r.json().then(function (json) {
              return { ok: r.ok, json: json };
            });
          })
          .then(function (res) {
            deleteBtn.disabled = false;
            if (!res.ok || !res.json.success) {
              window.alert(res.json.error || res.json.message || '删除失败');
              return;
            }
            closePopover();
            render(containerEl);
          })
          .catch(function () {
            deleteBtn.disabled = false;
            window.alert('删除请求失败');
          });
      });
    }

    wrap.querySelectorAll('.memory-pop-k').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (/** @type {HTMLElement} */ (ev.currentTarget).classList.contains('memory-pop-highlight')) return;
        var k = el.getAttribute('data-k');
        if (!k || k === focusKey) return;
        openPopover(file, /** @type {string} */ (k), anchor);
      });
      var dk = el.getAttribute('data-k');
      el.classList.toggle('memory-pop-highlight', dk === focusKey);
    });
    var tagDdPop = wrap.querySelector('.memory-pop-tags');
    if (tagDdPop) {
      tagDdPop.classList.toggle('memory-pop-highlight', focusKey === 'tag');
    }

    setTimeout(function () {
      document.addEventListener('mousedown', onDocMouseDownPopover, true);
    }, 0);
  }

  /** @returns {HTMLElement} */
  function buildTagSidebar(tagsList) {
    var aside = document.createElement('aside');
    aside.className = 'memory-sidebar';
    aside.innerHTML =
      '<div class="memory-tag-cloud"></div>';

    var cloud = aside.querySelector('.memory-tag-cloud');
    tagsList.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'memory-sidebar-tag';
      b.dataset.tagValue = t.tag;
      b.textContent = t.tag + ' (' + t.count + ')';
      b.addEventListener('click', function () {
        filterTag = filterTag === t.tag ? null : t.tag;
        applyTagFilter();
        syncSidebarTagButtonsActive();
      });
      cloud.appendChild(b);
    });

    return aside;
  }

  function applyTagFilter() {
    nodeLayouts.forEach(function (n) {
      var show =
        !filterTag || (n.data.tags && n.data.tags.indexOf(filterTag) !== -1);
      n.el.classList.toggle('memory-node-dim', !show);
    });
    redrawEdges();
  }

  /** 与已移除的「显示全部」同源：清空标签筛选并同步侧栏 */
  function clearMemoryGraphTagFilter() {
    filterTag = null;
    applyTagFilter();
    syncSidebarTagButtonsActive();
  }

  /** 与左侧 `.memory-sidebar-tag` 勾选状态同源 */
  function syncSidebarTagButtonsActive() {
    var aside = tagSidebarAsideEl;
    if (!aside) return;
    aside.querySelectorAll('.memory-sidebar-tag').forEach(function (x) {
      var tv = /** @type {HTMLElement} */ (x).dataset.tagValue;
      x.classList.toggle('active', filterTag !== null && tv === filterTag);
    });
  }

  /**
   * 图谱圆选中时：侧边栏按标签项同一套逻辑筛选（使用该记忆的第一条标签；已在筛选该标签时再次点击等价取消筛选）。
   * @param {MemFileApi} file
   */
  function sidebarLinkageFromDiscActivatedMemory(file) {
    var tags = file.tags;
    var keyTag = tags && tags.length ? tags[0] : null;
    if (!keyTag) filterTag = null;
    else filterTag = filterTag === keyTag ? null : keyTag;
    applyTagFilter();
    syncSidebarTagButtonsActive();
  }

  function redrawEdges() {
    if (!svgEl || !nodesLayerEl || !containerEl) return;

    /** @type {SVGSVGElement} */
    var svg = svgEl;
    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }

    svg.setAttribute('width', String(nodesLayerEl.offsetWidth || 640));
    svg.setAttribute('height', String(nodesLayerEl.offsetHeight || 480));

    var fnameToCenter = {};
    nodeLayouts.forEach(function (n) {
      if (n.el.classList.contains('memory-node-dim')) return;
      fnameToCenter[n.data.filename] = { x: n.cxGraph, y: n.cyGraph };
    });

    /** @type {Record<string, string[]>} */
    var tagToFiles = {};
    nodeLayouts.forEach(function (n) {
      if (n.el.classList.contains('memory-node-dim')) return;
      (n.data.tags || []).forEach(function (t) {
        if (!tagToFiles[t]) tagToFiles[t] = [];
        tagToFiles[t].push(n.data.filename);
      });
    });

    Object.keys(tagToFiles).forEach(function (tag) {
      var files = tagToFiles[tag];
      if (files.length < 2) return;
      for (var i = 0; i < files.length; i++) {
        for (var j = i + 1; j < files.length; j++) {
          var a = fnameToCenter[files[i]];
          var b = fnameToCenter[files[j]];
          if (!a || !b) continue;

          var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          var hue = hashDjb2(tag + files[i] + files[j]) % 360;
          line.setAttribute('stroke', 'hsla(' + hue + ', 55%, 58%, 0.38)');
          line.setAttribute('stroke-width', filterTag === tag ? '2' : '1.25');
          line.setAttribute('x1', String(a.x));
          line.setAttribute('y1', String(a.y));
          line.setAttribute('x2', String(b.x));
          line.setAttribute('y2', String(b.y));
          svg.appendChild(line);
        }
      }
    });
  }

  /**
   * 视口滚轮缩放 + 左键拖拽平移（芯片/小标签上不触发拖拽起点）。
   * @param {HTMLElement} viewport
   * @param {HTMLElement} stage
   * @param {number} contentW
   * @param {number} contentH
   */
  function attachPanZoom(viewport, stage, contentW, contentH) {
    detachPanZoom();
    var ctrl = new AbortController();
    panZoomAbort = ctrl;
    var sig = ctrl.signal;

    var scale = 1;
    var panX = 0;
    var panY = 0;

    function applyTransform() {
      stage.style.zoom = '';
      stage.style.transform =
        'translate3d(' + panX + 'px,' + panY + 'px,0) scale(' + scale + ')';
    }

    function centerInViewport() {
      var vw = viewport.clientWidth || 640;
      var vh = viewport.clientHeight || 480;
      /** 留白略收窄；画布小于视口时允许略大于 100%，默认稍大 */
      var fitRaw = Math.min(vw / contentW, vh / contentH) * 1.2;
      scale = Math.min(1.08, Math.max(0.05, Math.min(fitRaw || 1, 6)));
      panX = (vw - contentW * scale) / 2;
      panY = (vh - contentH * scale) / 2;
      applyTransform();
    }

    var wheelDyAccum = 0;
    var wheelMx = 0;
    var wheelMy = 0;

    viewport.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        wheelDyAccum += e.deltaY;
        var rect = viewport.getBoundingClientRect();
        wheelMx = e.clientX - rect.left;
        wheelMy = e.clientY - rect.top;
        if (!graphPanZoomWheelRaf) {
          graphPanZoomWheelRaf = requestAnimationFrame(function flushWheelZoom() {
            graphPanZoomWheelRaf = 0;
            if (wheelDyAccum === 0) return;
            var factor = Math.exp(-wheelDyAccum * 0.00115);
            wheelDyAccum = 0;
            var newScale = Math.min(6, Math.max(0.05, scale * factor));
            var wx = (wheelMx - panX) / scale;
            var wy = (wheelMy - panY) / scale;
            panX = wheelMx - wx * newScale;
            panY = wheelMy - wy * newScale;
            scale = newScale;
            applyTransform();
          });
        }
      },
      { passive: false, signal: sig },
    );

    /** @type {{ sx:number, sy:number, lx:number, ly:number, dragging:boolean } | null} */
    var panState = null;

    viewport.addEventListener(
      'mousedown',
      function (e) {
        if (e.button !== 0) return;
        panState = {
          sx: e.clientX,
          sy: e.clientY,
          lx: e.clientX,
          ly: e.clientY,
          dragging: false,
        };
        viewport.style.cursor = 'grabbing';
      },
      { signal: sig },
    );

    viewport.addEventListener(
      'dblclick',
      function (e) {
        var t = /** @type {HTMLElement} */ (e.target);
        if (t.closest('.memory-node')) return;
        e.preventDefault();
        clearMemoryGraphTagFilter();
      },
      { signal: sig },
    );

    document.addEventListener(
      'mousemove',
      function (e) {
        if (!panState) return;
        var dx0 = e.clientX - panState.sx;
        var dy0 = e.clientY - panState.sy;
        if (
          !panState.dragging &&
          (Math.abs(dx0) > PAN_DRAG_THRESHOLD_PX ||
            Math.abs(dy0) > PAN_DRAG_THRESHOLD_PX)
        ) {
          panState.dragging = true;
        }
        if (panState.dragging) {
          panX += e.clientX - panState.lx;
          panY += e.clientY - panState.ly;
          panState.lx = e.clientX;
          panState.ly = e.clientY;
          if (!graphPanZoomDragRaf) {
            graphPanZoomDragRaf = requestAnimationFrame(function flushPanDrag() {
              graphPanZoomDragRaf = 0;
              applyTransform();
            });
          }
        }
      },
      { signal: sig },
    );

    document.addEventListener(
      'mouseup',
      function (e) {
        if (!panState) return;
        if (e.button !== 0) return;
        var dragged = panState.dragging;
        if (graphPanZoomDragRaf) {
          cancelAnimationFrame(graphPanZoomDragRaf);
          graphPanZoomDragRaf = 0;
        }
        if (dragged) {
          applyTransform();
        }
        panState = null;
        viewport.style.cursor = '';

        if (dragged) return;

        var el = /** @type {HTMLElement} */ (e.target);
        var disc =
          el.closest && /** @type {HTMLElement | null} */ (el.closest('.memory-node-disc'));
        var fnAttr = disc && disc.dataset.memoryFilename ? disc.dataset.memoryFilename : '';
        if (!fnAttr) return;
        for (var qi = 0; qi < nodeLayouts.length; qi++) {
          if (nodeLayouts[qi].data.filename === fnAttr) {
            var mem = nodeLayouts[qi].data;
            sidebarLinkageFromDiscActivatedMemory(mem);
            var r2 = disc.getBoundingClientRect();
            openPopover(mem, 'body', {
              left: r2.left,
              anchorTop: r2.top,
              anchorBottom: r2.bottom,
            });
            break;
          }
        }
      },
      { signal: sig },
    );

    stage.style.transformOrigin = '0 0';
    applyTransform();

    requestAnimationFrame(function () {
      centerInViewport();
    });
  }

  /**
   * @param {{ files: MemFileApi[] }} data
   * @param {HTMLElement | null} [busyOverlay]
   * @param {number} [epochSnap]
   */
  function layoutAndRenderNodes(
    data,
    graphEl,
    _unusedTagList,
    viewport,
    busyOverlay,
    epochSnap,
  ) {
    detachPanZoom();
    nodesLayerEl = graphEl;
    nodeLayouts = [];
    graphEl.innerHTML = '';

    var n = data.files.length;
    if (n === 0) {
      if (busyOverlay != null && epochSnap !== undefined)
        dismissBusyOverlayNow(busyOverlay, epochSnap);
      return;
    }

    var margin = MEMORY_LAYOUT_MARGIN;
    var extentR = MEMORY_LAYOUT_NODE_EXTENT_R;
    var spiralB = MEMORY_SPIRAL_B;
    /** 最远轨迹半径≈ spiralB·√n，画布随 √(节点数) 放大，结点不再挤在同一窄环带 */
    var outerRf =
      n <= 1 ? 0 : spiralB * Math.sqrt(n);
    /** 视口占位下限，避免出现异常小的舞台 */
    var viewportHint =
      Math.max(graphEl.offsetWidth || 880, graphEl.offsetHeight || 620) * 1.08;
    var neededHalf = margin + outerRf + extentR;
    var sideNeeds = Math.max(viewportHint, 2 * neededHalf);
    var side = Math.min(MEMORY_LAYOUT_CANVAS_CAP, sideNeeds);
    /** 画布触顶时压缩螺旋半径（仍保持结点相对疏密），禁止全部挤在外圈边界 */
    var maxHalfAvail = side / 2 - margin - extentR;
    var radialScale =
      outerRf <= 0 || maxHalfAvail <= 0 ? 1 : Math.min(1, maxHalfAvail / outerRf);
    var W = side;
    var H = side;
    var cx0 = W / 2;
    var cy0 = H / 2;
    /** @type {{ filename: string, x:number, y:number }[]} */
    var pos = [];

    for (var i = 0; i < n; i++) {
      var idx = i + 1;
      var rf = n === 1 ? 0 : spiralB * Math.sqrt(idx) * radialScale;
      var ang = idx * GOLDEN_ANGLE;
      var x = cx0 + rf * Math.cos(ang);
      var y = cy0 + rf * Math.sin(ang);

      x = Math.max(margin + extentR, Math.min(W - margin - extentR, x));
      y = Math.max(margin + extentR, Math.min(H - margin - extentR, y));
      pos.push({ filename: data.files[i].filename, x: x, y: y });
    }

    svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('class', 'memory-edge-svg');

    graphEl.style.position = 'relative';
    graphEl.style.minWidth = W + 'px';
    graphEl.style.minHeight = H + 'px';

    graphEl.appendChild(svgEl);

    for (var fi = 0; fi < n; fi++) {
      var file = data.files[fi];
      var p = pos[fi];
      var fillCol = paletteFillForKey(file.filename);

      var nodeWrap = document.createElement('div');
      nodeWrap.className = 'memory-node';
      nodeWrap.style.position = 'absolute';
      nodeWrap.style.left = p.x + 'px';
      nodeWrap.style.top = p.y + 'px';
      nodeWrap.dataset.filename = file.filename;

      var titleLine = shortenText(
        file.name || baseFilenameSansExt(file.filename),
        DISC_TITLE_MAX,
      );
      var sumPlain = (
        file.contentPreview ||
        file.description ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      var sumLine = shortenText(sumPlain, DISC_SUMMARY_MAX);

      var disc = document.createElement('div');
      disc.className = 'memory-node-disc';
      disc.setAttribute('role', 'button');
      disc.tabIndex = 0;
      disc.dataset.memoryFilename = file.filename;
      disc.style.backgroundColor = fillCol;
      if (isLightPaletteFill(fillCol)) disc.classList.add('memory-node-disc-darktext');
      disc.innerHTML =
        '<span class="memory-disc-text memory-disc-title">' +
        escapeHtml(titleLine) +
        '</span>' +
        '<span class="memory-disc-text memory-disc-sum">' +
        escapeHtml(sumLine ? sumLine : '·') +
        '</span>';

      ; (function (memFile, discEl) {
        discEl.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            sidebarLinkageFromDiscActivatedMemory(memFile);
            var r2 = discEl.getBoundingClientRect();
            openPopover(memFile, 'body', {
              left: r2.left,
              anchorTop: r2.top,
              anchorBottom: r2.bottom,
            });
          }
        });
      })(file, disc);

      var chips = document.createElement('div');
      chips.className = 'memory-node-chips';

      var bl = document.createElement('span');
      bl.className = 'memory-chip memory-chip-store';
      bl.textContent = file.level === 'user' ? '用户' : '项目';

      chips.appendChild(bl);

      if (file.tags && file.tags.length) {
        var tagRow = document.createElement('div');
        tagRow.className = 'memory-node-tags';
        file.tags.slice(0, 4).forEach(function (tg) {
          var tbtn = document.createElement('span');
          tbtn.className = 'memory-micro-tag';
          tbtn.textContent = tg.split(':')[1] || tg;
          tbtn.title = tg;
          tagRow.appendChild(tbtn);
        });
        chips.appendChild(tagRow);
      }

      nodeWrap.appendChild(disc);
      nodeWrap.appendChild(chips);
      graphEl.appendChild(nodeWrap);
      nodeLayouts.push({
        el: nodeWrap,
        x: p.x,
        y: p.y,
        cxGraph: p.x,
        cyGraph: p.y,
        data: file,
      });
    }

    var stageParent = graphEl.parentElement;
    if (viewport && stageParent) {
      attachPanZoom(viewport, stageParent, W, H);
    }

    if (resizeBound) window.removeEventListener('resize', resizeBound);
    resizeBound = function () {
      redrawEdges();
    };
    window.addEventListener('resize', resizeBound);

    if (busyOverlay != null && epochSnap !== undefined) {
      scheduleRemoveBusyOverlay(busyOverlay, epochSnap);
    } else {
      cancelFinishBusyRafs();
      requestAnimationFrame(function () {
        redrawEdges();
      });
    }
  }

  function renderSidebarTags(files) {
    /** @type {Record<string, number>} */
    var counts = {};
    files.forEach(function (f) {
      (f.tags || []).forEach(function (t) {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.keys(counts)
      .sort(function (a, b) {
        return counts[b] - counts[a] || a.localeCompare(b);
      })
      .map(function (tag) {
        return { tag: tag, count: counts[tag] };
      });
  }

  function render(innerContainer) {
    teardownMemoryPageRuntime();
    var epochSnap = ++memoryPageEpoch;

    containerEl = innerContainer;
    innerContainer.innerHTML = '';
    filterTag = null;
    tagSidebarAsideEl = null;
    svgEl = null;
    nodeLayouts = [];
    nodesLayerEl = null;

    /** @type {HTMLElement} */
    var root = /** @type {HTMLElement} */ (document.createElement('div'));
    root.className = 'memory-root';

    var header = document.createElement('header');
    header.className = 'memory-header';
    header.innerHTML =
      '<div class="memory-header-text">' +
      '<h1 class="memory-title">记忆图谱</h1>' +
      '<p class="memory-sidebar-hint">' +
      '圆点表示一条记忆，<strong>共用标签</strong>的会用线连起来。左侧可点标签筛选画布；滚轮缩放、拖动画布平移；点圆打开详情，双击空白取消筛选。' +
      '</p>' +
      '</div>' +
      '<button type="button" class="memory-back-chat">返回聊天</button>';

    header.querySelector('.memory-back-chat').addEventListener('click', function () {
      window.location.hash = '#/chat';
    });

    var main = document.createElement('main');
    main.className = 'memory-main';

    var graphArea = document.createElement('section');
    graphArea.className = 'memory-graph-area memory-graph-shell';
    graphArea.innerHTML =
      '<div class="memory-page-busy" role="status" aria-busy="true"><span class="memory-page-busy-text">载入中…</span></div>' +
      '<div class="memory-loading memory-loading-hidden" aria-live="polite"></div>' +
      '<div class="memory-graph-scroll memory-graph-viewport hidden">' +
      '<div class="memory-graph-stage">' +
      '<div class="memory-graph-inner"></div></div></div>';

    main.appendChild(graphArea);

    root.appendChild(header);
    root.appendChild(main);
    innerContainer.appendChild(root);

    listFetchAbort = new AbortController();

    fetch('/api/memory/files', { signal: listFetchAbort.signal })
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        if (epochSnap !== memoryPageEpoch) return;

        var busyEl = graphArea.querySelector('.memory-page-busy');
        var loadingEl = graphArea.querySelector('.memory-loading');
        var scrollWrap = graphArea.querySelector('.memory-graph-scroll');
        var innerGraph = graphArea.querySelector('.memory-graph-inner');

        if (
          !loadingEl ||
          !scrollWrap ||
          !innerGraph ||
          !data.success ||
          !data.files ||
          !data.files.length
        ) {
          cancelFinishBusyRafs();
          if (busyEl) dismissBusyOverlayNow(busyEl, epochSnap);
          if (
            epochSnap !== memoryPageEpoch ||
            !loadingEl
          )
            return;
          loadingEl.classList.remove('hidden');
          loadingEl.innerHTML =
            '📭 暂无记忆文件。对话产生的记忆会先写入 data/memory-files 或用户目录。';
          return;
        }

        allFiles = data.files;
        var tagList = renderSidebarTags(data.files);

        var aside = buildTagSidebar(tagList);
        tagSidebarAsideEl = aside;
        main.insertBefore(aside, graphArea);

        if (epochSnap !== memoryPageEpoch) return;

        scrollWrap.classList.remove('hidden');

        layoutAndRenderNodes(
          { files: data.files },
          innerGraph,
          tagList,
          scrollWrap,
          busyEl,
          epochSnap,
        );
      })
      .catch(function (err) {
        if (epochSnap !== memoryPageEpoch) return;
        if (err && /** @type {Error} */ (err).name === 'AbortError') return;
        cancelFinishBusyRafs();
        var busyEl = graphArea.querySelector('.memory-page-busy');
        var loadingEl = graphArea.querySelector('.memory-loading');
        if (busyEl) dismissBusyOverlayNow(busyEl, epochSnap);
        if (
          epochSnap !== memoryPageEpoch ||
          !loadingEl
        )
          return;
        loadingEl.classList.remove('hidden');
        loadingEl.innerHTML =
          '<span style="color:var(--danger)">载入失败。</span>';
      });
  }

  return { render: render, destroy: destroy };
})();


