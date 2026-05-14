/**
 * Execution Transparency Layer 的运行时开关。
 *
 * 设计文档：docs/execution-transparency-layer.md §Feature Flag
 *
 * 默认关闭，保持现有 Harness 行为零变化。
 */

/**
 * 检测是否启用 Execution Plan（执行透明层）。
 *
 * 硬编码为 true，不再通过环境变量控制。
 */
export function isExecutionPlanEnabled(): boolean {
  return true;
}
