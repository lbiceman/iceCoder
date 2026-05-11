/**
 * 1-bit 像素狗：逻辑 128×128，逻辑画布 512×512（CELL=4）。
 * 格缝与绘制逻辑昼夜相同；仅墨色由 --pet-pixel / data-theme 决定。
 */
(function () {
  'use strict';

  var GRID_W = 128;
  var GRID_H = 128;
  var CELL = 4;
  /** 格间留白（逻辑像素） */
  var CELL_PAD = 0.3;

  /** 栅格化时超采样倍数（内部 256→输出 128） */
  var RASTER_SUPERSAMPLE = 2;
  var RASTER_THRESHOLD = 146;

  /** 参考图（JPEG/PNG）；失败时用下方 32×32 ASCII 放大占位 */
  var PET_IMG_SRC = '/img/session-pet-lab.jpg';

  /** 气泡只做一行摘要：超出截断（与 CSS ellipsis 配合） */
  var PET_BUBBLE_MAX_CHARS = 42;

  function getPetInkColor() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--pet-pixel').trim();
      if (v) return v;
    } catch (_e) {}
    return document.documentElement.getAttribute('data-theme') === 'light' ? '#0a0a0c' : '#e8e8f2';
  }

  function clampBubbleLine(text) {
    if (text === undefined || text === null) return '';
    var s = String(text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    var line = s.split(/\r\n|\n|\r/)[0].trim();
    if (line.length > PET_BUBBLE_MAX_CHARS) {
      line = line.slice(0, PET_BUBBLE_MAX_CHARS - 1) + '…';
    }
    return line;
  }

  /**
   * 32×32 占位拉布拉多（仅图加载失败时用）；在 GRID 上按倍率铺满
   */
  var DOG_ASCII_32 = [
    '................................',
    '..........##########............',
    '........##############..........',
    '.......################.........',
    '......###..............###......',
    '.....##................##.......',
    '....##....########......##......',
    '....#...############.....#......',
    '...#...#............#.....#.....',
    '...#....##.........##....#......',
    '...#....##.........##....#......',
    '..#...###........###......#.....',
    '..#....############......#......',
    '..#.....##########.......#......',
    '..##......########........##....',
    '...#.......######.........#.....',
    '...#........####..........#.....',
    '...##....................##.....',
    '....###................###......',
    '.....#####################......',
    '....#######################.....',
    '...#########################....',
    '..#######............#######....',
    '.######.................######..',
    '.###..##..............##..###...',
    '.##...##..............##...##...',
    '.##...##..............##...##...',
    '.###.###..............###.###...',
    '.#...#................#...#.....',
    '................................',
    '................................',
    '................................'
  ];

  function upscale32LinesToGrid(lines) {
    var g = [];
    var f = GRID_W / 32;
    if (f !== (f | 0)) return g;
    f = f | 0;
    for (var r = 0; r < GRID_H; r++) {
      var row = [];
      var r32 = (r / f) | 0;
      var line = lines[r32] || '';
      if (line.length > 32) line = line.substring(0, 32);
      while (line.length < 32) line += ' ';
      for (var c = 0; c < GRID_W; c++) {
        var c32 = (c / f) | 0;
        var ch = line.charAt(c32);
        row.push(ch === '#' || ch === 'O' || ch === '1' ? 1 : 0);
      }
      g.push(row);
    }
    return g;
  }

  /** 将 32×32 设计坐标 patches 铺到当前 GRID（GRID 须为 32 的整数倍） */
  function expandPatchesFrom32(patches) {
    if (!patches || !patches.length) return [];
    var f = GRID_W / 32;
    if (f !== (f | 0) || f < 1) return [];
    f = f | 0;
    var out = [];
    var i;
    var p;
    var r0;
    var c0;
    var v;
    var dr;
    var dc;
    for (i = 0; i < patches.length; i++) {
      p = patches[i];
      r0 = p[0] * f;
      c0 = p[1] * f;
      v = p[2];
      for (dr = 0; dr < f; dr++) {
        for (dc = 0; dc < f; dc++) {
          out.push([r0 + dr, c0 + dc, v]);
        }
      }
    }
    return out;
  }

  function buildBuiltinFrom32Design(states32) {
    var o = {};
    for (var k in states32) {
      if (states32.hasOwnProperty(k)) {
        o[k] = { patches: expandPatchesFrom32(states32[k].patches) };
      }
    }
    return o;
  }

  var BASE_GRID = upscale32LinesToGrid(DOG_ASCII_32);

  /** 表情定义在 32×32 设计网格，运行时展开为 GRID 尺寸；也可在 JSON 中写展开后坐标（128×128） */
  var BUILTIN_STATES_32 = {
    idle: { patches: [] },
    idle_blink: {
      patches: [
        [9, 8, 0],
        [9, 9, 0],
        [9, 19, 0],
        [9, 20, 0],
        [10, 8, 0],
        [10, 9, 0],
        [10, 19, 0],
        [10, 20, 0],
        [10, 8, 1],
        [10, 9, 1],
        [10, 19, 1],
        [10, 20, 1]
      ]
    },
    thinking: {
      patches: [
        [10, 8, 0],
        [10, 9, 0],
        [10, 19, 0],
        [10, 20, 0],
        [8, 8, 1],
        [8, 9, 1],
        [9, 8, 1],
        [9, 9, 1],
        [8, 19, 1],
        [8, 20, 1],
        [9, 19, 1],
        [9, 20, 1]
      ]
    },
    working: { patches: [] },
    happy: {
      patches: [
        [9, 8, 0],
        [9, 9, 0],
        [9, 19, 0],
        [9, 20, 0],
        [10, 8, 1],
        [10, 9, 1],
        [10, 19, 1],
        [10, 20, 1],
        [16, 12, 1],
        [16, 19, 1],
        [17, 13, 1],
        [17, 14, 1],
        [17, 15, 1],
        [17, 16, 1],
        [17, 17, 1],
        [17, 18, 1]
      ]
    },
    confused: {
      patches: [
        [9, 8, 0],
        [9, 9, 0],
        [10, 8, 0],
        [10, 9, 0],
        [9, 10, 1],
        [10, 7, 1],
        [10, 10, 1],
        [9, 18, 1],
        [9, 20, 1],
        [10, 19, 0],
        [11, 18, 1],
        [11, 20, 1],
        [12, 19, 1]
      ]
    },
    alert: {
      patches: [
        [9, 7, 1],
        [9, 10, 1],
        [10, 7, 1],
        [10, 10, 1],
        [9, 17, 1],
        [9, 20, 1],
        [10, 17, 1],
        [10, 20, 1],
        [8, 8, 1],
        [8, 9, 1],
        [8, 19, 1],
        [8, 20, 1],
        [11, 8, 1],
        [11, 9, 1],
        [11, 19, 1],
        [11, 20, 1]
      ]
    }
  };

  var builtinPatches64 = buildBuiltinFrom32Design(BUILTIN_STATES_32);
  var jsonExtraPatches = {};

  function cloneGrid(src) {
    return src.map(function (row) {
      return row.slice();
    });
  }

  function applyPatches(g, patches) {
    if (!patches || !patches.length) return;
    for (var i = 0; i < patches.length; i++) {
      var p = patches[i];
      var r = p[0];
      var c = p[1];
      var v = p[2];
      if (r >= 0 && r < GRID_H && c >= 0 && c < GRID_W) {
        g[r][c] = v ? 1 : 0;
      }
    }
  }

  function mergedPatchesForState(name) {
    var builtin = (builtinPatches64[name] && builtinPatches64[name].patches) || [];
    var extra = (jsonExtraPatches[name] && jsonExtraPatches[name].patches) || [];
    return builtin.concat(extra);
  }

  function loadExpressionsFromJson(cb) {
    fetch('/session-pet-expressions.json?_=' + Date.now())
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error('no json'));
      })
      .then(function (data) {
        jsonExtraPatches = {};
        if (data && data.states && typeof data.states === 'object') {
          jsonExtraPatches = data.states;
        }
        cb();
      })
      .catch(function () {
        jsonExtraPatches = {};
        cb();
      });
  }

  var DRAG_STORE_KEY = 'ice-session-pet-position';
  var DRAG_MARGIN = 8;

  /**
   * 拖动指示器：按住宠物画布拖动；双击复位。夹紧在顶栏之下、输入区之上、可视视口内（含 visualViewport / 软键盘）。
   */
  function initPetDrag(rootEl, dragHandleEl) {
    if (!rootEl || !dragHandleEl) return { afterShow: function () {} };

    var dragPointerId = null;
    var startClientX = 0;
    var startClientY = 0;
    var startLeft = 0;
    var startTop = 0;
    var savedPosLoaded = false;

    function visualViewportBottom() {
      var vv = window.visualViewport;
      if (vv) return vv.offsetTop + vv.height;
      return window.innerHeight;
    }

    function getBounds() {
      var rect = rootEl.getBoundingClientRect();
      var w = rect.width > 2 ? rect.width : rootEl.offsetWidth || 160;
      var h = rect.height > 2 ? rect.height : rootEl.offsetHeight || 200;
      var nav = document.getElementById('top-nav');
      var topNavBottom = nav ? nav.getBoundingClientRect().bottom : 0;
      var minT = Math.max(DRAG_MARGIN, topNavBottom + DRAG_MARGIN);
      var inputArea = document.querySelector('.chat-input-area');
      var bottomLimit = visualViewportBottom() - DRAG_MARGIN;
      if (inputArea && rootEl.closest('.chat-page')) {
        var inputTop = inputArea.getBoundingClientRect().top;
        if (inputTop > minT + 40) {
          bottomLimit = Math.min(bottomLimit, inputTop - DRAG_MARGIN);
        }
      }
      var maxT = bottomLimit - h;
      var maxL = window.innerWidth - w - DRAG_MARGIN;
      var minL = DRAG_MARGIN;
      if (maxT < minT) maxT = minT;
      if (maxL < minL) maxL = minL;
      return { minL: minL, maxL: maxL, minT: minT, maxT: maxT };
    }

    function applyPosition(left, top) {
      var b = getBounds();
      left = Math.min(Math.max(left, b.minL), b.maxL);
      top = Math.min(Math.max(top, b.minT), b.maxT);
      rootEl.style.left = left + 'px';
      rootEl.style.top = top + 'px';
      rootEl.style.right = 'auto';
      rootEl.style.bottom = 'auto';
      rootEl.style.transform = 'none';
      rootEl.classList.add('session-pet-indicator--placed');
      try {
        localStorage.setItem(DRAG_STORE_KEY, JSON.stringify({ left: left, top: top }));
      } catch (_e) { /* ignore */ }
    }

    function clampToBounds() {
      if (!rootEl.classList.contains('session-pet-indicator--placed')) return;
      var rect = rootEl.getBoundingClientRect();
      if (rect.width < 2 && rootEl.offsetWidth < 2) return;
      applyPosition(rect.left, rect.top);
    }

    function clearCustomPosition() {
      rootEl.classList.remove('session-pet-indicator--placed');
      rootEl.style.left = '';
      rootEl.style.top = '';
      rootEl.style.right = '';
      rootEl.style.bottom = '';
      rootEl.style.transform = '';
      try {
        localStorage.removeItem(DRAG_STORE_KEY);
      } catch (_e) { /* ignore */ }
    }

    function loadSavedPosition() {
      try {
        var raw = localStorage.getItem(DRAG_STORE_KEY);
        if (!raw) return;
        var o = JSON.parse(raw);
        if (typeof o.left !== 'number' || typeof o.top !== 'number' || !isFinite(o.left) || !isFinite(o.top)) return;
        applyPosition(o.left, o.top);
      } catch (_e) { /* ignore */ }
    }

    function onPointerMove(e) {
      if (dragPointerId === null || e.pointerId !== dragPointerId) return;
      e.preventDefault();
      var dx = e.clientX - startClientX;
      var dy = e.clientY - startClientY;
      applyPosition(startLeft + dx, startTop + dy);
    }

    function endDrag(e) {
      if (dragPointerId === null) return;
      if (e && e.pointerId !== dragPointerId) return;
      dragPointerId = null;
      dragHandleEl.classList.remove('pet-dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      clampToBounds();
    }

    dragHandleEl.addEventListener('dblclick', function (e) {
      e.preventDefault();
      e.stopPropagation();
      clearCustomPosition();
    });

    dragHandleEl.addEventListener(
      'pointerdown',
      function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        dragPointerId = e.pointerId;
        startClientX = e.clientX;
        startClientY = e.clientY;
        var rect = rootEl.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        applyPosition(startLeft, startTop);
        dragHandleEl.classList.add('pet-dragging');
        window.addEventListener('pointermove', onPointerMove, { passive: false });
        window.addEventListener('pointerup', endDrag);
        window.addEventListener('pointercancel', endDrag);
        e.preventDefault();
      },
      { passive: false },
    );

    function onResizeClamp() {
      clampToBounds();
    }
    window.addEventListener('resize', onResizeClamp);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResizeClamp);
      window.visualViewport.addEventListener('scroll', onResizeClamp);
    }

    return {
      afterShow: function () {
        if (!savedPosLoaded) {
          savedPosLoaded = true;
          loadSavedPosition();
        }
        requestAnimationFrame(function () {
          clampToBounds();
        });
      },
    };
  }

  /**
   * @param {HTMLElement} rootEl
   */
  function create(rootEl) {
    var canvas = rootEl.querySelector('.pet-canvas');
    var bubbleEl = rootEl.querySelector('.pet-bubble');
    var turnEl = rootEl.querySelector('.status-turn');
    var dragApi = initPetDrag(rootEl, canvas);
    var ctx = null;
    var cw = GRID_W * CELL;
    var ch = GRID_H * CELL;
    var state = 'idle';
    var visible = true;
    var blinkTimer = null;
    var blinkUntil = 0;

    function setupCanvas() {
      if (!canvas) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      ctx = canvas.getContext('2d', { alpha: true });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingEnabled = false;
      draw();
    }

    function drawLcd() {
      if (!ctx) return;
      var r;
      var c;
      var g = cloneGrid(BASE_GRID);
      var exprName = state;
      if ((state === 'idle' || state === 'thinking' || state === 'working') && Date.now() < blinkUntil) {
        exprName = 'idle_blink';
      }
      applyPatches(g, mergedPatchesForState(exprName));

      var ink = getPetInkColor();
      var pad = CELL_PAD;
      var sz = CELL - pad * 2;
      for (r = 0; r < GRID_H; r++) {
        for (c = 0; c < GRID_W; c++) {
          if (g[r][c]) {
            ctx.fillStyle = ink;
            ctx.fillRect(c * CELL + pad, r * CELL + pad, sz, sz);
          }
        }
      }
    }

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, cw, ch);
      drawLcd();
    }

    if (typeof MutationObserver !== 'undefined') {
      var themeObs = new MutationObserver(function () {
        draw();
      });
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    var resizeDprTimer = null;
    function onResizeDpr() {
      if (resizeDprTimer) clearTimeout(resizeDprTimer);
      resizeDprTimer = setTimeout(function () {
        setupCanvas();
      }, 200);
    }
    window.addEventListener('resize', onResizeDpr);

    function scheduleBlink() {
      if (blinkTimer) clearInterval(blinkTimer);
      blinkTimer = null;
      blinkTimer = setInterval(function () {
        if (state !== 'idle' && state !== 'thinking' && state !== 'working') return;
        blinkUntil = Date.now() + 200;
        draw();
        setTimeout(draw, 220);
      }, 2800 + Math.random() * 900);
    }

    function setVisible(v) {
      visible = v !== false;
      rootEl.classList.add('active');
      if (dragApi && dragApi.afterShow) dragApi.afterShow();
      scheduleBlink();
    }

    function setState(s) {
      state = s || 'idle';
      if (canvas) canvas.classList.toggle('pet-wobble', state === 'working');
      draw();
    }

    function setBubbleText(text) {
      if (!bubbleEl) return;
      var t = clampBubbleLine(text);
      if (!t) {
        bubbleEl.textContent = '';
        bubbleEl.classList.remove('has-text');
        return;
      }
      bubbleEl.classList.add('has-text');
      bubbleEl.textContent = t;
    }

    function setTurnLabel(text) {
      if (turnEl) turnEl.textContent = text || '';
    }

    function rasterFromSupersampledCanvas(octx, internalSide) {
      var id = octx.getImageData(0, 0, internalSide, internalSide);
      var d = id.data;
      var ss = RASTER_SUPERSAMPLE;
      var expected = GRID_W * ss;
      if (internalSide !== expected || GRID_W !== GRID_H) {
        return;
      }
      var g = [];
      var r;
      var c;
      var dr;
      var dc;
      var sum;
      var rr;
      var cc;
      var idx;
      var lum;
      for (r = 0; r < GRID_H; r++) {
        var row = [];
        for (c = 0; c < GRID_W; c++) {
          sum = 0;
          for (dr = 0; dr < ss; dr++) {
            for (dc = 0; dc < ss; dc++) {
              rr = r * ss + dr;
              cc = c * ss + dc;
              idx = (rr * internalSide + cc) << 2;
              lum = (d[idx] + d[idx + 1] + d[idx + 2]) / 3;
              sum += lum;
            }
          }
          row.push(sum / (ss * ss) < RASTER_THRESHOLD ? 1 : 0);
        }
        g.push(row);
      }
      BASE_GRID = g;
    }

    function tryHydrateFromImage(cb) {
      var img = new Image();
      img.onload = function () {
        if (typeof createImageBitmap === 'function') {
          createImageBitmap(img, {
            resizeWidth: GRID_W * RASTER_SUPERSAMPLE,
            resizeHeight: GRID_H * RASTER_SUPERSAMPLE,
            resizeQuality: 'pixelated',
          })
            .then(function (bmp) {
              var oc = document.createElement('canvas');
              var hi = GRID_W * RASTER_SUPERSAMPLE;
              oc.width = hi;
              oc.height = hi;
              var octx = oc.getContext('2d');
              octx.drawImage(bmp, 0, 0);
              rasterFromSupersampledCanvas(octx, hi);
              try {
                bmp.close();
              } catch (_eClose) {}
              cb();
            })
            .catch(function () {
              var oc2 = document.createElement('canvas');
              var hi2 = GRID_W * RASTER_SUPERSAMPLE;
              oc2.width = hi2;
              oc2.height = hi2;
              var octx2 = oc2.getContext('2d');
              octx2.imageSmoothingEnabled = false;
              octx2.drawImage(img, 0, 0, hi2, hi2);
              rasterFromSupersampledCanvas(octx2, hi2);
              cb();
            });
        } else {
          var oc3 = document.createElement('canvas');
          var hi3 = GRID_W * RASTER_SUPERSAMPLE;
          oc3.width = hi3;
          oc3.height = hi3;
          var octx3 = oc3.getContext('2d');
          octx3.imageSmoothingEnabled = false;
          octx3.drawImage(img, 0, 0, hi3, hi3);
          rasterFromSupersampledCanvas(octx3, hi3);
          cb();
        }
      };
      img.onerror = function () {
        cb();
      };
      img.src = PET_IMG_SRC + '?_=' + Date.now();
    }

    tryHydrateFromImage(function () {
      loadExpressionsFromJson(function () {
        setupCanvas();
        rootEl.classList.add('active');
        if (dragApi && dragApi.afterShow) dragApi.afterShow();
        scheduleBlink();
      });
    });

    return {
      setVisible: setVisible,
      setState: setState,
      setBubbleText: setBubbleText,
      setTurnLabel: setTurnLabel,
      redraw: draw,
      isVisible: function () {
        return visible;
      }
    };
  }

  window.SessionPet = {
    create: create,
    /** 运行时替换整只宠物的格点（二维 0/1 数组，尺寸须为 GRID_W × GRID_H） */
    setBaseGrid: function (grid) {
      if (!grid || grid.length !== GRID_H) return;
      var ri;
      for (ri = 0; ri < grid.length; ri++) {
        if (!grid[ri] || grid[ri].length !== GRID_W) return;
      }
      BASE_GRID = grid.map(function (row) {
        return row.slice();
      });
    },
    gridSize: function () {
      return { w: GRID_W, h: GRID_H };
    }
  };
})();
