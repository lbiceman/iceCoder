import type { ExecutionMode, ForcedDegradedTier } from '../../types/supervisor.js';

/**
 * §2.8.11 — Forced 下退化层判定。
 *
 * 输入只能描述本轮可观测事实（不引入 LLM / 用户文本），
 * 且永远不写 executionMode；只回答「该用哪一档 forcedDegradedTier」。
 *
 * 优先级：graph > step_queue > write_intent。
 */
export interface ForcedDegradedInput {
  executionMode: ExecutionMode;
  /** 本轮 graph builder / initGraph 是否失败。 */
  graphInitFailed: boolean;
  /** 本轮 evaluateRound 是否触发 force_switch。 */
  forceSwitchTriggered: boolean;
  /** LLM 本轮规划的 tool call 数；用于判定全 block。 */
  plannedToolCount: number;
  /** ToolGate 过滤后真正会执行的 tool call 数。 */
  executableToolCount: number;
  /** 本轮规划是否包含写工具（write_file/edit_file/...）。 */
  plannedHadWriteTool: boolean;
}

export function computeForcedDegradedTier(input: ForcedDegradedInput): ForcedDegradedTier | null {
  if (input.executionMode !== 'forced') return null;

  if (input.graphInitFailed) return 'graph';
  if (input.forceSwitchTriggered) return 'step_queue';

  const allBlocked = input.plannedToolCount > 0 && input.executableToolCount === 0;
  if (allBlocked && input.plannedHadWriteTool) return 'write_intent';

  return null;
}
