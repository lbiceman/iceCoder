/**
 * 冰豆（Ice Bean）— iceCoder Web 会话状态指示器
 * 极简风格：固定黑底 + 胶囊眼睛；眼睛色对应当前 supervisorMode（见 session-pet-palette）。
 * 不区分昼夜模式，始终黑底白字。
 * 眨眼：1-3 秒随机间隔，闭眼 150ms。
 *
 * 表情系统：harness 候选表情（+ 内部 blink 眨眼帧），按业务切换。
 * 外圈圆环：自顶端顺时针表示上下文 token 占用率。
 */
import {
  SESSION_PET_PALETTE_COLORS as COLORS,
  supervisorModeToEyeColor,
  buildSessionPetCanvasAriaLabel,
  SESSION_PET_DISPLAY_NAME,
} from './session-pet-palette.js';
import {
  HARNESS_PET_EXPRESSIONS,
  HARNESS_PET_SKIP_BLINK,
  HARNESS_PET_SKIP_BREATH,
  IDLE_POSES,
  idlePoseHoldMs,
} from './session-pet-harness-expr.js';

window.IceSupervisorModeEyeColor = supervisorModeToEyeColor;

(function () {
  'use strict';

  /** 逻辑画布边长（与 CSS .pet-canvas、HTML canvas width/height 一致） */
  var PET_SIZE = 96;
  /** 版面比例：相对最初 120×120 设计稿 */
  var PET_SCALE = PET_SIZE / 120;
  var EYE_W = Math.round(14 * PET_SCALE);

  var BLINK_MIN = 1000;
  var BLINK_MAX = 3000;
  var BLINK_DURATION = 150;

  var PET_BUBBLE_MAX_CHARS = 42;

  // 固定颜色：黑底；眼睛线色见 create() 闭包内 eyeColor（每实例独立）
  var BODY_BG = '#000000';
  /** token 圆环线宽（逻辑像素） */
  var TOKEN_RING_LINE_WIDTH = 3.25 * PET_SCALE;
  /** 圆环内侧与机身外缘的间距（逻辑像素） */
  var TOKEN_RING_BODY_GAP = 3;
  /** 机身圆半径（与下方 fill 用的半径一致） */
  var BODY_RADIUS = PET_SIZE / 2 - 8;
  /** 圆环中心半径：机身外缘 + 间距 + 描边半宽（描边以该半径为中心） */
  var TOKEN_RING_RADIUS = BODY_RADIUS + TOKEN_RING_BODY_GAP + TOKEN_RING_LINE_WIDTH / 2;

  var TOKEN_RING_GREEN = '#1ECFB4';
  var TOKEN_RING_YELLOW = '#DBF02C';
  var TOKEN_RING_RED = '#FC5A76';

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function lerpByte(a, b, t) {
    return Math.round(a + (b - a) * t);
  }

  function rgbToHex(rgb) {
    function byteToHex(x) {
      var s = Math.max(0, Math.min(255, x)).toString(16);
      return s.length === 1 ? '0' + s : s;
    }
    return '#' + byteToHex(rgb.r) + byteToHex(rgb.g) + byteToHex(rgb.b);
  }

  var _ringRgbGreen = hexToRgb(TOKEN_RING_GREEN);
  var _ringRgbYellow = hexToRgb(TOKEN_RING_YELLOW);
  var _ringRgbRed = hexToRgb(TOKEN_RING_RED);

  function tokenRingProgressColor(pct) {
    var p = Math.max(0, Math.min(100, Number(pct) || 0));
    var g = _ringRgbGreen;
    var y = _ringRgbYellow;
    var r = _ringRgbRed;
    if (p <= 50) {
      var t = p / 50;
      return rgbToHex({
        r: lerpByte(g.r, y.r, t),
        g: lerpByte(g.g, y.g, t),
        b: lerpByte(g.b, y.b, t),
      });
    }
    var t2 = (p - 50) / 50;
    return rgbToHex({
      r: lerpByte(y.r, r.r, t2),
      g: lerpByte(y.g, r.g, t2),
      b: lerpByte(y.b, r.b, t2),
    });
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

  var DRAG_STORE_KEY = 'ice-session-pet-position';
  var DRAG_MARGIN = 8;
  var DRAG_THRESHOLD = 5;

  function initPetDrag(rootEl, dragHandleEl) {
    if (!rootEl || !dragHandleEl) return { afterShow: function () { } };

    var dragPointerId = null;
    var dragActive = false;
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
      var w = rect.width > 2 ? rect.width : rootEl.offsetWidth || 136;
      var h = rect.height > 2 ? rect.height : rootEl.offsetHeight || 168;
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
      var dx = e.clientX - startClientX;
      var dy = e.clientY - startClientY;
      if (!dragActive) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragActive = true;
        dragHandleEl.classList.add('pet-dragging');
        applyPosition(startLeft, startTop);
      }
      e.preventDefault();
      applyPosition(startLeft + dx, startTop + dy);
    }

    function endDrag(e) {
      if (dragPointerId === null) return;
      if (e && e.pointerId !== dragPointerId) return;
      dragPointerId = null;
      dragActive = false;
      dragHandleEl.classList.remove('pet-dragging');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      clampToBounds();
    }

    dragHandleEl.addEventListener(
      'pointerdown',
      function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        dragPointerId = e.pointerId;
        dragActive = false;
        startClientX = e.clientX;
        startClientY = e.clientY;
        var rect = rootEl.getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
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
    document.addEventListener('ice:composer-layout', onResizeClamp);

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

  // ============ 表情绘制（仅 harness 候选 + 内部 blink） ============

  function drawBlinkLine(ctx, cx, cy, w, color) {
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy);
    ctx.lineTo(cx + w / 2, cy);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function expressionBlink(ctx, leftX, rightX, y, ec) {
    drawBlinkLine(ctx, leftX, y, EYE_W, ec);
    drawBlinkLine(ctx, rightX, y, EYE_W, ec);
  }

  var LEGACY_PET_STATE = {
    success: 'clap',
    happy: 'clap',
    thinking: 'running',
    working: 'tool_calling',
    confused: 'error',
    alert: 'error',
    anxious: 'recovering',
    rest: 'idle',
    surprised: 'planning',
    sad: 'cancelling',
    crying: 'user_checkpoint',
    angry: 'error',
    curious: 'planning',
    dizzy: 'recovering',
    shy: 'tool_confirm',
    love: 'memory',
    weary: 'error',
    focused: 'running',
    read: 'streaming',
    determined: 'tool_calling',
    playful: 'idle',
    wave: 'idle',
  };

  var EXPRESSIONS = { blink: expressionBlink };
  for (var _hk in HARNESS_PET_EXPRESSIONS) {
    if (Object.prototype.hasOwnProperty.call(HARNESS_PET_EXPRESSIONS, _hk)) {
      EXPRESSIONS[_hk] = HARNESS_PET_EXPRESSIONS[_hk];
    }
  }

  var DEFAULT_EXPRESSION = 'idle';

  function resolvePetState(s) {
    var next = s || DEFAULT_EXPRESSION;
    if (LEGACY_PET_STATE[next]) next = LEGACY_PET_STATE[next];
    if (!EXPRESSIONS[next] || next === 'blink') next = DEFAULT_EXPRESSION;
    return next;
  }


  /**
   * @param {HTMLElement} rootEl
   * @param {{ enableDrag?: boolean }} [options] — enableDrag 默认 true；桌面悬浮窗传 false
   */
  function create(rootEl, options) {
    options = options || {};
    var canvas = rootEl.querySelector('.pet-canvas');
    var bubbleEl = rootEl.querySelector('.pet-bubble');
    var turnEl = rootEl.querySelector('.status-turn');
    var dragApi =
      options.enableDrag === false ? { afterShow: function () {} } : initPetDrag(rootEl, canvas);
    var ctx = null;
    var state = DEFAULT_EXPRESSION;
    var visible = true;
    var blinkTimer = null;
    var isBlinking = false;
    var blinkCloseTimer = null;
    var animFrame = null;
    var idlePose = 'rest';
    var idleDir = 1;
    var idleTimer = null;

    var tokenPct = 0;
    var tokenUsed = 0;
    var tokenMax = 0;
    var tokenOutput = 0;
    var initialMode =
      window.AppRouter && typeof window.AppRouter.getSupervisorMode === 'function'
        ? window.AppRouter.getSupervisorMode()
        : 'adaptive';
    var eyeColor = supervisorModeToEyeColor(initialMode, COLORS);
    var tokenHintEl = document.createElement('span');
    tokenHintEl.className = 'pet-token-hint';
    tokenHintEl.setAttribute('aria-hidden', 'true');
    var liveRegionEl = document.createElement('span');
    liveRegionEl.className = 'session-pet-indicator__token-live';
    liveRegionEl.setAttribute('aria-live', 'polite');
    liveRegionEl.setAttribute('aria-atomic', 'true');
    var lastAnnouncedTokenDecile = -1;

    if (canvas && canvas.parentNode) {
      var parent = canvas.parentNode;
      var afterCanvas = canvas.nextSibling;
      parent.insertBefore(tokenHintEl, afterCanvas);
      parent.insertBefore(liveRegionEl, tokenHintEl.nextSibling);
    }

    function setupCanvas() {
      if (!canvas) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      var size = Math.round(PET_SIZE * dpr);
      canvas.width = size;
      canvas.height = size;
      ctx = canvas.getContext('2d', { alpha: true });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }

    function drawFace(timestamp) {
      if (!ctx) return;
      var cx = PET_SIZE / 2;
      var cy = PET_SIZE / 2;

      ctx.clearRect(0, 0, PET_SIZE, PET_SIZE);

      var breath = HARNESS_PET_SKIP_BREATH[state] ? 0 : Math.sin(timestamp / 800) * 1.5;
      var scale = 1;
      if (state === 'clap') scale *= 1.02;
      if (state === 'idle') scale *= 1 + Math.sin(timestamp / 350) * 0.012;
      if (state === 'running') scale *= 1 + Math.sin(timestamp / 80) * 0.016;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);

      var bodyY = cy + breath;

      // 机身：固定黑底
      ctx.beginPath();
      ctx.arc(cx, bodyY, BODY_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = BODY_BG;
      ctx.fill();

      // 上下文占用圆环（底轨 + 自顶端顺时针进度）
      var ringR = TOKEN_RING_RADIUS;
      var ringLw = TOKEN_RING_LINE_WIDTH;
      ctx.beginPath();
      ctx.arc(cx, bodyY, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = ringLw;
      ctx.lineCap = 'round';
      ctx.stroke();
      if (tokenPct > 0) {
        var startA = -Math.PI / 2;
        var sweep = (Math.min(100, tokenPct) / 100) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, bodyY, ringR, startA, startA + sweep, false);
        ctx.strokeStyle = tokenRingProgressColor(tokenPct);
        ctx.lineWidth = ringLw;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // 眼睛位置（水平/垂直间距按 PET_SCALE 相对 120×120 稿）
      var eyeSpreadX = Math.round(24 * PET_SCALE);
      var eyeDyBase = Math.round(-4 * PET_SCALE);
      var eyeOff = getEyeOffsetForState(state);
      var eyeYL = bodyY + eyeDyBase + eyeOff.ly;
      var eyeYR = bodyY + eyeDyBase + eyeOff.ry;
      var eyeXL = cx - eyeSpreadX + eyeOff.lx;
      var eyeXR = cx + eyeSpreadX + eyeOff.rx;

      var exprFn = (HARNESS_PET_EXPRESSIONS[state] || EXPRESSIONS[state] || EXPRESSIONS[DEFAULT_EXPRESSION]);
      var idleExtra = state === 'idle' ? { pose: idlePose, dir: idleDir } : undefined;
      var blinking = isBlinking && !HARNESS_PET_SKIP_BLINK[state] && !(state === 'idle' && idlePose === 'doze');
      exprFn(ctx, eyeXL, eyeXR, eyeYL, eyeColor, timestamp, blinking, idleExtra);

      ctx.restore();

      animFrame = requestAnimationFrame(drawFace);
    }

    function getEyeOffsetForState(s) {
      switch (s) {
        case 'planning':
          return { lx: 0, ly: 1, rx: 0, ry: 1 };
        case 'running':
          return { lx: -1, ly: 0, rx: -1, ry: 0 };
        case 'memory':
          return { lx: 0, ly: -2, rx: 0, ry: -2 };
        case 'cancelling':
          return { lx: 0, ly: 2, rx: 0, ry: 2 };
        case 'tool_calling':
        case 'executing':
          return { lx: 3, ly: 3, rx: 3, ry: 3 };
        case 'error':
          return { lx: 0, ly: -1, rx: 0, ry: -1 };
        case 'clap':
          return { lx: -1, ly: -2, rx: 1, ry: -2 };
        default:
          return { lx: 0, ly: 0, rx: 0, ry: 0 };
      }
    }

    function scheduleBlink() {
      if (blinkTimer) clearTimeout(blinkTimer);
      if (blinkCloseTimer) clearTimeout(blinkCloseTimer);
      blinkTimer = null;
      blinkCloseTimer = null;
      isBlinking = false;

      function nextBlink() {
        if (HARNESS_PET_SKIP_BLINK[state]) {
          isBlinking = false;
          blinkTimer = setTimeout(nextBlink, BLINK_MAX);
          return;
        }
        var delay = BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
        blinkTimer = setTimeout(function () {
          if (HARNESS_PET_SKIP_BLINK[state]) {
            nextBlink();
            return;
          }
          isBlinking = true;
          blinkCloseTimer = setTimeout(function () {
            isBlinking = false;
            nextBlink();
          }, BLINK_DURATION);
        }, delay);
      }
      nextBlink();
    }

    function setVisible(v) {
      visible = v !== false;
      rootEl.classList.add('active');
      if (dragApi && dragApi.afterShow) dragApi.afterShow();
      scheduleBlink();
    }

    function pickIdlePose() {
      var bag = IDLE_POSES.concat(['rest']);
      var next = idlePose;
      var guard = 0;
      while (next === idlePose && guard < 10) {
        next = bag[Math.floor(Math.random() * bag.length)];
        guard += 1;
      }
      if (next === 'glance') idleDir = Math.random() < 0.5 ? -1 : 1;
      return next;
    }

    function stopIdlePoseCycle() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    function scheduleIdlePose() {
      stopIdlePoseCycle();
      if (state !== 'idle') return;
      idleTimer = setTimeout(function () {
        if (state !== 'idle') return;
        idlePose = pickIdlePose();
        scheduleIdlePose();
      }, idlePoseHoldMs(idlePose));
    }

    function setState(s) {
      state = resolvePetState(s);
      if (canvas) {
        canvas.classList.remove('pet-wobble', 'pet-crying');
        if (state === 'user_checkpoint') canvas.classList.add('pet-crying');
      }
      if (state === 'idle') {
        idlePose = 'rest';
        scheduleIdlePose();
      } else {
        stopIdlePoseCycle();
      }
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

    function setTokenUsage(used, max, output) {
      tokenUsed = used || 0;
      tokenMax = max || 0;
      tokenOutput = output || 0;
      tokenPct = tokenMax ? Math.min(100, Math.round((tokenUsed / tokenMax) * 100)) : 0;
      var usedL = formatTokenCount(tokenUsed);
      var maxL = formatTokenCount(tokenMax);
      var outL = formatTokenCount(tokenOutput);
      if (canvas) {
        canvas.title =
          SESSION_PET_DISPLAY_NAME +
          ' · 上下文 ' +
          tokenPct +
          '%' +
          (tokenMax ? ' (' + usedL + '/' + maxL + ')' : '') +
          ' · 本轮输出 ' +
          outL;
        canvas.setAttribute(
          'aria-label',
          buildSessionPetCanvasAriaLabel({
            tokenPct: tokenPct,
            tokenUsed: tokenUsed,
            tokenMax: tokenMax,
            tokenOutput: tokenOutput,
            tokenUsedLabel: usedL,
            tokenMaxLabel: maxL,
            outputLabel: outL,
          }),
        );
      }
      var decile = tokenMax ? Math.min(10, Math.floor(tokenPct / 10)) : 0;
      if (liveRegionEl && decile !== lastAnnouncedTokenDecile) {
        if (lastAnnouncedTokenDecile >= 0) {
          liveRegionEl.textContent = '上下文占用约 ' + tokenPct + '%';
        }
        lastAnnouncedTokenDecile = decile;
      }
    }

    function setEyeColor(hex) {
      if (typeof hex !== 'string' || !hex) return;
      var s = hex.trim();
      if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s)) return;
      eyeColor = s;
    }

    function formatTokenCount(n) {
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return '' + n;
    }

    var resizeDprTimer = null;
    function onResizeDpr() {
      if (resizeDprTimer) clearTimeout(resizeDprTimer);
      resizeDprTimer = setTimeout(function () {
        setupCanvas();
      }, 200);
    }
    window.addEventListener('resize', onResizeDpr);

    setupCanvas();
    rootEl.classList.add('active');
    if (dragApi && dragApi.afterShow) dragApi.afterShow();
    scheduleBlink();
    if (state === 'idle') scheduleIdlePose();
    animFrame = requestAnimationFrame(drawFace);
    setTokenUsage(0, 0, 0);

    return {
      setVisible: setVisible,
      setState: setState,
      setBubbleText: setBubbleText,
      setTurnLabel: setTurnLabel,
      setTokenUsage: setTokenUsage,
      setEyeColor: setEyeColor,
      isVisible: function () {
        return visible;
      }
    };
  }

  window.SessionPet = {
    create: create,
  };
  window.SESSION_PET_DISPLAY_NAME = SESSION_PET_DISPLAY_NAME;
})();
