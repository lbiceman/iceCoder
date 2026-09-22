// @ts-nocheck
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
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return Math.abs(h);
}

function paletteFillForKey(key) {
  const arr = SESSION_PET_PALETTE_COLORS;
  const idx = arr.length ? hashDjb2(key) % arr.length : 0;
  return arr[idx];
}

/** @returns {{ r:number, g:number, b:number }} */
function hexRgbComponents(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 200, g: 200, b: 220 };
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
  };
}

function isLightPaletteFill(hex) {
  const c = hexRgbComponents(hex);
  const y = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
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
  return `${t.slice(0, len)}…`;
}

function baseFilenameSansExt(pathOrName) {
  let leaf = pathOrName.replace(/^.*[/\\]/, '');
  leaf = leaf.replace(/\.md$/i, '');
  return leaf || pathOrName;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str || ''));
  return div.innerHTML;
}

function isMobile() {
  return window.innerWidth <= 720;
}

/** @param {string | undefined} iso */
function formatZhMemoryIso(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
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

export const MemoryPage = (() => {
  let containerEl = null;
  let svgEl = null;
  let nodesLayerEl = null;
  /** @type {{ el: HTMLElement, x: number, y: number, cxGraph: number, cyGraph: number, data: MemFileApi }[]} */
  let nodeLayouts = [];

  /** @type {HTMLElement | null} */
  let popoverEl = null;
  /** @type {MemFileApi | null} */
  let popoverData = null;
  /** @type {string} */
  let popoverFocused = '';

  /** @type {MemFileApi[]} */
  let allFiles = [];
  /** @type {string | null} */
  let filterTag = null;
  /** @type {HTMLElement | null} 左侧标签侧栏 DOM，圆形点击时联动高亮 */
  let tagSidebarAsideEl = null;
  /** @type {AbortController | null} */
  let panZoomAbort = null;
  /** 画布平移缩放：合成 rAF，避免每条 wheel/move 都触发布局/绘制 */
  let graphPanZoomWheelRaf = 0;
  let graphPanZoomDragRaf = 0;

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
  let resizeBound = null;
  /** 离开页或重新进入递增，丢弃过期异步（常数时间与零轮询）。 */
  let memoryPageEpoch = 0;
  /** @type {AbortController | null} */
  let listFetchAbort = null;
  let dreamPollTimer = null;

  function stopDreamPoll() {
    if (dreamPollTimer) {
      clearInterval(dreamPollTimer);
      dreamPollTimer = null;
    }
  }
  let finishBusyRaf1 = 0;
  let finishBusyRaf2 = 0;
  let finishBusyRaf3 = 0;

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
    stopDreamPoll();
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
    finishBusyRaf1 = requestAnimationFrame(() => {
      finishBusyRaf1 = 0;
      if (epochSnap !== memoryPageEpoch) return;
      redrawEdges();
      finishBusyRaf2 = requestAnimationFrame(() => {
        finishBusyRaf2 = 0;
        if (epochSnap !== memoryPageEpoch) return;
        finishBusyRaf3 = requestAnimationFrame(() => {
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
    const m = MEMORY_POPOVER_MARGIN;
    const gap = MEMORY_POPOVER_ANCHOR_GAP;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const r = el.getBoundingClientRect();
    const w = r.width || el.offsetWidth;
    const h = r.height || el.offsetHeight;
    const topBelow = anchor.anchorBottom + gap;
    const topAbove = anchor.anchorTop - gap - h;
    const fitsBelow = topBelow + h <= vh - m;
    const fitsAbove = topAbove >= m;
    let top;
    if (fitsBelow) {
      top = topBelow;
    } else if (fitsAbove) {
      top = topAbove;
    } else {
      const roomBelow = vh - anchor.anchorBottom - gap - m;
      const roomAbove = anchor.anchorTop - gap - m;
      if (roomBelow >= roomAbove) {
        top = Math.min(topBelow, vh - m - h);
      } else {
        top = Math.max(m, Math.min(topAbove, vh - m - h));
      }
    }
    const maxTopClamp = Math.max(m, vh - m - h);
    top = Math.max(m, Math.min(top, maxTopClamp));
    const left = Math.max(m, Math.min(anchor.left, vw - m - w));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
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

    const wrap = document.createElement('div');
    wrap.className = 'memory-popover';
    wrap.style.position = 'fixed';
    wrap.style.left = '0';
    wrap.style.top = '0';
    wrap.style.zIndex = '200';

    const title = file.name || file.filename;
    const focusLabel = {
      name: '名称',
      type: '类型',
      level: '存储层级',
      tag: '标签',
      body: '正文',
      filename: '文件名',
      memoryLevel: '记忆层级',
      evidenceStrength: '证据强度',
    }[focusKey] || '详情';

    const preview = file.contentPreview || '';
    const shortBody = shortenText(preview, PREVIEW_LEN);

    function kv(label, dk, text) {
      return (
        `<div class="memory-pop-dl-pair"><dt>${escapeHtml(label)}</dt><dd data-k="${dk}" class="memory-pop-k">${escapeHtml(text)}</dd></div>`
      );
    }

    const tagsInline =
      file.tags && file.tags.length
        ? file.tags
          .map((t) => {
            return (
              `<span class="memory-tag-pill" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`
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

    requestAnimationFrame(() => {
      layoutMemoryPopoverInViewport(wrap, anchor);
    });

    const bodyShort = wrap.querySelector('.memory-pop-body-short');
    const bodyFull = wrap.querySelector('.memory-pop-body-full');
    const moreBtn = wrap.querySelector('.memory-popover-more');

    wrap.querySelectorAll('.memory-tag-pill').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (focusKey === 'tag') return;
        const pillDd = /** @type {HTMLElement | null} */ (el.closest('.memory-pop-tags'));
        if (pillDd && pillDd.classList.contains('memory-pop-highlight')) return;
        openPopover(file, 'tag', anchor);
      });
    });

    if (moreBtn && bodyFull && bodyShort) {
      moreBtn.addEventListener('click', () => {
        if (moreBtn.dataset.loading === '1') return;
        if (bodyFull.textContent && bodyFull.classList.contains('hidden') === false) {
          bodyFull.classList.add('hidden');
          bodyShort.classList.remove('hidden');
          moreBtn.textContent = '更多';
          requestAnimationFrame(() => {
            layoutMemoryPopoverInViewport(wrap, anchor);
          });
          return;
        }
        if (bodyFull.dataset.loaded === '1') {
          bodyShort.classList.add('hidden');
          bodyFull.classList.remove('hidden');
          moreBtn.textContent = '收起';
          requestAnimationFrame(() => {
            layoutMemoryPopoverInViewport(wrap, anchor);
          });
          return;
        }
        moreBtn.dataset.loading = '1';
        moreBtn.textContent = '加载中…';
        fetch(`/api/memory/files/${encodeURIComponent(file.filename)}`)
          .then((r) =>  r.json())
          .then((data) => {
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
            requestAnimationFrame(() => {
              layoutMemoryPopoverInViewport(wrap, anchor);
            });
          })
          .catch(() => {
            moreBtn.dataset.loading = '0';
            moreBtn.textContent = '重试';
          });
      });
    }

    wrap.querySelector('.memory-popover-close').addEventListener('click', () => {
      closePopover();
    });

    const deleteBtn = wrap.querySelector('.memory-popover-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const fn = file.filename;
        if (!fn || !containerEl) return;
        const label = file.name || fn;
        confirmDeleteMemory(label).then((ok) => {
          if (!ok) return;
          deleteBtn.disabled = true;
          fetch(`/api/memory/files/${encodeURIComponent(fn)}`, { method: 'DELETE' })
            .then((r) => {
              return r.json().then((json) =>  ({ ok: r.ok, json }));
            })
            .then((res) => {
              deleteBtn.disabled = false;
              if (!res.ok || !res.json.success) {
                Notification.error(res.json.error || res.json.message || '删除失败');
                return;
              }
              closePopover();
              render(containerEl);
            })
            .catch(() => {
              deleteBtn.disabled = false;
              Notification.error('删除请求失败');
            });
        });
      });
    }

    wrap.querySelectorAll('.memory-pop-k').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (/** @type {HTMLElement} */ (ev.currentTarget).classList.contains('memory-pop-highlight')) return;
        const k = el.getAttribute('data-k');
        if (!k || k === focusKey) return;
        openPopover(file, /** @type {string} */ (k), anchor);
      });
      const dk = el.getAttribute('data-k');
      el.classList.toggle('memory-pop-highlight', dk === focusKey);
    });
    const tagDdPop = wrap.querySelector('.memory-pop-tags');
    if (tagDdPop) {
      tagDdPop.classList.toggle('memory-pop-highlight', focusKey === 'tag');
    }

    setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDownPopover, true);
    }, 0);
  }

  /** @returns {HTMLElement} */
  function buildTagSidebar(tagsList) {
    const aside = document.createElement('aside');
    aside.className = 'memory-sidebar';
    aside.innerHTML =
      '<div class="memory-tag-cloud"></div>';

    const cloud = aside.querySelector('.memory-tag-cloud');
    tagsList.forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'memory-sidebar-tag';
      b.dataset.tagValue = t.tag;
      b.textContent = `${t.tag} (${t.count})`;
      b.addEventListener('click', () => {
        filterTag = filterTag === t.tag ? null : t.tag;
        applyTagFilter();
        syncSidebarTagButtonsActive();
      });
      cloud.appendChild(b);
    });

    return aside;
  }

  function applyTagFilter() {
    nodeLayouts.forEach((n) => {
      const show =
        !filterTag || (n.data.tags && n.data.tags.includes(filterTag));
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
    const aside = tagSidebarAsideEl;
    if (!aside) return;
    aside.querySelectorAll('.memory-sidebar-tag').forEach((x) => {
      const tv = /** @type {HTMLElement} */ (x).dataset.tagValue;
      x.classList.toggle('active', filterTag !== null && tv === filterTag);
    });
  }

  /**
   * 图谱圆选中时：侧边栏按标签项同一套逻辑筛选（使用该记忆的第一条标签；已在筛选该标签时再次点击等价取消筛选）。
   * @param {MemFileApi} file
   */
  function sidebarLinkageFromDiscActivatedMemory(file) {
    const tags = file.tags;
    const keyTag = tags && tags.length ? tags[0] : null;
    if (!keyTag) filterTag = null;
    else filterTag = filterTag === keyTag ? null : keyTag;
    applyTagFilter();
    syncSidebarTagButtonsActive();
  }

  function redrawEdges() {
    if (!svgEl || !nodesLayerEl || !containerEl) return;

    /** @type {SVGSVGElement} */
    const svg = svgEl;
    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }

    svg.setAttribute('width', String(nodesLayerEl.offsetWidth || 640));
    svg.setAttribute('height', String(nodesLayerEl.offsetHeight || 480));

    const fnameToCenter = {};
    nodeLayouts.forEach((n) => {
      if (n.el.classList.contains('memory-node-dim')) return;
      fnameToCenter[n.data.filename] = { x: n.cxGraph, y: n.cyGraph };
    });

    /** @type {Record<string, string[]>} */
    const tagToFiles = {};
    nodeLayouts.forEach((n) => {
      if (n.el.classList.contains('memory-node-dim')) return;
      (n.data.tags || []).forEach((t) => {
        if (!tagToFiles[t]) tagToFiles[t] = [];
        tagToFiles[t].push(n.data.filename);
      });
    });

    Object.keys(tagToFiles).forEach((tag) => {
      const files = tagToFiles[tag];
      if (files.length < 2) return;
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const a = fnameToCenter[files[i]];
          const b = fnameToCenter[files[j]];
          if (!a || !b) continue;

          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          const hue = hashDjb2(tag + files[i] + files[j]) % 360;
          line.setAttribute('stroke', `hsla(${hue}, 55%, 58%, 0.38)`);
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
    const ctrl = new AbortController();
    panZoomAbort = ctrl;
    const sig = ctrl.signal;

    let scale = 1;
    let panX = 0;
    let panY = 0;

    function applyTransform() {
      stage.style.zoom = '';
      stage.style.transform =
        `translate3d(${panX}px,${panY}px,0) scale(${scale})`;
    }

    function centerInViewport() {
      const vw = viewport.clientWidth || 640;
      const vh = viewport.clientHeight || 480;
      /** 留白略收窄；画布小于视口时允许略大于 100%，默认稍大 */
      const fitRaw = Math.min(vw / contentW, vh / contentH) * 1.2;
      scale = Math.min(1.08, Math.max(0.05, Math.min(fitRaw || 1, 6)));
      panX = (vw - contentW * scale) / 2;
      panY = (vh - contentH * scale) / 2;
      applyTransform();
    }

    let wheelDyAccum = 0;
    let wheelMx = 0;
    let wheelMy = 0;

    viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        wheelDyAccum += e.deltaY;
        const rect = viewport.getBoundingClientRect();
        wheelMx = e.clientX - rect.left;
        wheelMy = e.clientY - rect.top;
        if (!graphPanZoomWheelRaf) {
          graphPanZoomWheelRaf = requestAnimationFrame(function flushWheelZoom() {
            graphPanZoomWheelRaf = 0;
            if (wheelDyAccum === 0) return;
            const factor = Math.exp(-wheelDyAccum * 0.00115);
            wheelDyAccum = 0;
            const newScale = Math.min(6, Math.max(0.05, scale * factor));
            const wx = (wheelMx - panX) / scale;
            const wy = (wheelMy - panY) / scale;
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
    let panState = null;

    viewport.addEventListener(
      'mousedown',
      (e) => {
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
      (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t.closest('.memory-node')) return;
        e.preventDefault();
        clearMemoryGraphTagFilter();
      },
      { signal: sig },
    );

    document.addEventListener(
      'mousemove',
      (e) => {
        if (!panState) return;
        const dx0 = e.clientX - panState.sx;
        const dy0 = e.clientY - panState.sy;
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
      (e) => {
        if (!panState) return;
        if (e.button !== 0) return;
        const dragged = panState.dragging;
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

        const el = /** @type {HTMLElement} */ (e.target);
        const disc =
          el.closest && /** @type {HTMLElement | null} */ (el.closest('.memory-node-disc'));
        const fnAttr = disc && disc.dataset.memoryFilename ? disc.dataset.memoryFilename : '';
        if (!fnAttr) return;
        for (let qi = 0; qi < nodeLayouts.length; qi++) {
          if (nodeLayouts[qi].data.filename === fnAttr) {
            const mem = nodeLayouts[qi].data;
            sidebarLinkageFromDiscActivatedMemory(mem);
            const r2 = disc.getBoundingClientRect();
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

    requestAnimationFrame(() => {
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

    const n = data.files.length;
    if (n === 0) {
      if (busyOverlay != null && epochSnap !== undefined)
        dismissBusyOverlayNow(busyOverlay, epochSnap);
      return;
    }

    const margin = MEMORY_LAYOUT_MARGIN;
    const extentR = MEMORY_LAYOUT_NODE_EXTENT_R;
    const spiralB = MEMORY_SPIRAL_B;
    /** 最远轨迹半径≈ spiralB·√n，画布随 √(节点数) 放大，结点不再挤在同一窄环带 */
    const outerRf =
      n <= 1 ? 0 : spiralB * Math.sqrt(n);
    /** 视口占位下限，避免出现异常小的舞台 */
    const viewportHint =
      Math.max(graphEl.offsetWidth || 880, graphEl.offsetHeight || 620) * 1.08;
    const neededHalf = margin + outerRf + extentR;
    const sideNeeds = Math.max(viewportHint, 2 * neededHalf);
    const side = Math.min(MEMORY_LAYOUT_CANVAS_CAP, sideNeeds);
    /** 画布触顶时压缩螺旋半径（仍保持结点相对疏密），禁止全部挤在外圈边界 */
    const maxHalfAvail = side / 2 - margin - extentR;
    const radialScale =
      outerRf <= 0 || maxHalfAvail <= 0 ? 1 : Math.min(1, maxHalfAvail / outerRf);
    const W = side;
    const H = side;
    const cx0 = W / 2;
    const cy0 = H / 2;
    /** @type {{ filename: string, x:number, y:number }[]} */
    const pos = [];

    for (let i = 0; i < n; i++) {
      const idx = i + 1;
      const rf = n === 1 ? 0 : spiralB * Math.sqrt(idx) * radialScale;
      const ang = idx * GOLDEN_ANGLE;
      let x = cx0 + rf * Math.cos(ang);
      let y = cy0 + rf * Math.sin(ang);

      x = Math.max(margin + extentR, Math.min(W - margin - extentR, x));
      y = Math.max(margin + extentR, Math.min(H - margin - extentR, y));
      pos.push({ filename: data.files[i].filename, x, y });
    }

    svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('class', 'memory-edge-svg');

    graphEl.style.position = 'relative';
    graphEl.style.minWidth = `${W}px`;
    graphEl.style.minHeight = `${H}px`;

    graphEl.appendChild(svgEl);

    for (let fi = 0; fi < n; fi++) {
      const file = data.files[fi];
      const p = pos[fi];
      const fillCol = paletteFillForKey(file.filename);

      const nodeWrap = document.createElement('div');
      nodeWrap.className = 'memory-node';
      nodeWrap.style.position = 'absolute';
      nodeWrap.style.left = `${p.x}px`;
      nodeWrap.style.top = `${p.y}px`;
      nodeWrap.dataset.filename = file.filename;

      const titleLine = shortenText(
        file.name || baseFilenameSansExt(file.filename),
        DISC_TITLE_MAX,
      );
      const sumPlain = (
        file.contentPreview ||
        file.description ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      const sumLine = shortenText(sumPlain, DISC_SUMMARY_MAX);

      const disc = document.createElement('div');
      disc.className = 'memory-node-disc';
      disc.setAttribute('role', 'button');
      disc.tabIndex = 0;
      disc.dataset.memoryFilename = file.filename;
      disc.style.backgroundColor = fillCol;
      if (isLightPaletteFill(fillCol)) disc.classList.add('memory-node-disc-darktext');
      disc.innerHTML =
        `<span class="memory-disc-text memory-disc-title">${escapeHtml(titleLine)}</span><span class="memory-disc-text memory-disc-sum">${escapeHtml(sumLine ? sumLine : '·')}</span>`;

      ; ((memFile, discEl) => {
        discEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            sidebarLinkageFromDiscActivatedMemory(memFile);
            const r2 = discEl.getBoundingClientRect();
            openPopover(memFile, 'body', {
              left: r2.left,
              anchorTop: r2.top,
              anchorBottom: r2.bottom,
            });
          }
        });
      })(file, disc);

      const chips = document.createElement('div');
      chips.className = 'memory-node-chips';

      const bl = document.createElement('span');
      bl.className = 'memory-chip memory-chip-store';
      bl.textContent = file.level === 'user' ? '用户' : '项目';

      chips.appendChild(bl);

      if (file.tags && file.tags.length) {
        const tagRow = document.createElement('div');
        tagRow.className = 'memory-node-tags';
        file.tags.slice(0, 4).forEach((tg) => {
          const tbtn = document.createElement('span');
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

    const stageParent = graphEl.parentElement;
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
      requestAnimationFrame(() => {
        redrawEdges();
      });
    }
  }

  function renderSidebarTags(files) {
    /** @type {Record<string, number>} */
    const counts = {};
    files.forEach((f) => {
      (f.tags || []).forEach((t) => {
        counts[t] = (counts[t] || 0) + 1;
      });
    });
    return Object.keys(counts)
      .sort((a, b) =>  counts[b] - counts[a] || a.localeCompare(b))
      .map((tag) =>  ({ tag, count: counts[tag] }));
  }

  // ---- Mobile list rendering ----

  function renderMobile(innerContainer) {
    teardownMemoryPageRuntime();
    const epochSnap = ++memoryPageEpoch;
    containerEl = innerContainer;
    innerContainer.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'memory-root memory-root-mobile';
    const listEl = document.createElement('div');
    listEl.className = 'memory-mobile-list';
    listEl.innerHTML = '<div class="memory-loading">载入中…</div>';
    root.appendChild(listEl);
    innerContainer.appendChild(root);
    listFetchAbort = new AbortController();
    fetch('/api/memory/files', { signal: listFetchAbort.signal })
      .then((res) =>  res.json())
      .then((data) => {
        if (epochSnap !== memoryPageEpoch) return;
        if (!data.success || !data.files || !data.files.length) {
          listEl.innerHTML = '<div class="memory-empty">暂无记忆文件。</div>';
          return;
        }
        allFiles = data.files;
        renderMobileList(listEl, data.files);
      })
      .catch((err) => {
        if (epochSnap !== memoryPageEpoch) return;
        if (err && err.name === 'AbortError') return;
        listEl.innerHTML = '<div class="memory-empty" style="color:var(--danger)">载入失败。</div>';
      });
  }

  function renderMobileList(listEl, files) {
    listEl.innerHTML = '';
    for (let i = 0; i < files.length; i++) {
      ((file) => {
        const card = document.createElement('div');
        card.className = 'memory-mobile-card';
        card.setAttribute('data-filename', file.filename);
        let tagsHtml = '';
        if (file.tags && file.tags.length) {
          tagsHtml = '<div class="memory-mobile-card-tags">';
          file.tags.forEach((t) => {
            tagsHtml += `<span class="memory-tag-pill">${escapeHtml(t)}</span>`;
          });
          tagsHtml += '</div>';
        }
        card.innerHTML =
          `<div class="memory-mobile-card-head"><span class="memory-mobile-card-name">${escapeHtml(file.name || file.filename)}</span></div><p class="memory-mobile-card-desc">${escapeHtml(file.description || '（无描述）')}</p>${tagsHtml}<div class="memory-mobile-card-meta">更新于 ${escapeHtml(formatZhMemoryIso(file.modifiedAt))}</div><div class="memory-mobile-card-actions"><button type="button" class="skills-btn skills-btn-danger" data-action="delete">删除记忆</button></div>`;
        card.addEventListener('click', (e) => {
          if (e.target.closest('.skills-btn')) return;
          toggleMemoryExpand(card, file);
        });
        const delBtn = card.querySelector('[data-action="delete"]');
        if (delBtn) delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteMemoryItem(file, card);
        });
        listEl.appendChild(card);
      })(files[i]);
    }
  }

  function toggleMemoryExpand(card, file) {
    const wasExpanded = card.classList.contains('is-expanded');
    const expanded = containerEl.querySelectorAll('.memory-mobile-card.is-expanded');
    for (let i = 0; i < expanded.length; i++) {
      expanded[i].classList.remove('is-expanded');
      const old = expanded[i].querySelector('.memory-mobile-card-detail');
      if (old) old.remove();
    }
    if (wasExpanded) return;
    card.classList.add('is-expanded');
    const detailDiv = document.createElement('div');
    detailDiv.className = 'memory-mobile-card-detail';
    detailDiv.innerHTML = '<div class="skills-detail-loading">载入中…</div>';
    card.appendChild(detailDiv);
    fetch(`/api/memory/files/${encodeURIComponent(file.filename)}`)
      .then((res) =>  res.json())
      .then((data) => {
        if (!data.success) throw new Error(data.error || '加载失败');
        detailDiv.innerHTML = `<pre class="memory-mobile-card-content">${escapeHtml(data.content || '')}</pre>`;
      })
      .catch((err) => {
        detailDiv.innerHTML = `<div class="skills-detail-error">加载失败：${escapeHtml(err.message || '未知错误')}</div>`;
      });
  }

  function confirmDeleteMemory(name) {
    return window.Modal.confirm({
      title: '删除记忆',
      message: `确定删除记忆「${name}」？删除后不可恢复。`,
      type: 'danger',
      confirmText: '删除',
      cancelText: '取消',
      dangerConfirm: true,
    });
  }

  function deleteMemoryItem(file, card) {
    const name = file.name || file.filename;
    const doDelete = function () {
      fetch(`/api/memory/files/${encodeURIComponent(file.filename)}`, { method: 'DELETE' })
        .then((r) =>  r.json())
        .then((data) => {
          if (!data.success) { Notification.error(data.error || '删除失败'); return; }
          card.remove();
        })
        .catch(() => { Notification.error('删除请求失败'); });
    };
    confirmDeleteMemory(name).then((ok) => { if (ok) doDelete(); });
  }

  function render(innerContainer) {
    if (isMobile()) {
      renderMobile(innerContainer);
      return;
    }
    teardownMemoryPageRuntime();
    const epochSnap = ++memoryPageEpoch;

    containerEl = innerContainer;
    innerContainer.innerHTML = '';
    filterTag = null;
    tagSidebarAsideEl = null;
    svgEl = null;
    nodeLayouts = [];
    nodesLayerEl = null;

    /** @type {HTMLElement} */
    const root = /** @type {HTMLElement} */ (document.createElement('div'));
    root.className = 'memory-root';

    const header = document.createElement('header');
    header.className = 'memory-header';
    header.innerHTML =
      '<div class="memory-header-text">' +
      '<h1 class="memory-title">记忆图谱</h1>' +
      '<p class="memory-sidebar-hint">' +
      '圆点表示一条记忆，<strong>共用标签</strong>的会用线连起来。左侧可点标签筛选画布；滚轮缩放、拖动画布平移；点圆打开详情，双击空白取消筛选。' +
      '</p>' +
      '</div>' +
      '<div class="memory-header-actions">' +
      '<span class="memory-count" id="memory-total-count" aria-live="polite">载入中…</span>' +
      '<span class="memory-health-capsule" id="memory-health-capsule" aria-live="polite">' +
      '<span class="memory-health-dot"></span>' +
      '<span class="memory-health-text">检查中…</span>' +
      '</span>' +
      '<button type="button" class="memory-export-btn" id="memory-export-btn" title="打包下载全部记忆 Markdown">导出记忆</button>' +
      '<button type="button" class="memory-consolidate-btn" id="memory-consolidate-btn">手动整合</button>' +
      '</div>';

    const exportBtn = header.querySelector('#memory-export-btn');
    const consolidateBtn = header.querySelector('#memory-consolidate-btn');

    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        if (!containerEl || exportBtn.disabled) return;
        const btn = /** @type {HTMLButtonElement} */ (exportBtn);
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = '导出中…';

        fetch('/api/memory/stats')
          .then((res) => {
            return res.json().then((body) =>  ({ ok: res.ok, body }));
          })
          .then((out) => {
            if (!out.ok || !out.body.success) {
              throw new Error((out.body && out.body.error) || '统计失败');
            }
            if (!out.body.total) {
              Notification.warning('没有可导出的记忆文件。');
              return null;
            }
            return fetch('/api/memory/export');
          })
          .then((res) => {
            if (!res) return;
            if (!res.ok) {
              return res.json().then((body) => {
                throw new Error((body && body.error) || '导出失败');
              });
            }
            const countHdr = res.headers.get('X-Memory-File-Count');
            const date = new Date().toISOString().split('T')[0];
            const filename = `icecoder-memory-${date}.zip`;
            return res.blob().then((blob) => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = filename;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
              const n = countHdr ? parseInt(countHdr, 10) : NaN;
              if (!isNaN(n) && n > 0) {
                Notification.success(`记忆已导出，共 ${n} 个文件。ZIP 内包含 memory-files/ 与 user-memory/ 目录。`);
              }
            });
          })
          .catch((err) => {
            Notification.error('记忆导出失败：' + ((err && err.message) || '未知错误'));
          })
          .finally(() => {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = '导出记忆';
          });
      });
    }

    function startDreamPoll() {
      stopDreamPoll();
      dreamPollTimer = setInterval(() => {
        fetchHealthCapsule((data) => {
          if (!data || !data.job || !data.job.running) {
            stopDreamPoll();
            if (containerEl) render(containerEl);
          }
        });
      }, 5000);
    }

    if (consolidateBtn) {
      consolidateBtn.addEventListener('click', () => {
        if (!containerEl || consolidateBtn.disabled) return;
        const btn = /** @type {HTMLButtonElement} */ (consolidateBtn);
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = '提交中...';

        fetch('/api/memory/dream', { method: 'POST' })
          .then((res) => {
            return res.json().then((body) =>  ({ ok: res.ok, status: res.status, body }));
          })
          .then((out) => {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = '手动整合';

            if (!out.ok || !out.body.success) {
              const errMsg = (out.body && out.body.error) || '操作失败';
              Notification.error(errMsg);
              return;
            }
            const summary = out.body.summary || '操作完成';
            const detail =
              '修改 ' + (out.body.filesModified || 0) +
              ' · 删除 ' + (out.body.filesDeleted || 0) +
              (out.body.ruleFixed ? ' · 索引修复 ' + (out.body.ruleEntryCount || 0) + ' 条' : '') +
              (out.body.filesEvicted ? ` · 归档 ${out.body.filesEvicted}` : '');
            Notification.success(summary + (detail.trim() ? `
${detail}` : ''));

            if (out.body.background) {
              fetchHealthCapsule();
              startDreamPoll();
            } else if (containerEl) {
              render(containerEl);
            }
          })
          .catch(() => {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = '手动整合';
            Notification.error('请求失败，请稍后重试。');
          });
      });
    }

    /** 2.5: 拉取索引健康报告并更新胶囊 */
    const healthCapsuleEl = /** @type {HTMLElement | null} */ (
      header.querySelector('#memory-health-capsule')
    );

    function fetchHealthCapsule(done) {
      if (!healthCapsuleEl) return;
      fetch('/api/memory/dream', { method: 'GET' })
        .then((res) =>  res.json())
        .then((data) => {
          if (typeof done === 'function') done(data);

          if (!data.success || !data.health) {
            healthCapsuleEl.setAttribute('data-status', 'warn');
            const textEl = healthCapsuleEl.querySelector('.memory-health-text');
            if (textEl) textEl.textContent = '无法获取';
            return;
          }

          if (data.job && data.job.running) {
            healthCapsuleEl.setAttribute('data-status', 'warn');
            const busyEl = healthCapsuleEl.querySelector('.memory-health-text');
            if (busyEl) busyEl.textContent = '后台整合中…';
            if (consolidateBtn) {
              consolidateBtn.textContent = '后台整合中…';
              consolidateBtn.setAttribute('aria-busy', 'true');
            }
            return;
          }

          if (consolidateBtn) {
            consolidateBtn.textContent = '手动整合';
            consolidateBtn.removeAttribute('aria-busy');
          }

          const h = data.health;
          let status = 'ok';
          let label = '';
          if (h.dead > 3 || h.orphans > 10) {
            status = 'bad';
            label = `死链 ${h.dead} · 孤儿 ${h.orphans}`;
          } else if (h.dead > 0 || h.orphans > 5) {
            status = 'warn';
            label = `死链 ${h.dead} · 孤儿 ${h.orphans}`;
          } else {
            label = `健康 (${h.indexed} 条索引, ${h.onDisk} 磁盘)`;
          }
          healthCapsuleEl.setAttribute('data-status', status);
          const textEl = healthCapsuleEl.querySelector('.memory-health-text');
          if (textEl) textEl.textContent = label;

        })
        .catch(() => {
          if (healthCapsuleEl) {
            healthCapsuleEl.setAttribute('data-status', 'warn');
            const textEl = healthCapsuleEl.querySelector('.memory-health-text');
            if (textEl) textEl.textContent = '离线';
          }
        });
    }

    // 初始拉取
    fetchHealthCapsule();

    const main = document.createElement('main');
    main.className = 'memory-main';

    const graphArea = document.createElement('section');
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
      .then((res) =>  res.json())
      .then((data) => {
        if (epochSnap !== memoryPageEpoch) return;

        const busyEl = graphArea.querySelector('.memory-page-busy');
        const loadingEl = graphArea.querySelector('.memory-loading');
        const scrollWrap = graphArea.querySelector('.memory-graph-scroll');
        const innerGraph = graphArea.querySelector('.memory-graph-inner');

        const countEl = header.querySelector('#memory-total-count');
        if (countEl) {
          const totalN = typeof data.total === 'number' ? data.total : (data.files ? data.files.length : 0);
          countEl.textContent = `共 ${totalN} 条记忆`;
        }

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
        const tagList = renderSidebarTags(data.files);

        const aside = buildTagSidebar(tagList);
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
      .catch((err) => {
        if (epochSnap !== memoryPageEpoch) return;
        if (err && /** @type {Error} */ (err).name === 'AbortError') return;
        cancelFinishBusyRafs();
        const busyEl = graphArea.querySelector('.memory-page-busy');
        const loadingEl = graphArea.querySelector('.memory-loading');
        if (busyEl) dismissBusyOverlayNow(busyEl, epochSnap);
        if (
          epochSnap !== memoryPageEpoch ||
          !loadingEl
        )
          return;
        loadingEl.classList.remove('hidden');
        const countElErr = header.querySelector('#memory-total-count');
        if (countElErr) countElErr.textContent = '—';
        loadingEl.innerHTML =
          '<span style="color:var(--danger)">载入失败。</span>';
      });
  }

  return { render, destroy };
})();

if (typeof window !== 'undefined') {
  window.MemoryPage = MemoryPage;
}
