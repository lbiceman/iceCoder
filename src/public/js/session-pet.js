/**
 * 会话宠物指示器
 * 极简 NOMI 风格：固定黑底 + 白色胶囊眼睛 + 环形 token 进度条。
 * 不区分昼夜模式，始终黑底白字。
 * 眨眼：1-3 秒随机间隔，闭眼 150ms。
 *
 * 表情系统：20 种对外状态（+ 内部 blink 眨眼帧），按业务切换。
 */
(function () {
  'use strict';

  var PET_SIZE = 120;
  var RING_THICKNESS = 3;
  var EYE_W = 14;
  /** 胶囊眼竖向逻辑高度（非画布位置）；减小此值可缩矮眼睛形状 */
  var EYE_H = 18;
  /** read：眼直径 12px 实心圆、镜片框直径 24px */
  var READ_EYE_DIA_PX = 8;
  var READ_LENS_DIA_PX = 24;

  var BLINK_MIN = 1000;
  var BLINK_MAX = 3000;
  var BLINK_DURATION = 150;

  var PET_BUBBLE_MAX_CHARS = 42;

  // 固定颜色：黑底白眼睛
  var BODY_BG = '#0a0a12';
  var EYE_COLOR = '#ffffff';
  var GLOW_COLOR = 'rgba(107,156,255,0.10)';

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

  // ============ 表情绘制函数（预留 10+ 种状态） ============

  /**
   * 基础胶囊眼睛（竖直）
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx 中心 x
   * @param {number} cy 中心 y
   * @param {number} halfW 半宽
   * @param {number} halfH 半高
   * @param {string} color 线条颜色
   */
  function drawCapsuleEye(ctx, cx, cy, halfW, halfH, color) {
    var topY = cy - halfH;
    var bottomY = cy + halfH;
    var rightX = cx + halfW;

    ctx.beginPath();
    ctx.arc(cx, topY, halfW, Math.PI, 0, false);
    ctx.lineTo(rightX, bottomY);
    ctx.arc(cx, bottomY, halfW, 0, Math.PI, false);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** 眨眼横线 */
  function drawBlinkLine(ctx, cx, cy, w, color) {
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy);
    ctx.lineTo(cx + w / 2, cy);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // ---- 以下是各种表情的眼睛绘制函数 ----

  /** 1. idle — 平静（标准胶囊眼） */
  function expressionIdle(ctx, leftX, rightX, y) {
    drawCapsuleEye(ctx, leftX, y, EYE_W / 2, EYE_H / 2, EYE_COLOR);
    drawCapsuleEye(ctx, rightX, y, EYE_W / 2, EYE_H / 2, EYE_COLOR);
  }

  /** 2. happy — 开心（笑眼：弧线中间上拱 ^，与 sad 的下垂弧相反） */
  function expressionHappy(ctx, leftX, rightX, y) {
    var w = EYE_W / 2;
    ctx.beginPath();
    ctx.moveTo(leftX - w * 0.85, y + 1);
    ctx.quadraticCurveTo(leftX, y - 5, leftX + w * 0.85, y + 1);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(rightX - w * 0.85, y + 1);
    ctx.quadraticCurveTo(rightX, y - 5, rightX + w * 0.85, y + 1);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 3. thinking — 若有所思（略眯、视线朝左上；高光在眶左上，无跨眉线） */
  function expressionThinking(ctx, leftX, rightX, y) {
    var hw = EYE_W / 2;
    var hh = EYE_H * 0.38;

    // 整体略向左，和「往左上看」一致
    var lx = leftX - 1.5;
    var rx = rightX - 1;

    drawCapsuleEye(ctx, lx, y - 2, hw - 0.5, hh, EYE_COLOR);
    drawCapsuleEye(ctx, rx, y - 2, hw - 0.5, hh, EYE_COLOR);

    // 主高光：每只眼轮廓的左上方 → 读成瞳孔/视线朝左上
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(lx - 2, y - 5.5, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx - 2.8, y - 5.2, 1.9, 0, Math.PI * 2);
    ctx.fill();

    // 次高光：更靠左上、弱一点，增加凝视层次
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(lx - 3.2, y - 7, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx - 4, y - 6.6, 0.85, 0, Math.PI * 2);
    ctx.fill();
  }

  /** working 态视线扫动周期（ms）：整段左上方↔右上方约一周期，偏慢显严谨 */
  var WORKING_GAZE_PERIOD_MS = 3800;

  /**
   * 4. working — 工作中：略眯、视线在左上与右上之间慢速往复（严谨、像在审读）
   * @param {number} timestamp requestAnimationFrame 时间戳
   */
  function expressionWorking(ctx, leftX, rightX, y, timestamp) {
    var t = typeof timestamp === 'number' ? timestamp : 0;
    var u = Math.sin((t / WORKING_GAZE_PERIOD_MS) * Math.PI * 2);
    var gx = u * 1.35;
    var gy = -1.15 - Math.abs(u) * 0.22;
    var lx = leftX + gx;
    var rx = rightX + gx;
    var yy = y + gy;
    var hw = EYE_W / 2 - 0.5;
    var hh = EYE_H * 0.41;
    drawCapsuleEye(ctx, lx, yy, hw, hh, EYE_COLOR);
    drawCapsuleEye(ctx, rx, yy, hw, hh, EYE_COLOR);
    ctx.fillStyle = EYE_COLOR;
    ctx.beginPath();
    ctx.arc(lx + 1 + u * 0.45, yy - 3.2, 1.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx - 1 + u * 0.45, yy - 3.2, 1.12, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 5. confused — 键名保留；画布与 angry 同为愤怒斜眼 */
  function expressionConfused(ctx, leftX, rightX, y) {
    expressionAngry(ctx, leftX, rightX, y);
  }

  /** 6. alert — 警觉（眼睛睁大） */
  function expressionAlert(ctx, leftX, rightX, y) {
    var bigH = EYE_H * 0.7;
    drawCapsuleEye(ctx, leftX, y - 2, EYE_W / 2 + 1, bigH / 2, EYE_COLOR);
    drawCapsuleEye(ctx, rightX, y - 2, EYE_W / 2 + 1, bigH / 2, EYE_COLOR);
  }

  /** 7. anxious — 焦虑（眼睛快速眨动效果用横线表示） */
  function expressionAnxious(ctx, leftX, rightX, y) {
    // 半闭眼状态
    drawBlinkLine(ctx, leftX, y - 2, EYE_W + 2, EYE_COLOR);
    drawBlinkLine(ctx, rightX, y - 2, EYE_W + 2, EYE_COLOR);
    // 下面加一条表示紧张
    drawBlinkLine(ctx, leftX, y + 4, EYE_W, EYE_COLOR);
    drawBlinkLine(ctx, rightX, y + 4, EYE_W, EYE_COLOR);
  }

  /** 8. rest — 休息（闭眼横线） */
  function expressionRest(ctx, leftX, rightX, y) {
    drawBlinkLine(ctx, leftX, y, EYE_W, EYE_COLOR);
    drawBlinkLine(ctx, rightX, y, EYE_W, EYE_COLOR);
    // 加一条 Z 字形表示睡觉
    ctx.beginPath();
    ctx.moveTo(rightX + 12, y - 8);
    ctx.lineTo(rightX + 16, y - 8);
    ctx.lineTo(rightX + 14, y - 4);
    ctx.lineTo(rightX + 18, y - 4);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** 9. surprised — 惊讶（眼睛睁圆） */
  function expressionSurprised(ctx, leftX, rightX, y) {
    ctx.beginPath();
    ctx.arc(leftX, y, EYE_W / 2 + 2, 0, Math.PI * 2);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rightX, y, EYE_W / 2 + 2, 0, Math.PI * 2);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  /** 10. sad — 难过（眼睛下垂） */
  function expressionSad(ctx, leftX, rightX, y) {
    ctx.beginPath();
    ctx.arc(leftX, y - 4, EYE_W / 2, Math.PI * 0.2, Math.PI * 0.8, false);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rightX, y - 4, EYE_W / 2, Math.PI * 0.2, Math.PI * 0.8, false);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 11. angry — 生气（眼睛斜向上） */
  function expressionAngry(ctx, leftX, rightX, y) {
    ctx.beginPath();
    ctx.moveTo(leftX - EYE_W / 2, y + 4);
    ctx.lineTo(leftX + EYE_W / 2, y - 4);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rightX - EYE_W / 2, y - 4);
    ctx.lineTo(rightX + EYE_W / 2, y + 4);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 12. curious — 好奇（一大一小两眼，同一水平线、小眼相对大眼垂直居中） */
  function expressionCurious(ctx, leftX, rightX, y) {
    var hwL = EYE_W / 2;
    var hhL = EYE_H / 2;
    var hwR = EYE_W / 2 - 2;
    var hhR = EYE_H / 2 - 3;
    // 共用同一 y 作为胶囊竖直中心，halfH 不同则自然上下对称扩展 → 垂直居中对齐
    drawCapsuleEye(ctx, leftX - 2, y, hwL, hhL, EYE_COLOR);
    drawCapsuleEye(ctx, rightX + 3, y, hwR, hhR, EYE_COLOR);
  }

  /** 13. dizzy — 晕（眼内小叉） */
  function drawMiniX(ctx, cx, cy, r) {
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r);
    ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx + r, cy - r);
    ctx.lineTo(cx - r, cy + r);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  function expressionDizzy(ctx, leftX, rightX, y) {
    drawMiniX(ctx, leftX, y, 5);
    drawMiniX(ctx, rightX, y, 5);
  }

  /** 14. shy — 害羞（眯眼避视、腮红、略内向） */
  function expressionShy(ctx, leftX, rightX, y) {
    var lx = leftX - 3;
    var rx = rightX - 3;
    var hh = EYE_H * 0.34;
    var hw = EYE_W / 2 - 1;
    drawCapsuleEye(ctx, lx, y + 1, hw, hh, EYE_COLOR);
    drawCapsuleEye(ctx, rx, y + 1, hw, hh, EYE_COLOR);
    // 腼腆视线：高光偏外下，像不好意思抬眼
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.beginPath();
    ctx.arc(lx - 1.5, y + 2.5, 1.3, 0, Math.PI * 2);
    ctx.arc(rx - 1.5, y + 2.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
    // 淡腮红（娇羞）
    ctx.fillStyle = 'rgba(255, 130, 150, 0.22)';
    ctx.beginPath();
    ctx.arc(lx - 10, y + 14, 9, 0, Math.PI * 2);
    ctx.arc(rx + 10, y + 14, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 15. love — 喜欢（闪亮圆点眼） */
  function expressionLove(ctx, leftX, rightX, y) {
    ctx.beginPath();
    ctx.arc(leftX, y - 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = EYE_COLOR;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightX, y - 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = EYE_COLOR;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(leftX, y + 2, 2, 0, Math.PI * 2);
    ctx.arc(rightX, y + 2, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
  }

  /** 16. weary — 疲惫（半耷拉眼） */
  function expressionWeary(ctx, leftX, rightX, y) {
    ctx.beginPath();
    ctx.arc(leftX, y + 2, EYE_W / 2, Math.PI * 0.15, Math.PI * 0.85, false);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rightX, y + 2, EYE_W / 2, Math.PI * 0.15, Math.PI * 0.85, false);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 17. focused — 专注（竖条焦聚眼） */
  function expressionFocused(ctx, leftX, rightX, y) {
    ctx.beginPath();
    ctx.moveTo(leftX, y - 10);
    ctx.lineTo(leftX, y + 10);
    ctx.moveTo(rightX, y - 10);
    ctx.lineTo(rightX, y + 10);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** read：白色圆框眼镜（直径 READ_LENS_DIA_PX）；画在眼上，眨眼后仍绘镜框 */
  function drawReadGlasses(ctx, leftX, rightX, y) {
    var lr = READ_LENS_DIA_PX / 2;
    var templeLen = 7.5;
    ctx.save();
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.arc(leftX, y, lr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rightX, y, lr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(leftX + lr, y);
    ctx.lineTo(rightX - lr, y);
    ctx.stroke();
    ctx.lineWidth = 1.55;
    ctx.beginPath();
    ctx.moveTo(leftX - lr, y);
    ctx.lineTo(leftX - lr - templeLen, y - 10);
    ctx.moveTo(rightX + lr, y);
    ctx.lineTo(rightX + lr + templeLen, y - 10);
    ctx.stroke();
    ctx.restore();
  }

  /** 18. read — 直径 12px 实心圆眼；24px 白色圆镜框见 drawReadGlasses */
  function expressionRead(ctx, leftX, rightX, y) {
    var er = READ_EYE_DIA_PX / 2;
    ctx.fillStyle = EYE_COLOR;
    ctx.beginPath();
    ctx.arc(leftX, y, er, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightX, y, er, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 19. determined — 决绝（眉压眼） */
  function expressionDetermined(ctx, leftX, rightX, y) {
    ctx.beginPath();
    ctx.moveTo(leftX - EYE_W / 2 - 2, y - 6);
    ctx.lineTo(leftX + EYE_W / 2 + 1, y - 1);
    ctx.moveTo(rightX - EYE_W / 2 - 1, y - 1);
    ctx.lineTo(rightX + EYE_W / 2 + 2, y - 6);
    ctx.strokeStyle = EYE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    drawCapsuleEye(ctx, leftX, y + 2, EYE_W / 2, EYE_H / 2 - 4, EYE_COLOR);
    drawCapsuleEye(ctx, rightX, y + 2, EYE_W / 2, EYE_H / 2 - 4, EYE_COLOR);
  }

  /** 20. playful — 俏皮（单眼眨） */
  function expressionPlayful(ctx, leftX, rightX, y) {
    drawCapsuleEye(ctx, leftX, y, EYE_W / 2, EYE_H / 2, EYE_COLOR);
    drawBlinkLine(ctx, rightX, y, EYE_W + 2, EYE_COLOR);
  }

  /** blink — 眨眼（横线，内部状态） */
  function expressionBlink(ctx, leftX, rightX, y) {
    drawBlinkLine(ctx, leftX, y, EYE_W, EYE_COLOR);
    drawBlinkLine(ctx, rightX, y, EYE_W, EYE_COLOR);
  }

  // 表情映射表（对外 20 种 + 内部 blink）
  var EXPRESSIONS = {
    idle: expressionIdle,
    happy: expressionHappy,
    thinking: expressionThinking,
    working: expressionWorking,
    confused: expressionConfused,
    alert: expressionAlert,
    anxious: expressionAnxious,
    rest: expressionRest,
    surprised: expressionSurprised,
    sad: expressionSad,
    angry: expressionAngry,
    curious: expressionCurious,
    dizzy: expressionDizzy,
    shy: expressionShy,
    love: expressionLove,
    weary: expressionWeary,
    focused: expressionFocused,
    read: expressionRead,
    determined: expressionDetermined,
    playful: expressionPlayful,
    blink: expressionBlink,
  };

  /**
   * @param {HTMLElement} rootEl
   */
  function create(rootEl) {
    var canvas = rootEl.querySelector('.pet-canvas');
    var bubbleEl = rootEl.querySelector('.pet-bubble');
    var turnEl = rootEl.querySelector('.status-turn');
    var dragApi = initPetDrag(rootEl, canvas);
    var ctx = null;
    var state = 'idle';
    var visible = true;
    var blinkTimer = null;
    var isBlinking = false;
    var blinkCloseTimer = null;
    var animFrame = null;

    var tokenPct = 0;
    var tokenUsed = 0;
    var tokenMax = 0;
    var tokenOutput = 0;

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

    function drawRing(cx, cy, radius, thickness, pct) {
      if (!ctx || pct <= 0) return;
      var startAngle = -Math.PI / 2;
      var endAngle = startAngle + (Math.PI * 2 * Math.min(pct, 100) / 100);

      var grad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
      grad.addColorStop(0, '#5ee7df');
      grad.addColorStop(1, '#b490ca');

      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.strokeStyle = grad;
      ctx.lineWidth = thickness;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    function drawFace(timestamp) {
      if (!ctx) return;
      var cx = PET_SIZE / 2;
      var cy = PET_SIZE / 2;

      ctx.clearRect(0, 0, PET_SIZE, PET_SIZE);

      var breath = state === 'working' ? 0 : Math.sin(timestamp / 800) * 1.5;
      var scale = 1;
      if (state === 'happy') scale *= 1.02;
      if (state === 'playful') scale *= 1 + Math.sin(timestamp / 350) * 0.012;

      var ringRadius = PET_SIZE / 2 - RING_THICKNESS / 2;
      drawRing(cx, cy + breath, ringRadius, RING_THICKNESS, tokenPct);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);

      var bodyY = cy + breath;

      // 外圈光晕
      ctx.beginPath();
      ctx.arc(cx, bodyY, PET_SIZE / 2 - RING_THICKNESS - 2, 0, Math.PI * 2);
      ctx.fillStyle = GLOW_COLOR;
      ctx.fill();

      // 机身：固定黑底
      ctx.beginPath();
      ctx.arc(cx, bodyY, PET_SIZE / 2 - RING_THICKNESS - 6, 0, Math.PI * 2);
      ctx.fillStyle = BODY_BG;
      ctx.fill();

      // 眼睛位置
      var eyeOff = getEyeOffsetForState(state);
      var eyeYL = bodyY - 4 + eyeOff.ly;
      var eyeYR = bodyY - 4 + eyeOff.ry;
      var eyeXL = cx - 24 + eyeOff.lx;
      var eyeXR = cx + 24 + eyeOff.rx;

      if (isBlinking) {
        if (state === 'read') {
          drawBlinkLine(ctx, eyeXL, eyeYL, READ_EYE_DIA_PX, EYE_COLOR);
          drawBlinkLine(ctx, eyeXR, eyeYR, READ_EYE_DIA_PX, EYE_COLOR);
        } else {
          expressionBlink(ctx, eyeXL, eyeXR, eyeYL);
        }
      } else if (state === 'working') {
        expressionWorking(ctx, eyeXL, eyeXR, eyeYL, timestamp);
      } else {
        var exprFn = EXPRESSIONS[state] || expressionIdle;
        exprFn(ctx, eyeXL, eyeXR, eyeYL);
      }
      if (state === 'read') {
        drawReadGlasses(ctx, eyeXL, eyeXR, eyeYL);
      }

      ctx.restore();

      animFrame = requestAnimationFrame(drawFace);
    }

    function getEyeOffsetForState(s) {
      switch (s) {
        case 'thinking':
          return { lx: -1, ly: -1, rx: -1, ry: -1 };
        case 'confused':
          return { lx: 0, ly: 0, rx: 0, ry: 0 };
        case 'alert':
          return { lx: 0, ly: -3, rx: 0, ry: -3 };
        case 'happy':
          return { lx: -1, ly: -2, rx: 1, ry: -2 };
        case 'surprised':
          return { lx: 0, ly: -4, rx: 0, ry: -4 };
        case 'sad':
          return { lx: 0, ly: 3, rx: 0, ry: 3 };
        case 'anxious':
          return { lx: 1, ly: 1, rx: -1, ry: 1 };
        case 'curious':
          return { lx: -2, ly: 0, rx: 2, ry: 0 };
        case 'dizzy':
          return { lx: 0, ly: 1, rx: 0, ry: 1 };
        case 'focused':
          return { lx: 0, ly: -2, rx: 0, ry: -2 };
        case 'read':
          return { lx: 0, ly: 0, rx: 0, ry: 0 };
        case 'determined':
          return { lx: 0, ly: 2, rx: 0, ry: 2 };
        case 'playful':
          return { lx: 1, ly: -1, rx: -1, ry: -1 };
        case 'working':
          return { lx: 0, ly: -1, rx: 0, ry: -1 };
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
        var delay = BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
        blinkTimer = setTimeout(function () {
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

    function setState(s) {
      state = s || 'idle';
      if (canvas) canvas.classList.remove('pet-wobble');
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
      if (canvas) {
        canvas.title = '上下文: ' + tokenPct + '%' +
          (tokenMax ? ' (' + formatTokenCount(tokenUsed) + '/' + formatTokenCount(tokenMax) + ')' : '') +
          ' | 本轮输出: ' + formatTokenCount(tokenOutput);
      }
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
    animFrame = requestAnimationFrame(drawFace);

    return {
      setVisible: setVisible,
      setState: setState,
      setBubbleText: setBubbleText,
      setTurnLabel: setTurnLabel,
      setTokenUsage: setTokenUsage,
      isVisible: function () {
        return visible;
      }
    };
  }

  window.SessionPet = {
    create: create
  };
})();
