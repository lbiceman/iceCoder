/** Harness 策略拦截 / 恢复统计（telemetry summary 与 benchmark 可读）。 */
export interface HarnessPolicyStats {
  policyBlockCount: number;
  missingFileBlockCount: number;
  enoentExecutionCount: number;
  rebuildEscalationCount: number;
  writeBypassUsedCount: number;
  /** BranchBudget 文件 cap 拦截按路径聚合（canonical POSIX 相对路径） */
  budgetBlockByPath: Record<string, number>;
}

export function emptyHarnessPolicyStats(): HarnessPolicyStats {
  return {
    policyBlockCount: 0,
    missingFileBlockCount: 0,
    enoentExecutionCount: 0,
    rebuildEscalationCount: 0,
    writeBypassUsedCount: 0,
    budgetBlockByPath: {},
  };
}

export function recordBudgetBlockByPath(
  stats: HarnessPolicyStats | undefined,
  path: string | undefined,
): void {
  if (!stats || !path) return;
  stats.budgetBlockByPath[path] = (stats.budgetBlockByPath[path] ?? 0) + 1;
}
