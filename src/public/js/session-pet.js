/**
 * 冰豆（Ice Bean）— iceCoder Web 会话状态指示器
 * 极简风格：固定黑底 + 胶囊眼睛；眼睛色对应当前 supervisorMode（见 session-pet-palette）。
 * 不区分昼夜模式，始终黑底白字。
 * 眨眼：1-3 秒随机间隔，闭眼 150ms。
 *
 * 表情系统：20 种对外状态（+ 内部 blink 眨眼帧），按业务切换。
 * 外圈圆环：自顶端顺时针表示上下文 token 占用率。
 */
import {
  SESSION_PET_PALETTE_COLORS as COLORS,
  supervisorModeToEyeColor,
  buildSessionPetCanvasAriaLabel,
  SESSION_PET_DISPLAY_NAME,
} from './session-pet-palette.js';

window.IceSupervisorModeEyeColor = supervisorModeToEyeColor;

(function () {
  'use strict';

  /** 逻辑画布边长（与 CSS .pet-canvas、HTML canvas width/height 一致） */
  var PET_SIZE = 96;
  /** 版面比例：相对最初 120×120 设计稿 */
  var PET_SCALE = PET_SIZE / 120;
  var EYE_W = Math.round(14 * PET_SCALE);
  /** 胶囊眼竖向逻辑高度（非画布位置）；减小此值可缩矮眼睛形状 */
  var EYE_H = Math.round(18 * PET_SCALE);
  /** read：实心圆眼、镜框（随 PET_SCALE） */
  var READ_EYE_DIA_PX = Math.max(5, Math.round(8 * PET_SCALE));
  var READ_LENS_DIA_PX = Math.round(24 * PET_SCALE);

  var BLINK_MIN = 1000;
  var BLINK_MAX = 3000;
  var BLINK_DURATION = 150;

  var PET_BUBBLE_MAX_CHARS = 42;

  // 固定颜色：黑底；眼睛线色见 create() 闭包内 eyeColor（每实例独立）
  var BODY_BG = '#000000';
  var READ_GLASSES_STROKE = 'rgba(255,255,255,0.55)';
  var GLOW_COLOR = 'rgba(107,156,255,0.10)';

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

  function initPetDrag(rootEl, dragHandleEl) {
    if (!rootEl || !dragHandleEl) return { afterShow: function () { } };

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
  function expressionIdle(ctx, leftX, rightX, y, ec) {
    drawCapsuleEye(ctx, leftX, y, EYE_W / 2, EYE_H / 2, ec);
    drawCapsuleEye(ctx, rightX, y, EYE_W / 2, EYE_H / 2, ec);
  }

  /** 2. happy — 开心（笑眼：弧线中间上拱 ^，与 sad 的下垂弧相反） */
  function expressionHappy(ctx, leftX, rightX, y, ec) {
    var w = EYE_W / 2;
    ctx.beginPath();
    ctx.moveTo(leftX - w * 0.85, y + 1);
    ctx.quadraticCurveTo(leftX, y - 5, leftX + w * 0.85, y + 1);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(rightX - w * 0.85, y + 1);
    ctx.quadraticCurveTo(rightX, y - 5, rightX + w * 0.85, y + 1);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 3. thinking — 若有所思（略眯、视线朝左上；高光在眶左上，无跨眉线） */
  function expressionThinking(ctx, leftX, rightX, y, ec) {
    var hw = EYE_W / 2;
    var hh = EYE_H * 0.38;

    // 整体略向左，和「往左上看」一致
    var lx = leftX - 1.5;
    var rx = rightX - 1;

    drawCapsuleEye(ctx, lx, y - 2, hw - 0.5, hh, ec);
    drawCapsuleEye(ctx, rx, y - 2, hw - 0.5, hh, ec);

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
  function expressionWorking(ctx, leftX, rightX, y, timestamp, ec) {
    var t = typeof timestamp === 'number' ? timestamp : 0;
    var u = Math.sin((t / WORKING_GAZE_PERIOD_MS) * Math.PI * 2);
    var gx = u * 1.35;
    var gy = -1.15 - Math.abs(u) * 0.22;
    var lx = leftX + gx;
    var rx = rightX + gx;
    var yy = y + gy;
    var hw = EYE_W / 2 - 0.5;
    var hh = EYE_H * 0.41;
    drawCapsuleEye(ctx, lx, yy, hw, hh, ec);
    drawCapsuleEye(ctx, rx, yy, hw, hh, ec);
    ctx.fillStyle = ec;
    ctx.beginPath();
    ctx.arc(lx + 1 + u * 0.45, yy - 3.2, 1.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx - 1 + u * 0.45, yy - 3.2, 1.12, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 5. confused — 键名保留；画布与 angry 同为愤怒斜眼 */
  function expressionConfused(ctx, leftX, rightX, y, ec) {
    expressionAngry(ctx, leftX, rightX, y, ec);
  }

  /** 6. alert — 警觉（横宽椭圆眼眶 + 内上凝视点；与 surprised 中空大圆区分） */
  function expressionAlert(ctx, leftX, rightX, y, ec) {
    var lidY = y - 1;
    var rx = EYE_W / 2 + 1.2;
    var ry = EYE_H * 0.41;
    var lw = 2.35;

    ctx.beginPath();
    ctx.ellipse(leftX, lidY, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = ec;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(rightX, lidY, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = ec;
    ctx.lineWidth = lw;
    ctx.stroke();

    ctx.fillStyle = ec;
    ctx.beginPath();
    ctx.arc(leftX + 1.85, lidY - 1.35, 1.9, 0, Math.PI * 2);
    ctx.arc(rightX - 1.85, lidY - 1.35, 1.9, 0, Math.PI * 2);
    ctx.fill();

    var browLift = ry + 3;
    ctx.beginPath();
    ctx.moveTo(leftX - rx * 0.52, lidY - browLift + 2.85);
    ctx.lineTo(leftX + rx * 0.42, lidY - browLift + 1.15);
    ctx.moveTo(rightX - rx * 0.42, lidY - browLift + 1.15);
    ctx.lineTo(rightX + rx * 0.52, lidY - browLift + 2.85);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 7. anxious — 焦虑（眼睛快速眨动效果用横线表示） */
  function expressionAnxious(ctx, leftX, rightX, y, ec) {
    // 半闭眼状态
    drawBlinkLine(ctx, leftX, y - 2, EYE_W + 2, ec);
    drawBlinkLine(ctx, rightX, y - 2, EYE_W + 2, ec);
    // 下面加一条表示紧张
    drawBlinkLine(ctx, leftX, y + 4, EYE_W, ec);
    drawBlinkLine(ctx, rightX, y + 4, EYE_W, ec);
  }

  /** 8. rest — 休息（闭眼横线） */
  function expressionRest(ctx, leftX, rightX, y, ec) {
    drawBlinkLine(ctx, leftX, y, EYE_W, ec);
    drawBlinkLine(ctx, rightX, y, EYE_W, ec);
    // 加一条 Z 字形表示睡觉
    ctx.beginPath();
    ctx.moveTo(rightX + 12, y - 8);
    ctx.lineTo(rightX + 16, y - 8);
    ctx.lineTo(rightX + 14, y - 4);
    ctx.lineTo(rightX + 18, y - 4);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** 9. surprised — 惊讶（眼睛睁圆） */
  function expressionSurprised(ctx, leftX, rightX, y, ec) {
    ctx.beginPath();
    ctx.arc(leftX, y, EYE_W / 2 + 2, 0, Math.PI * 2);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rightX, y, EYE_W / 2 + 2, 0, Math.PI * 2);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  /** 10. sad — 难过（眼睛下垂） */
  function expressionSad(ctx, leftX, rightX, y, ec) {
    ctx.beginPath();
    ctx.arc(leftX, y - 4, EYE_W / 2, Math.PI * 0.2, Math.PI * 0.8, false);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rightX, y - 4, EYE_W / 2, Math.PI * 0.2, Math.PI * 0.8, false);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 10b. crying — 哭泣（>X 形皱眼 + 大泪滴 + 撇嘴，与 idle 胶囊眼明显区分） */
  function expressionCrying(ctx, leftX, rightX, y, ec) {
    var w = EYE_W / 2;
    // 皱眉 X 形眼（与 idle 竖胶囊完全不同）
    ctx.beginPath();
    ctx.moveTo(leftX - w * 0.75, y - 5);
    ctx.lineTo(leftX + w * 0.75, y + 5);
    ctx.moveTo(leftX + w * 0.75, y - 5);
    ctx.lineTo(leftX - w * 0.75, y + 5);
    ctx.moveTo(rightX - w * 0.75, y - 5);
    ctx.lineTo(rightX + w * 0.75, y + 5);
    ctx.moveTo(rightX + w * 0.75, y - 5);
    ctx.lineTo(rightX - w * 0.75, y + 5);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    // 大泪滴（高对比蓝，黑底上易辨认）
    var tearY = y + 10;
    ctx.fillStyle = 'rgba(96, 165, 250, 0.95)';
    ctx.beginPath();
    ctx.ellipse(leftX - 1, tearY, 4, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(leftX, tearY + 9, 2.8, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(rightX + 1, tearY + 1, 4, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(rightX + 1, tearY + 10, 2.8, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(leftX - 2, tearY - 2, 1.2, 0, Math.PI * 2);
    ctx.arc(rightX, tearY - 1, 1.2, 0, Math.PI * 2);
    ctx.fill();
    // 撇嘴
    var mouthY = y + 24;
    ctx.beginPath();
    ctx.moveTo(leftX - 5, mouthY);
    ctx.quadraticCurveTo((leftX + rightX) / 2, mouthY + 6, rightX + 5, mouthY);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 11. angry — 生气（眼睛斜向上） */
  function expressionAngry(ctx, leftX, rightX, y, ec) {
    ctx.beginPath();
    ctx.moveTo(leftX - EYE_W / 2, y + 4);
    ctx.lineTo(leftX + EYE_W / 2, y - 4);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rightX - EYE_W / 2, y - 4);
    ctx.lineTo(rightX + EYE_W / 2, y + 4);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 12. curious — 好奇（一大一小两眼，同一水平线、小眼相对大眼垂直居中） */
  function expressionCurious(ctx, leftX, rightX, y, ec) {
    var hwL = EYE_W / 2;
    var hhL = EYE_H / 2;
    var hwR = EYE_W / 2 - 2;
    var hhR = EYE_H / 2 - 3;
    // 共用同一 y 作为胶囊竖直中心，halfH 不同则自然上下对称扩展 → 垂直居中对齐
    drawCapsuleEye(ctx, leftX - 2, y, hwL, hhL, ec);
    drawCapsuleEye(ctx, rightX + 3, y, hwR, hhR, ec);
  }

  /** 13. dizzy — 晕（眼内小叉） */
  function drawMiniX(ctx, cx, cy, r, color) {
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r);
    ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx + r, cy - r);
    ctx.lineTo(cx - r, cy + r);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  function expressionDizzy(ctx, leftX, rightX, y, ec) {
    drawMiniX(ctx, leftX, y, 5, ec);
    drawMiniX(ctx, rightX, y, 5, ec);
  }

  /** 14. shy — 害羞（眯眼避视、腮红、略内向） */
  function expressionShy(ctx, leftX, rightX, y, ec) {
    var lx = leftX - 3;
    var rx = rightX - 3;
    var hh = EYE_H * 0.34;
    var hw = EYE_W / 2 - 1;
    drawCapsuleEye(ctx, lx, y + 1, hw, hh, ec);
    drawCapsuleEye(ctx, rx, y + 1, hw, hh, ec);
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
  function expressionLove(ctx, leftX, rightX, y, ec) {
    ctx.beginPath();
    ctx.arc(leftX, y - 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = ec;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightX, y - 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = ec;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(leftX, y + 2, 2, 0, Math.PI * 2);
    ctx.arc(rightX, y + 2, 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
  }

  /** 16. weary — 疲惫（半耷拉眼） */
  function expressionWeary(ctx, leftX, rightX, y, ec) {
    ctx.beginPath();
    ctx.arc(leftX, y + 2, EYE_W / 2, Math.PI * 0.15, Math.PI * 0.85, false);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rightX, y + 2, EYE_W / 2, Math.PI * 0.15, Math.PI * 0.85, false);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** 17. focused — 专注（竖条焦聚眼） */
  function expressionFocused(ctx, leftX, rightX, y, ec) {
    ctx.beginPath();
    ctx.moveTo(leftX, y - 10);
    ctx.lineTo(leftX, y + 10);
    ctx.moveTo(rightX, y - 10);
    ctx.lineTo(rightX, y + 10);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  /** read：白色长方镜框；上两角小圆角，下两角更大圆角（基准 READ_LENS_DIA_PX） */
  function drawReadGlasses(ctx, leftX, rightX, y) {
    var base = READ_LENS_DIA_PX / 1.8;
    var lensHalfW = base * 1.05;
    var lensHalfH = base * 0.72;
    var lensCornerRTop = Math.min(
      Math.max(1.25 * PET_SCALE, READ_LENS_DIA_PX * 0.09),
      lensHalfW * 0.38,
      lensHalfH * 0.38
    );

    function strokeLensAt(cx, cy) {
      var x = cx - lensHalfW;
      var yy = cy - lensHalfH;
      var w = lensHalfW * 2;
      var h = lensHalfH * 2;
      var rt = Math.min(lensCornerRTop, w / 2 - 0.01, h / 2 - 0.01);
      var rb = Math.min(
        Math.max(rt * 2.6, READ_LENS_DIA_PX * 0.16),
        w / 2 - 0.01,
        h - rt - 0.02
      );
      ctx.beginPath();
      ctx.moveTo(x + rt, yy);
      ctx.arcTo(x + w, yy, x + w, yy + h, rt);
      ctx.lineTo(x + w, yy + h - rb);
      ctx.arcTo(x + w, yy + h, x, yy + h, rb);
      ctx.lineTo(x + rb, yy + h);
      ctx.arcTo(x, yy + h, x, yy, rb);
      ctx.lineTo(x, yy + rt);
      ctx.arcTo(x, yy, x + w, yy, rt);
      ctx.closePath();
      ctx.stroke();
    }

    ctx.save();
    ctx.strokeStyle = READ_GLASSES_STROKE;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeLensAt(leftX, y);
    strokeLensAt(rightX, y);
    ctx.beginPath();
    ctx.moveTo(leftX + lensHalfW, y);
    ctx.lineTo(rightX - lensHalfW, y);
    ctx.stroke();
    ctx.lineWidth = 1.55;
    ctx.beginPath();
    ctx.moveTo(leftX - lensHalfW, y);
    ctx.lineTo(leftX - lensHalfW - 2, y - 20);
    ctx.moveTo(rightX + lensHalfW, y);
    ctx.lineTo(rightX + lensHalfW + 2, y - 20);
    ctx.stroke();
    ctx.restore();
  }

  /** 18. read — 直径 12px 实心圆眼；长方镜片上小圆角、下大圆角见 drawReadGlasses */
  function expressionRead(ctx, leftX, rightX, y, ec) {
    var er = READ_EYE_DIA_PX / 1.6;
    ctx.fillStyle = ec;
    ctx.beginPath();
    ctx.arc(leftX, y, er, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rightX, y, er, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 19. determined — 决绝（眉压眼） */
  function expressionDetermined(ctx, leftX, rightX, y, ec) {
    ctx.beginPath();
    ctx.moveTo(leftX - EYE_W / 2 - 2, y - 6);
    ctx.lineTo(leftX + EYE_W / 2 + 1, y - 1);
    ctx.moveTo(rightX - EYE_W / 2 - 1, y - 1);
    ctx.lineTo(rightX + EYE_W / 2 + 2, y - 6);
    ctx.strokeStyle = ec;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    drawCapsuleEye(ctx, leftX, y + 2, EYE_W / 2, EYE_H / 2 - 4, ec);
    drawCapsuleEye(ctx, rightX, y + 2, EYE_W / 2, EYE_H / 2 - 4, ec);
  }

  /** 20. playful — 俏皮（单眼眨） */
  function expressionPlayful(ctx, leftX, rightX, y, ec) {
    drawCapsuleEye(ctx, leftX, y, EYE_W / 2, EYE_H / 2, ec);
    drawBlinkLine(ctx, rightX, y, EYE_W + 2, ec);
  }

  /** blink — 眨眼（横线，内部状态） */
  function expressionBlink(ctx, leftX, rightX, y, ec) {
    drawBlinkLine(ctx, leftX, y, EYE_W, ec);
    drawBlinkLine(ctx, rightX, y, EYE_W, ec);
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
    crying: expressionCrying,
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

      var breath = state === 'working' ? 0 : Math.sin(timestamp / 800) * 1.5;
      var scale = 1;
      if (state === 'happy') scale *= 1.02;
      if (state === 'playful') scale *= 1 + Math.sin(timestamp / 350) * 0.012;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);

      var bodyY = cy + breath;

      // 外圈光晕
      ctx.beginPath();
      ctx.arc(cx, bodyY, PET_SIZE / 2 - 4, 0, Math.PI * 2);
      ctx.fillStyle = GLOW_COLOR;
      ctx.fill();

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

      if (isBlinking) {
        if (state === 'read') {
          drawBlinkLine(ctx, eyeXL, eyeYL, READ_EYE_DIA_PX, eyeColor);
          drawBlinkLine(ctx, eyeXR, eyeYR, READ_EYE_DIA_PX, eyeColor);
        } else {
          expressionBlink(ctx, eyeXL, eyeXR, eyeYL, eyeColor);
        }
      } else if (state === 'working') {
        expressionWorking(ctx, eyeXL, eyeXR, eyeYL, timestamp, eyeColor);
      } else {
        var exprFn = EXPRESSIONS[state] || expressionIdle;
        exprFn(ctx, eyeXL, eyeXR, eyeYL, eyeColor);
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
        case 'crying':
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
        if (state === 'crying') {
          isBlinking = false;
          blinkTimer = setTimeout(nextBlink, BLINK_MAX);
          return;
        }
        var delay = BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
        blinkTimer = setTimeout(function () {
          if (state === 'crying') {
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

    function setState(s) {
      state = s || 'idle';
      if (canvas) {
        canvas.classList.remove('pet-wobble', 'pet-crying');
        if (state === 'crying') canvas.classList.add('pet-crying');
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
