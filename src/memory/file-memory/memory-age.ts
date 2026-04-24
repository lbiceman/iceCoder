/**
 * 记忆新鲜度追踪。
 *
 * 模型不擅长日期计算，"47 天前"比 ISO 时间戳更能触发过时推理。
 * 对于超过 1 天的记忆，附加新鲜度警告，提醒模型验证后再引用。
 */

/**
 * 计算记忆的年龄（天数）。
 * 向下取整 — 0 表示今天，1 表示昨天，2+ 表示更早。
 * 负值（未来时间戳、时钟偏差）截断为 0。
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

/**
 * 人类可读的年龄字符串。
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  return `${d} 天前`;
}

/**
 * 记忆新鲜度警告文本。
 * 超过 1 天的记忆返回警告，提醒模型验证后再引用。
 * 今天/昨天的记忆返回空字符串（无需警告）。
 *
 * 动机：用户反馈中发现，过时的代码状态记忆（文件:行号引用）
 * 被模型当作事实断言 — 引用反而让过时信息看起来更权威。
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= 1) return '';
  return (
    `这条记忆已有 ${d} 天。` +
    `记忆是时间点的观察，不是实时状态 — ` +
    `关于代码行为或文件:行号的引用可能已过时。` +
    `在断言为事实之前，请对照当前代码验证。`
  );
}

/**
 * 带 <system-reminder> 标签的新鲜度提醒。
 * 超过 1 天的记忆返回提醒，否则返回空字符串。
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs);
  if (!text) return '';
  return `<system-reminder>${text}</system-reminder>\n`;
}
