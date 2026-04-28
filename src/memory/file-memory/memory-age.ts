/**
 * 记忆新鲜度追踪与过期衰减。
 *
 * 模型不擅长日期计算，"47 天前"比 ISO 时间戳更能触发过时推理。
 * 对于超过 1 天的记忆，附加新鲜度警告，提醒模型验证后再引用。
 *
 * 过期策略：
 * - 超过 90 天未被召回的记忆标记为"陈旧"
 * - 超过 180 天未被召回的记忆标记为"过期"，Dream 整合时可清理
 * - 高置信度记忆（用户明确声明）衰减更慢
 */

import type { MemoryHeader } from './types.js';

/** 陈旧阈值（天） */
const STALE_THRESHOLD_DAYS = 90;
/** 过期阈值（天） */
const EXPIRED_THRESHOLD_DAYS = 180;

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

/**
 * 记忆衰减状态。
 */
export type MemoryDecayStatus = 'fresh' | 'stale' | 'expired';

/**
 * 计算记忆的衰减状态。
 *
 * 基于"最后活跃时间"（lastRecalledMs 或 mtimeMs 取较大值）和置信度：
 * - 高置信度（>=0.8）记忆的衰减阈值翻倍（用户明确声明的偏好不容易过时）
 * - 从未被召回的记忆衰减更快
 */
export function getMemoryDecayStatus(memory: MemoryHeader): MemoryDecayStatus {
  const lastActiveMs = Math.max(memory.lastRecalledMs || 0, memory.mtimeMs);
  const daysSinceActive = Math.max(0, Math.floor((Date.now() - lastActiveMs) / 86_400_000));

  // 高置信度记忆衰减更慢
  const confidenceMultiplier = (memory.confidence || 0.5) >= 0.8 ? 2 : 1;
  const staleThreshold = STALE_THRESHOLD_DAYS * confidenceMultiplier;
  const expiredThreshold = EXPIRED_THRESHOLD_DAYS * confidenceMultiplier;

  if (daysSinceActive >= expiredThreshold) return 'expired';
  if (daysSinceActive >= staleThreshold) return 'stale';
  return 'fresh';
}

/**
 * 从记忆列表中筛选出过期的记忆（供 Dream 整合时清理）。
 */
export function getExpiredMemories(memories: MemoryHeader[]): MemoryHeader[] {
  return memories.filter(m => getMemoryDecayStatus(m) === 'expired');
}

/**
 * 从记忆列表中筛选出陈旧的记忆（供 Dream 整合时提醒）。
 */
export function getStaleMemories(memories: MemoryHeader[]): MemoryHeader[] {
  return memories.filter(m => getMemoryDecayStatus(m) === 'stale');
}

/**
 * 计算记忆的召回权重衰减因子（0-1）。
 * 用于召回排序时降低陈旧记忆的优先级。
 */
export function memoryDecayFactor(memory: MemoryHeader): number {
  const status = getMemoryDecayStatus(memory);
  switch (status) {
    case 'fresh': return 1.0;
    case 'stale': return 0.5;
    case 'expired': return 0.1;
  }
}
