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

(() => {

  /** 逻辑画布边长（与 CSS .pet-canvas、HTML canvas width/height 一致） */
  const PET_SIZE = 96;
  /** 版面比例：相对最初 120×120 设计稿 */
  const PET_SCALE = PET_SIZE / 120;
  const EYE_W = Math.round(14 * PET_SCALE);

  const BLINK_MIN = 1000;
  const BLINK_MAX = 3000;
  const BLINK_DURATION = 150;

  const PET_BUBBLE_MAX_CHARS = 42;

  // 固定颜色：黑底；眼睛线色见 create() 闭包内 eyeColor（每实例独立）
  const BODY_BG = '#000000';
  /** token 圆环线宽（逻辑像素） */
  const TOKEN_RING_LINE_WIDTH = 3.25 * PET_SCALE;
  /** 圆环内侧与机身外缘的间距（逻辑像素） */
  const TOKEN_RING_BODY_GAP = 3;
  /** 机身圆半径（与下方 fill 用的半径一致） */
  const BODY_RADIUS = PET_SIZE / 2 - 8;
  /** 圆环中心半径：机身外缘 + 间距 + 描边半宽（描边以该半径为中心） */
  const TOKEN_RING_RADIUS = BODY_RADIUS + TOKEN_RING_BODY_GAP + TOKEN_RING_LINE_WIDTH / 2;

  const TOKEN_RING_GREEN = '#1ECFB4';
  const TOKEN_RING_YELLOW = '#DBF02C';
  const TOKEN_RING_RED = '#FC5A76';

  function hexToRgb(hex) {
    let h = String(hex || '').replace('#', '');
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
      const s = Math.max(0, Math.min(255, x)).toString(16);
      return s.length === 1 ? `0${s}` : s;
    }
    return `#${byteToHex(rgb.r)}${byteToHex(rgb.g)}${byteToHex(rgb.b)}`;
  }

  const _ringRgbGreen = hexToRgb(TOKEN_RING_GREEN);
  const _ringRgbYellow = hexToRgb(TOKEN_RING_YELLOW);
  const _ringRgbRed = hexToRgb(TOKEN_RING_RED);

  function tokenRingProgressColor(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const g = _ringRgbGreen;
    const y = _ringRgbYellow;
    const r = _ringRgbRed;
    if (p <= 50) {
      const t = p / 50;
      return rgbToHex({
        r: lerpByte(g.r, y.r, t),
        g: lerpByte(g.g, y.g, t),
        b: lerpByte(g.b, y.b, t),
      });
    }
    const t2 = (p - 50) / 50;
    return rgbToHex({
      r: lerpByte(y.r, r.r, t2),
      g: lerpByte(y.g, r.g, t2),
      b: lerpByte(y.b, r.b, t2),
    });
  }

  function clampBubbleLine(text) {
    if (text === undefined || text === null) return '';
    const s = String(text).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    let line = s.split(/\r\n|\n|\r/)[0].trim();
    if (line.length > PET_BUBBLE_MAX_CHARS) {
      line = `${line.slice(0, PET_BUBBLE_MAX_CHARS - 1)}…`;
    }
    return line;
  }

  const DRAG_STORE_KEY = 'ice-session-pet-position';
  const DRAG_MARGIN = 8;
  const DRAG_THRESHOLD = 5;

  function initPetDrag(rootEl, dragHandleEl) {
    if (!rootEl || !dragHandleEl) return { afterShow() { } };

    let dragPointerId = null;
    let dragActive = false;
    let startClientX = 0;
    let startClientY = 0;
    let startLeft = 0;
    let startTop = 0;
    let savedPosLoaded = false;

    function visualViewportBottom() {
      const vv = window.visualViewport;
      if (vv) return vv.offsetTop + vv.height;
      return window.innerHeight;
    }

    function getBounds() {
      const rect = rootEl.getBoundingClientRect();
      const w = rect.width > 2 ? rect.width : rootEl.offsetWidth || 136;
      const h = rect.height > 2 ? rect.height : rootEl.offsetHeight || 168;
      const nav = document.getElementById('top-nav');
      const topNavBottom = nav ? nav.getBoundingClientRect().bottom : 0;
      const minT = Math.max(DRAG_MARGIN, topNavBottom + DRAG_MARGIN);
      const inputArea = document.querySelector('.chat-input-area');
      let bottomLimit = visualViewportBottom() - DRAG_MARGIN;
      if (inputArea && rootEl.closest('.chat-page')) {
        const inputTop = inputArea.getBoundingClientRect().top;
        if (inputTop > minT + 40) {
          bottomLimit = Math.min(bottomLimit, inputTop - DRAG_MARGIN);
        }
      }
      let maxT = bottomLimit - h;
      let maxL = window.innerWidth - w - DRAG_MARGIN;
      const minL = DRAG_MARGIN;
      if (maxT < minT) maxT = minT;
      if (maxL < minL) maxL = minL;
      return { minL, maxL, minT, maxT };
    }

    function applyPosition(left, top) {
      const b = getBounds();
      left = Math.min(Math.max(left, b.minL), b.maxL);
      top = Math.min(Math.max(top, b.minT), b.maxT);
      rootEl.style.left = `${left}px`;
      rootEl.style.top = `${top}px`;
      rootEl.style.right = 'auto';
      rootEl.style.bottom = 'auto';
      rootEl.style.transform = 'none';
      rootEl.classList.add('session-pet-indicator--placed');
      try {
        localStorage.setItem(DRAG_STORE_KEY, JSON.stringify({ left, top }));
      } catch (_e) { /* ignore */ }
    }

    function clampToBounds() {
      if (!rootEl.classList.contains('session-pet-indicator--placed')) return;
      const rect = rootEl.getBoundingClientRect();
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
        const raw = localStorage.getItem(DRAG_STORE_KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (typeof o.left !== 'number' || typeof o.top !== 'number' || !isFinite(o.left) || !isFinite(o.top)) return;
        applyPosition(o.left, o.top);
      } catch (_e) { /* ignore */ }
    }

    function onPointerMove(e) {
      if (dragPointerId === null || e.pointerId !== dragPointerId) return;
      const dx = e.clientX - startClientX;
      const dy = e.clientY - startClientY;
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
      (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        dragPointerId = e.pointerId;
        dragActive = false;
        startClientX = e.clientX;
        startClientY = e.clientY;
        const rect = rootEl.getBoundingClientRect();
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
      afterShow() {
        if (!savedPosLoaded) {
          savedPosLoaded = true;
          loadSavedPosition();
        }
        requestAnimationFrame(() => {
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

  const LEGACY_PET_STATE = {
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

  const EXPRESSIONS = { blink: expressionBlink };
  for (const _hk in HARNESS_PET_EXPRESSIONS) {
    if (Object.prototype.hasOwnProperty.call(HARNESS_PET_EXPRESSIONS, _hk)) {
      EXPRESSIONS[_hk] = HARNESS_PET_EXPRESSIONS[_hk];
    }
  }

  const DEFAULT_EXPRESSION = 'idle';

  function resolvePetState(s) {
    let next = s || DEFAULT_EXPRESSION;
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
    const canvas = rootEl.querySelector('.pet-canvas');
    const bubbleEl = rootEl.querySelector('.pet-bubble');
    const turnEl = rootEl.querySelector('.status-turn');
    const dragApi =
      options.enableDrag === false ? { afterShow() {} } : initPetDrag(rootEl, canvas);
    let ctx = null;
    let state = DEFAULT_EXPRESSION;
    let visible = true;
    let blinkTimer = null;
    let isBlinking = false;
    let blinkCloseTimer = null;
    let animFrame = null;
    let idlePose = 'rest';
    let idleDir = 1;
    let idleTimer = null;

    let tokenPct = 0;
    let tokenUsed = 0;
    let tokenMax = 0;
    let tokenOutput = 0;
    const initialMode =
      window.AppRouter && typeof window.AppRouter.getSupervisorMode === 'function'
        ? window.AppRouter.getSupervisorMode()
        : 'adaptive';
    let eyeColor = supervisorModeToEyeColor(initialMode, COLORS);
    const tokenHintEl = document.createElement('span');
    tokenHintEl.className = 'pet-token-hint';
    tokenHintEl.setAttribute('aria-hidden', 'true');
    const liveRegionEl = document.createElement('span');
    liveRegionEl.className = 'session-pet-indicator__token-live';
    liveRegionEl.setAttribute('aria-live', 'polite');
    liveRegionEl.setAttribute('aria-atomic', 'true');
    let lastAnnouncedTokenDecile = -1;

    if (canvas && canvas.parentNode) {
      const parent = canvas.parentNode;
      const afterCanvas = canvas.nextSibling;
      parent.insertBefore(tokenHintEl, afterCanvas);
      parent.insertBefore(liveRegionEl, tokenHintEl.nextSibling);
    }

    function setupCanvas() {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const size = Math.round(PET_SIZE * dpr);
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
      const cx = PET_SIZE / 2;
      const cy = PET_SIZE / 2;

      ctx.clearRect(0, 0, PET_SIZE, PET_SIZE);

      const breath = HARNESS_PET_SKIP_BREATH[state] ? 0 : Math.sin(timestamp / 800) * 1.5;
      let scale = 1;
      if (state === 'clap') scale *= 1.02;
      if (state === 'idle') scale *= 1 + Math.sin(timestamp / 350) * 0.012;
      if (state === 'running') scale *= 1 + Math.sin(timestamp / 80) * 0.016;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);

      const bodyY = cy + breath;

      // 机身：固定黑底
      ctx.beginPath();
      ctx.arc(cx, bodyY, BODY_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = BODY_BG;
      ctx.fill();

      // 上下文占用圆环（底轨 + 自顶端顺时针进度）
      const ringR = TOKEN_RING_RADIUS;
      const ringLw = TOKEN_RING_LINE_WIDTH;
      ctx.beginPath();
      ctx.arc(cx, bodyY, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = ringLw;
      ctx.lineCap = 'round';
      ctx.stroke();
      if (tokenPct > 0) {
        const startA = -Math.PI / 2;
        const sweep = (Math.min(100, tokenPct) / 100) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, bodyY, ringR, startA, startA + sweep, false);
        ctx.strokeStyle = tokenRingProgressColor(tokenPct);
        ctx.lineWidth = ringLw;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // 眼睛位置（水平/垂直间距按 PET_SCALE 相对 120×120 稿）
      const eyeSpreadX = Math.round(24 * PET_SCALE);
      const eyeDyBase = Math.round(-4 * PET_SCALE);
      const eyeOff = getEyeOffsetForState(state);
      const eyeYL = bodyY + eyeDyBase + eyeOff.ly;
      const eyeYR = bodyY + eyeDyBase + eyeOff.ry;
      const eyeXL = cx - eyeSpreadX + eyeOff.lx;
      const eyeXR = cx + eyeSpreadX + eyeOff.rx;

      const exprFn = (HARNESS_PET_EXPRESSIONS[state] || EXPRESSIONS[state] || EXPRESSIONS[DEFAULT_EXPRESSION]);
      const idleExtra = state === 'idle' ? { pose: idlePose, dir: idleDir } : undefined;
      const blinking = isBlinking && !HARNESS_PET_SKIP_BLINK[state] && !(state === 'idle' && idlePose === 'doze');
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
        const delay = BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
        blinkTimer = setTimeout(() => {
          if (HARNESS_PET_SKIP_BLINK[state]) {
            nextBlink();
            return;
          }
          isBlinking = true;
          blinkCloseTimer = setTimeout(() => {
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
      const bag = IDLE_POSES.concat(['rest']);
      let next = idlePose;
      let guard = 0;
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
      idleTimer = setTimeout(() => {
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
      const t = clampBubbleLine(text);
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
      const usedL = formatTokenCount(tokenUsed);
      const maxL = formatTokenCount(tokenMax);
      const outL = formatTokenCount(tokenOutput);
      if (canvas) {
        canvas.title =
          SESSION_PET_DISPLAY_NAME +
          ' · 上下文 ' +
          tokenPct +
          '%' +
          (tokenMax ? ` (${usedL}/${maxL})` : '') +
          ' · 本轮输出 ' +
          outL;
        canvas.setAttribute(
          'aria-label',
          buildSessionPetCanvasAriaLabel({
            tokenPct,
            tokenUsed,
            tokenMax,
            tokenOutput,
            tokenUsedLabel: usedL,
            tokenMaxLabel: maxL,
            outputLabel: outL,
          }),
        );
      }
      const decile = tokenMax ? Math.min(10, Math.floor(tokenPct / 10)) : 0;
      if (liveRegionEl && decile !== lastAnnouncedTokenDecile) {
        if (lastAnnouncedTokenDecile >= 0) {
          liveRegionEl.textContent = `上下文占用约 ${tokenPct}%`;
        }
        lastAnnouncedTokenDecile = decile;
      }
    }

    function setEyeColor(hex) {
      if (typeof hex !== 'string' || !hex) return;
      const s = hex.trim();
      if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s)) return;
      eyeColor = s;
    }

    function formatTokenCount(n) {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
      return `${n}`;
    }

    let resizeDprTimer = null;
    function onResizeDpr() {
      if (resizeDprTimer) clearTimeout(resizeDprTimer);
      resizeDprTimer = setTimeout(() => {
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
      setVisible,
      setState,
      setBubbleText,
      setTurnLabel,
      setTokenUsage,
      setEyeColor,
      isVisible() {
        return visible;
      }
    };
  }

  window.SessionPet = {
    create,
  };
  window.SESSION_PET_DISPLAY_NAME = SESSION_PET_DISPLAY_NAME;
})();
