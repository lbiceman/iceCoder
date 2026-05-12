/**
 * 会话宠物色板与 token 下标工具（浏览器与 Vitest 共用，ESM）
 * 圆环进度用 token 百分比；眼睛颜色由启动时 pickRandomPaletteColor 决定。
 */

/** 装饰用眼各色色板（启动随机挑一种，与 token 无关） */
export const SESSION_PET_PALETTE_COLORS = [
  '#FFFFFF',
  '#FCD7E4',
  '#88EDC7',
  '#B8FCC8',
  '#A7CBFD',
  '#06BCFD',
  '#F1A8B2',
  '#D193D1',
];

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
    '外圈圆环自顶端顺时针延伸，表示上下文占用比例。眼睛颜色为加载时随机选取的装饰色，与占用无关。';
  var usage =
    '当前约 ' +
    o.tokenPct +
    '%' +
    (o.tokenMax ? '（' + o.tokenUsedLabel + '/' + o.tokenMaxLabel + '）' : '') +
    '。本轮输出 ' +
    o.outputLabel +
    '。';
  return '会话状态宠物。' + ring + ' ' + usage;
}
