/** 压缩 / 主动收缩 / emergency fork 后记录缓存分段边界（阶段 3 观测）。 */
export function logCacheSegmentReset(round?: number, reason?: string): void {
  const roundPart = round != null ? ` round=${round}` : '';
  const reasonPart = reason ? ` reason=${reason}` : '';
  console.log(`[cache-segment] reset${roundPart}${reasonPart}`);
}
