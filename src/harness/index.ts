/**
 * Harness 模块入口。
 * 导出 Harness 核心循环及其所有子组件。
 */

export { Harness } from './harness.js';
export { ContextAssembler } from './context-assembler.js';
export { LoopController } from './loop-controller.js';
export { PermissionManager } from './permission.js';
export { ContextCompactor } from './context-compactor.js';
export { HarnessLogger } from './logger.js';

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
