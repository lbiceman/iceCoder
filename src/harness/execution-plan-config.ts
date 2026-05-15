/**
 * Execution Transparency Layer — 运行时开关占位。
 *
 * 设计文档：docs/execution-transparency-layer.md
 *
 * 当前版本：**始终启用** ETL；历史上曾计划用环境变量控制，已移除。
 */

/**
 * 检测是否启用 Execution Plan（执行透明层）。
 *
 * 硬编码为 `true`，不读取 `ICE_ENABLE_EXECUTION_PLAN` 等环境变量。
 */
export function isExecutionPlanEnabled(): boolean {
  return true;
}
