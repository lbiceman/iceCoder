/** Harness 策略拦截 / 恢复统计（telemetry summary 与 benchmark 可读）。 */
export interface HarnessPolicyStats {
  policyBlockCount: number;
  missingFileBlockCount: number;
  enoentExecutionCount: number;
  rebuildEscalationCount: number;
  writeBypassUsedCount: number;
}

export function emptyHarnessPolicyStats(): HarnessPolicyStats {
  return {
    policyBlockCount: 0,
    missingFileBlockCount: 0,
    enoentExecutionCount: 0,
    rebuildEscalationCount: 0,
    writeBypassUsedCount: 0,
  };
}
