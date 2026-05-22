/**
 * 冰豆（Ice Bean）色板与 token 下标工具（浏览器与 Vitest 共用，ESM）
 * 圆环进度用 token 百分比；眼睛颜色对应 supervisorMode 三档（off / adaptive / strict）。
 */

/** 会话指示器在用户界面中的显示名称（无障碍与文案统一入口） */
export const SESSION_PET_DISPLAY_NAME = '冰豆';

/** 与 SUPERVISOR_MODE_EYE_ORDER 一一对应：自由 / 自适应 / 严格 */
export const SESSION_PET_PALETTE_COLORS = [
  '#88EDC7',
  '#86E0FF',
  '#F1A8B2',
];

/** 眼睛色与 config.json supervisorMode 的固定顺序 */
export const SUPERVISOR_MODE_EYE_ORDER = ['off', 'adaptive', 'strict'];

const DEFAULT_FALLBACK = '#FCD7E4';

/**
 * @param {number} pct 0…100
 * @param {number} colorCount
 * @returns {number} 0…colorCount-1
 */
export function tokenPercentToPaletteIndex(pct, colorCount) {
  var n = colorCount;
  if (n <= 0) return 0;
  if (n === 1) return 0;
  var p = Math.max(0, Math.min(100, Number(pct) || 0));
  return Math.min(n - 1, Math.floor((p / 100) * n));
}

/**
 * @param {number} pct
 * @param {string[]} [colors]
 * @returns {string}
 */
export function eyeColorForTokenPct(pct, colors) {
  if (Array.isArray(colors) && colors.length === 0) return DEFAULT_FALLBACK;
  var arr = colors && colors.length > 0 ? colors : SESSION_PET_PALETTE_COLORS;
  if (!arr.length) return DEFAULT_FALLBACK;
  if (arr.length === 1) return arr[0];
  var idx = tokenPercentToPaletteIndex(pct, arr.length);
  return arr[idx];
}

/**
 * @param {'off'|'adaptive'|'strict'|string} mode
 * @param {string[]} [colors]
 * @returns {string}
 */
export function supervisorModeToEyeColor(mode, colors) {
  var arr = colors && colors.length > 0 ? colors : SESSION_PET_PALETTE_COLORS;
  if (!arr.length) return DEFAULT_FALLBACK;
  var idx = SUPERVISOR_MODE_EYE_ORDER.indexOf(mode);
  if (idx < 0) idx = SUPERVISOR_MODE_EYE_ORDER.indexOf('adaptive');
  if (idx < 0) idx = 0;
  return arr[Math.min(idx, arr.length - 1)] || DEFAULT_FALLBACK;
}

/**
 * @param {string[]} [colors]
 * @returns {string}
 */
export function pickRandomPaletteColor(colors) {
  var arr = colors && colors.length > 0 ? colors : SESSION_PET_PALETTE_COLORS;
  if (!arr.length) return DEFAULT_FALLBACK;
  var i = Math.floor(Math.random() * arr.length);
  return arr[i];
}

/**
 * @param {object} o
 * @param {number} o.tokenPct
 * @param {number} o.tokenUsed
 * @param {number} o.tokenMax
 * @param {number} o.tokenOutput
 * @param {string} o.tokenUsedLabel
 * @param {string} o.tokenMaxLabel
 * @param {string} o.outputLabel
 */
export function buildSessionPetCanvasAriaLabel(o) {
  var ring =
    '外圈圆环自顶端顺时针延伸，表示上下文占用比例。眼睛颜色对应当前监管模式（自由/自适应/严格）。';
  var usage =
    '当前约 ' +
    o.tokenPct +
    '%' +
    (o.tokenMax ? '（' + o.tokenUsedLabel + '/' + o.tokenMaxLabel + '）' : '') +
    '。本轮输出 ' +
    o.outputLabel +
    '。';
  return SESSION_PET_DISPLAY_NAME + '。' + ring + ' ' + usage;
}
