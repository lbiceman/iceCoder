/**
 * Harness 模块入口。
 * 导出 Harness 核心循环及其所有子组件。
 *
 * 模块组成：
 * - Harness: 核心循环引擎（参考 Claude Code 的 query.ts）
 * - ContextAssembler: 上下文组装器
 * - LoopController: 循环控制器
 * - PermissionManager: 权限管理器
 * - ContextCompactor: 上下文压缩器
 * - HarnessLogger: 结构化日志器
 * - StopHookManager: 停止钩子管理器（参考 Claude Code 的 stopHooks.ts）
 * - TokenBudgetTracker: Token 预算追踪器（参考 Claude Code 的 tokenBudget.ts）
 * - StreamingToolExecutor: 流式工具执行器（参考 Claude Code 的 StreamingToolExecutor.ts）
 */

export { Harness } from './harness.js';
export { ContextAssembler, normalizeMessages } from './context-assembler.js';
export { LoopController } from './loop-controller.js';
export { PermissionManager } from './permission.js';
export { ContextCompactor, estimateTokens } from './context-compactor.js';
export { HarnessLogger } from './logger.js';
export { StopHookManager } from './stop-hooks.js';
export { TokenBudgetTracker } from './token-budget.js';
export { StreamingToolExecutor } from './streaming-tool-executor.js';

export type {
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  ChatFunction,
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
