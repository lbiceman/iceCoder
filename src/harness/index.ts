/**
 * Harness 模块入口。
 * 导出 Harness 核心循环及其所有子组件。
 *
 * 模块组成：
 * - Harness: 核心循环引擎
 * - ContextAssembler: 上下文组装器
 * - LoopController: 循环控制器
 * - PermissionManager: 权限管理器
 * - ContextCompactor: 上下文压缩器
 * - HarnessLogger: 结构化日志器
 * - StopHookManager: 停止钩子管理器
 * - TokenBudgetTracker: Token 预算追踪器
 * - StreamingToolExecutor: 流式工具执行器
 */

export { Harness } from './harness.js';
export { ContextAssembler, normalizeMessages } from './context-assembler.js';
export { LoopController } from './loop-controller.js';
export { PermissionManager } from './permission.js';
export { ContextCompactor, estimateTokens } from './context-compactor.js';
export {
  readEffectiveContextWindowTokens,
  getContextWindowTier,
  tierFromMaxContextTokens,
  CONTEXT_TIER_S_MAX,
  CONTEXT_TIER_M_MAX,
  CONTEXT_TIER_L_MAX,
  DEFAULT_EFFECTIVE_CONTEXT_WINDOW,
} from './context-window-tier.js';
export type { ContextWindowTier } from './context-window-tier.js';
export { HarnessLogger, type LlmRoundLogMeta, type LlmRoundTokenUsage } from './logger.js';
export { StopHookManager } from './stop-hooks.js';
export { TokenBudgetTracker } from './token-budget.js';
export { StreamingToolExecutor } from './streaming-tool-executor.js';

export type {
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  MemoryStepKind,
  ChatFunction,
  StreamFunction,
  ContextAssemblyConfig,
  LoopControlConfig,
  LoopState,
  StopReason,
  ToolPermission,
  ToolPermissionRule,
  PermissionCheckResult,
} from './types.js';

export type { HarnessLogEntry } from './logger.js';
export type { StopHookResult, StopHookFn } from './stop-hooks.js';
export type { TokenBudgetConfig } from './token-budget.js';
export type { StreamingToolResult } from './streaming-tool-executor.js';

// TaskGraph
export { createTaskGraph, getCurrentNode, advanceCursor, markGraphDone, toSnapshot, applySnapshot } from './task-graph.js';
export { buildGraph, discoverRepoShape } from './task-graph-builder.js';
export { ContractValidator, DeviationDetector, FailureClassifier, EscalationManager, NodeCostTrackerImpl } from './task-graph-review.js';
export { GraphExecutor } from './task-graph-executor.js';
export { isTaskGraphEnabled } from './task-graph-config.js';
export {
  serializeGraphSnapshot,
  deserializeGraphSnapshot,
  buildGraphFence,
  buildMetricsFence,
  buildDebugFence,
  parseGraphFence,
  parseMetricsFence,
  parseDebugFence,
  parsePersistedTaskGraph,
  ICECODER_GRAPH_FENCE_LANG,
  ICECODER_METRICS_FENCE_LANG,
  ICECODER_DEBUG_FENCE_LANG,
} from './task-graph-persistence.js';
