/**
 * Harness 候选表情：用冰豆同一套 Canvas 线稿画 NOMI 风格道具，带 rAF 动画。
 * 绘制签名与现有表情一致：
 *   (ctx, leftX, rightX, y, eyeColor, timestamp, blinking)
 * 聊天页经 chat-pet-bridge 映射 harness step → 这些 state。
 */

var PET_SCALE = 96 / 120;
var blinkNow = false;

function ts(timestamp) {
  return typeof timestamp === 'number' && isFinite(timestamp) ? timestamp : 0;
}

function wrapExpr(fn) {
  return function (ctx, leftX, rightX, y, ec, timestamp, blinking, extra) {
    blinkNow = !!blinking;
    try {
      fn(ctx, leftX, rightX, y, ec, timestamp, extra);
    } finally {
      blinkNow = false;
    }
  };
}

function drawClosedEyes(ctx, leftX, rightX, y, ec) {
  var w = 11 * PET_SCALE;
  strokeSetup(ctx, ec, 2.4);
  ctx.beginPath();
  ctx.moveTo(leftX - w / 2, y);
  ctx.lineTo(leftX + w / 2, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rightX - w / 2, y);
  ctx.lineTo(rightX + w / 2, y);
  ctx.stroke();
}

function strokeSetup(ctx, ec, width) {
  ctx.strokeStyle = ec;
  ctx.fillStyle = ec;
  ctx.lineWidth = width == null ? 2.2 * PET_SCALE : width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

/** NOMI 标志性 ∩∩ 笑眼；眨眼时只换成横线，道具仍由表情函数绘制 */
function drawNomiEyes(ctx, leftX, rightX, y, ec) {
  if (blinkNow) {
    drawClosedEyes(ctx, leftX, rightX, y, ec);
    return;
  }
  var r = 6.2 * PET_SCALE;
  strokeSetup(ctx, ec, 2.4);
  ctx.beginPath();
  ctx.arc(leftX, y + 3.2, r, Math.PI, 0, true);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rightX, y + 3.2, r, Math.PI, 0, true);
  ctx.stroke();
}

function drawOvalEyes(ctx, leftX, rightX, y, ec, rx, ry) {
  if (blinkNow) {
    drawClosedEyes(ctx, leftX, rightX, y, ec);
    return;
  }
  strokeSetup(ctx, ec, 2.3);
  ctx.beginPath();
  ctx.ellipse(leftX, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(rightX, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawHCapsuleEyes(ctx, leftX, rightX, y, ec) {
  if (blinkNow) {
    drawClosedEyes(ctx, leftX, rightX, y, ec);
    return;
  }
  var hw = 6.5 * PET_SCALE;
  var hh = 3.2 * PET_SCALE;
  strokeSetup(ctx, ec, 2.3);
  ctx.beginPath();
  ctx.ellipse(leftX, y, hw, hh, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(rightX, y, hw, hh, 0, 0, Math.PI * 2);
  ctx.stroke();
}

/** 简笔小手（手掌 + 三指） */
function drawHand(ctx, x, y, rot, scale, ec) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  strokeSetup(ctx, ec, 1.85);
  ctx.beginPath();
  ctx.ellipse(0, 2.2, 4.4, 3.3, 0, 0, Math.PI * 2);
  ctx.stroke();
  for (var i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 2.1, -0.2);
    ctx.quadraticCurveTo(i * 2.5, -5.6, i * 1.5, -7.4);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHeart(ctx, x, y, s, ec, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.globalAlpha = alpha == null ? 1 : alpha;
  ctx.fillStyle = '#FC5A76';
  ctx.beginPath();
  ctx.moveTo(0, 3.2);
  ctx.bezierCurveTo(-5.5, -1.2, -3.2, -5.4, 0, -2.6);
  ctx.bezierCurveTo(3.2, -5.4, 5.5, -1.2, 0, 3.2);
  ctx.fill();
  ctx.restore();
}

function drawPeaceSign(ctx, x, y, rot, scale, ec) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  strokeSetup(ctx, ec, 1.85);
  ctx.beginPath();
  ctx.ellipse(0, 3.4, 3.6, 2.8, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-1.4, 0.6);
  ctx.lineTo(-2.6, -8.2);
  ctx.moveTo(1.4, 0.6);
  ctx.lineTo(2.8, -8.4);
  ctx.stroke();
  ctx.restore();
}

function drawSleepZ(ctx, x, y, t, ec) {
  var rise = (t / 18) % 16;
  ctx.save();
  ctx.globalAlpha = Math.max(0.2, 1 - rise / 16);
  strokeSetup(ctx, ec, 1.5);
  ctx.beginPath();
  ctx.moveTo(x, y - rise);
  ctx.lineTo(x + 5, y - rise);
  ctx.lineTo(x, y - rise + 4);
  ctx.lineTo(x + 5, y - rise + 4);
  ctx.stroke();
  ctx.restore();
}

/** idle 子动作：安静 / 张望 / 打盹 / 短招手 / 比耶 */
function expressionIdleRest(ctx, leftX, rightX, y, ec) {
  drawNomiEyes(ctx, leftX, rightX, y, ec);
}

function expressionIdleGlance(ctx, leftX, rightX, y, ec, dir) {
  var d = dir >= 0 ? 1 : -1;
  drawOvalEyes(ctx, leftX + d * 2.2, rightX + d * 2.2, y, ec, 4.1 * PET_SCALE, 6.1 * PET_SCALE);
}

function expressionIdleDoze(ctx, leftX, rightX, y, ec, timestamp) {
  drawClosedEyes(ctx, leftX, rightX, y + 1.5, ec);
  drawSleepZ(ctx, rightX + 8, y - 6, ts(timestamp), ec);
}

function expressionIdleWave(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  drawNomiEyes(ctx, leftX, rightX, y, ec);
  var wag = Math.sin(t / 160) * 0.55;
  drawHand(ctx, leftX - 11, y + 20, -0.55 + wag, 1, ec);
}

function expressionIdlePeace(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  drawNomiEyes(ctx, leftX, rightX, y, ec);
  var bob = Math.sin(t / 280) * 0.12;
  drawPeaceSign(ctx, rightX + 10, y + 16, 0.35 + bob, 0.95, ec);
}

function expressionIdle(ctx, leftX, rightX, y, ec, timestamp, extra) {
  var pose = extra && extra.pose ? extra.pose : 'rest';
  var dir = extra && extra.dir < 0 ? -1 : 1;
  if (pose === 'glance') {
    expressionIdleGlance(ctx, leftX, rightX, y, ec, dir);
    return;
  }
  if (pose === 'doze') {
    expressionIdleDoze(ctx, leftX, rightX, y, ec, timestamp);
    return;
  }
  if (pose === 'wave') {
    expressionIdleWave(ctx, leftX, rightX, y, ec, timestamp);
    return;
  }
  if (pose === 'peace') {
    expressionIdlePeace(ctx, leftX, rightX, y, ec, timestamp);
    return;
  }
  expressionIdleRest(ctx, leftX, rightX, y, ec);
}

export var IDLE_POSES = ['rest', 'glance', 'doze', 'wave', 'peace'];

export function idlePoseHoldMs(pose) {
  if (pose === 'wave') return 1600 + Math.random() * 1400;
  if (pose === 'peace') return 2200 + Math.random() * 1600;
  if (pose === 'glance') return 1800 + Math.random() * 2200;
  if (pose === 'doze') return 4200 + Math.random() * 3800;
  return 3800 + Math.random() * 5200;
}

/** 兼容旧名：招手仅作 idle 子动作 */
function expressionWave(ctx, leftX, rightX, y, ec, timestamp) {
  expressionIdleWave(ctx, leftX, rightX, y, ec, timestamp);
}

/** planning：托腮 + 小任务图，只用于真正在规划 */
function expressionPlanning(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  var bob = Math.sin(t / 520) * 1.2;
  drawNomiEyes(ctx, leftX, rightX, y + bob * 0.3, ec);
  drawHand(ctx, leftX - 2, y + 18 + bob, 0.55, 0.92, ec);
  drawHand(ctx, rightX + 2, y + 18 + bob, -0.55, 0.92, ec);
  var gx = rightX + 13;
  var gy = y - 8 + bob;
  strokeSetup(ctx, ec, 1.45);
  ctx.globalAlpha = 0.82;
  ctx.beginPath();
  ctx.arc(gx, gy, 2.1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(gx + 8, gy + 7, 2.1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(gx - 3, gy + 11, 2.1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(gx + 1.5, gy + 1.5);
  ctx.lineTo(gx + 6.4, gy + 5.4);
  ctx.moveTo(gx, gy + 2.1);
  ctx.lineTo(gx - 1.8, gy + 9);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** running：处理中 — 横线速度感，一眼忙碌 */
function expressionRunning(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  var shift = (t / 70) % 8;
  strokeSetup(ctx, ec, 1.7);
  ctx.globalAlpha = 0.85;
  for (var i = 0; i < 5; i++) {
    var yy = y - 10 + i * 5;
    var len = 6 + (i % 2) * 3;
    var x0 = leftX - 20 + (shift + i * 2) % 8;
    ctx.beginPath();
    ctx.moveTo(x0, yy);
    ctx.lineTo(x0 + len, yy);
    ctx.stroke();
    var x1 = rightX + 12 - (shift + i * 2) % 8;
    ctx.beginPath();
    ctx.moveTo(x1, yy);
    ctx.lineTo(x1 + len, yy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  drawHCapsuleEyes(ctx, leftX, rightX, y, ec);
}

/** executing / tool_calling：一只手握住扳手柄拧 */
function expressionToolCalling(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  var swing = Math.sin(t / 130) * 0.55;

  drawOvalEyes(ctx, leftX, rightX, y, ec, 4.6 * PET_SCALE, 6.4 * PET_SCALE);
  if (!blinkNow) {
    ctx.fillStyle = ec;
    ctx.beginPath();
    ctx.arc(leftX + 1.8, y + 1.6, 1.55, 0, Math.PI * 2);
    ctx.arc(rightX + 1.8, y + 1.6, 1.55, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.save();
  ctx.translate((leftX + rightX) / 2 + 1, y + 15);
  ctx.rotate(-0.95 + swing);

  strokeSetup(ctx, ec, 2.35);
  ctx.beginPath();
  ctx.moveTo(0, -3);
  ctx.lineTo(0, 18);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -8.2, 5.6, 0.42, Math.PI - 0.42, false);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-4.6, -5.4);
  ctx.lineTo(-1.7, -2.8);
  ctx.moveTo(4.6, -5.4);
  ctx.lineTo(1.7, -2.8);
  ctx.stroke();

  drawHand(ctx, 0.2, 8, 0.06, 0.94, ec);

  if (Math.abs(swing) > 0.38) {
    ctx.globalAlpha = (Math.abs(swing) - 0.38) / 0.17;
    strokeSetup(ctx, ec, 1.6);
    ctx.beginPath();
    ctx.moveTo(0, -15);
    ctx.lineTo(0, -9);
    ctx.moveTo(-3.2, -12);
    ctx.lineTo(3.2, -12);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/** streaming：麦克风 + 音符上浮 */
function expressionStreaming(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  drawNomiEyes(ctx, leftX, rightX, y - 1, ec);
  var bob = Math.sin(t / 180) * 1.4;
  ctx.save();
  ctx.translate(leftX - 8, y + 16 + bob);
  ctx.rotate(-0.55);
  strokeSetup(ctx, ec, 1.9);
  ctx.beginPath();
  ctx.ellipse(0, -6.5, 3.1, 4.6, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -1.4);
  ctx.lineTo(0, 6.2);
  ctx.moveTo(-3.2, 6.2);
  ctx.lineTo(3.2, 6.2);
  ctx.stroke();
  ctx.restore();

  for (var n = 0; n < 3; n++) {
    var phase = (t / 18 + n * 18) % 42;
    var nx = rightX + 4 + n * 5;
    var ny = y + 10 - phase;
    var alpha = Math.max(0, 1 - phase / 42);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ec;
    ctx.strokeStyle = ec;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(nx, ny, 2.1, 1.5, -0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(nx + 1.8, ny);
    ctx.lineTo(nx + 1.8, ny - 7);
    ctx.stroke();
    ctx.restore();
  }
}

/** recovering：指尖陀螺旋转 */
function expressionRecovering(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  drawNomiEyes(ctx, leftX, rightX, y - 3, ec);
  var cx = (leftX + rightX) / 2;
  var cy = y + 18;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t / 160);
  strokeSetup(ctx, ec, 1.85);
  for (var i = 0; i < 3; i++) {
    var a = (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 7.2, Math.sin(a) * 7.2, 3.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, 1.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** restoring：折叠地图展开 */
function expressionRestoring(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  drawNomiEyes(ctx, leftX, rightX, y - 4, ec);
  var cx = (leftX + rightX) / 2;
  var cy = y + 18;
  var open = 10 + Math.sin(t / 340) * 3.2;
  strokeSetup(ctx, ec, 1.9);
  ctx.beginPath();
  ctx.moveTo(cx - open, cy - 6);
  ctx.lineTo(cx - open * 0.35, cy + 7);
  ctx.lineTo(cx, cy - 5);
  ctx.lineTo(cx + open * 0.35, cy + 7);
  ctx.lineTo(cx + open, cy - 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - open, cy - 7.5, 2.1, Math.PI, 0, false);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + open, cy - 7.5, 2.1, Math.PI, 0, false);
  ctx.stroke();
}

/** cancelling：耷拉眼 + 平嘴 */
function expressionCancelling(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  var droop = 1.2 + Math.sin(t / 700) * 1.1;
  var yy = y + droop;
  if (blinkNow) {
    drawClosedEyes(ctx, leftX, rightX, yy, ec);
  } else {
    strokeSetup(ctx, ec, 2.3);
    ctx.beginPath();
    ctx.ellipse(leftX - 1, yy - 2, 4.6, 3.6, 0.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(rightX + 1, yy - 2, 4.6, 3.6, -0.35, 0, Math.PI * 2);
    ctx.stroke();
  }
  strokeSetup(ctx, ec, 2.3);
  ctx.beginPath();
  ctx.moveTo(leftX + 2, yy + 11);
  ctx.lineTo(rightX - 2, yy + 11);
  ctx.moveTo(leftX + 6, yy + 15);
  ctx.lineTo(rightX - 6, yy + 15);
  ctx.stroke();
}

/** 完成：睁眼鼓掌，避免和托腮/打盹撞脸 */
function expressionClap(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  drawOvalEyes(ctx, leftX, rightX, y - 2, ec, 4.2 * PET_SCALE, 6.0 * PET_SCALE);
  var g = Math.abs(Math.sin(t / 130));
  var gap = 10 - g * 7;
  var cx = (leftX + rightX) / 2;
  drawHand(ctx, cx - gap, y + 18, 0.7, 0.88, ec);
  drawHand(ctx, cx + gap, y + 18, -0.7, 0.88, ec);
  if (g > 0.78) {
    strokeSetup(ctx, ec, 1.5);
    ctx.beginPath();
    ctx.moveTo(cx - 3, y + 8);
    ctx.lineTo(cx - 7, y + 4);
    ctx.moveTo(cx + 3, y + 8);
    ctx.lineTo(cx + 7, y + 4);
    ctx.stroke();
    drawHeart(ctx, rightX + 8, y - 4, 0.7, ec, (g - 0.78) / 0.22);
  }
}

function drawSpark(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x, y + s);
  ctx.moveTo(x - s, y);
  ctx.lineTo(x + s, y);
  ctx.moveTo(x - s * 0.65, y - s * 0.65);
  ctx.lineTo(x + s * 0.65, y + s * 0.65);
  ctx.moveTo(x - s * 0.65, y + s * 0.65);
  ctx.lineTo(x + s * 0.65, y - s * 0.65);
  ctx.stroke();
}

/** memory：记忆注入 — 睁眼接收，星点从外侧吸入头顶 */
function expressionMemory(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  drawOvalEyes(ctx, leftX, rightX, y, ec, 4.4 * PET_SCALE, 6.2 * PET_SCALE);
  var cx = (leftX + rightX) / 2;
  var pulse = 0.5 + 0.5 * Math.sin(t / 180);
  strokeSetup(ctx, ec, 1.75);
  ctx.globalAlpha = 0.4 + 0.5 * pulse;
  ctx.beginPath();
  ctx.moveTo(cx - 5.5, y - 17);
  ctx.lineTo(cx, y - 11.5);
  ctx.lineTo(cx + 5.5, y - 17);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 5.5, y - 13);
  ctx.lineTo(cx, y - 7.5);
  ctx.lineTo(cx + 5.5, y - 13);
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (var i = 0; i < 6; i++) {
    var phase = (t / 420 + i / 6) % 1;
    var x = cx + 20 - phase * 34;
    var yy = y - 2 + Math.sin((phase * 2 + i) * Math.PI) * 9;
    ctx.save();
    ctx.globalAlpha = 0.22 + 0.78 * (1 - phase);
    strokeSetup(ctx, ec, 1.5);
    drawSpark(ctx, x, yy, 2.1 + (1 - phase) * 1.5);
    ctx.restore();
  }
}

/** 出错：挑眉 */
function expressionErrorBrow(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  var shake = Math.sin(t / 70) * 0.8;
  drawOvalEyes(ctx, leftX + shake, rightX + shake, y, ec, 4.4 * PET_SCALE, 6.2 * PET_SCALE);
  strokeSetup(ctx, ec, 2.3);
  ctx.beginPath();
  ctx.moveTo(rightX - 2 + shake, y - 12);
  ctx.lineTo(rightX + 9 + shake, y - 8);
  ctx.stroke();
}

/** 待确认：捂嘴害羞 */
function expressionToolConfirm(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  var bob = Math.sin(t / 260) * 0.8;
  drawNomiEyes(ctx, leftX, rightX, y + bob, ec);
  ctx.fillStyle = 'rgba(255, 130, 160, 0.42)';
  ctx.beginPath();
  ctx.ellipse(leftX - 9, y + 12 + bob, 5.5, 3.4, 0, 0, Math.PI * 2);
  ctx.ellipse(rightX + 9, y + 12 + bob, 5.5, 3.4, 0, 0, Math.PI * 2);
  ctx.fill();
  drawHand(ctx, (leftX + rightX) / 2, y + 16 + bob, 0.05 + Math.sin(t / 200) * 0.08, 0.86, ec);
}

/** 请接管：格旗摇动 */
function expressionUserCheckpoint(ctx, leftX, rightX, y, ec, timestamp) {
  var t = ts(timestamp);
  drawOvalEyes(ctx, leftX, rightX, y - 2, ec, 4.2 * PET_SCALE, 6.4 * PET_SCALE);
  var wag = Math.sin(t / 180) * 0.28;
  ctx.save();
  ctx.translate(leftX - 10, y + 14);
  ctx.rotate(-0.35 + wag);
  strokeSetup(ctx, ec, 1.7);
  ctx.beginPath();
  ctx.moveTo(0, 8);
  ctx.lineTo(0, -11);
  ctx.stroke();
  var s = 4;
  for (var r = 0; r < 2; r++) {
    for (var c = 0; c < 2; c++) {
      if ((r + c) % 2 === 0) {
        ctx.fillRect(1.2 + c * s, -11 + r * s, s, s);
      } else {
        ctx.strokeRect(1.2 + c * s, -11 + r * s, s, s);
      }
    }
  }
  ctx.restore();
}

var toolUseExpr = wrapExpr(expressionToolCalling);

export var HARNESS_PET_EXPRESSIONS = {
  idle: wrapExpr(expressionIdle),
  planning: wrapExpr(expressionPlanning),
  running: wrapExpr(expressionRunning),
  executing: toolUseExpr,
  streaming: wrapExpr(expressionStreaming),
  tool_calling: toolUseExpr,
  recovering: wrapExpr(expressionRecovering),
  restoring: wrapExpr(expressionRestoring),
  cancelling: wrapExpr(expressionCancelling),
  memory: wrapExpr(expressionMemory),
  clap: wrapExpr(expressionClap),
  error: wrapExpr(expressionErrorBrow),
  tool_confirm: wrapExpr(expressionToolConfirm),
  user_checkpoint: wrapExpr(expressionUserCheckpoint),
};

/** 这些态自己有持续动画，眨眼会打断道具 */
export var HARNESS_PET_SKIP_BLINK = {
  running: 1,
  executing: 1,
  streaming: 1,
  tool_calling: 1,
  recovering: 1,
  restoring: 1,
  memory: 1,
  clap: 1,
  user_checkpoint: 1,
};

export var HARNESS_PET_SKIP_BREATH = {
  running: 1,
  executing: 1,
  tool_calling: 1,
  recovering: 1,
};

export var HARNESS_PET_DEMO = [
  { state: 'idle', title: '空闲', why: '随机休息 / 张望 / 打盹 / 招手 / 比耶' },
  { state: 'planning', title: '规划', why: '托腮 + 任务图' },
  { state: 'running', title: '处理中', why: '两侧速度线，忙碌运转' },
  { state: 'executing', title: '执行', why: '与调工具同一表情' },
  { state: 'streaming', title: '流式输出', why: '开口写回复' },
  { state: 'tool_calling', title: '调工具', why: '一只手拧扳手' },
  { state: 'recovering', title: '恢复中', why: '陀螺转圈等待' },
  { state: 'restoring', title: '回滚恢复', why: '地图展开上下文' },
  { state: 'cancelling', title: '取消中', why: '耷拉眼收束' },
];

export var HARNESS_PET_DEMO_EXTRAS = [
  { state: 'memory', title: '记忆注入', why: '星点吸入，并入提示' },
  { state: 'clap', title: '完成', why: '鼓掌（model_done）' },
  { state: 'error', title: '出错', why: '挑眉（工具失败）' },
  { state: 'tool_confirm', title: '待确认', why: '捂嘴等你点' },
  { state: 'user_checkpoint', title: '请接管', why: '格旗，监管暂停' },
];
