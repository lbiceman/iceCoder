import type { ToolCall } from '../llm/types.js';
import type { GateContext } from '../types/supervisor.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { GraphExecutor } from './task-graph-executor.js';

/**
 * 普通工具轮与 synthetic 验收共用同一 forced-graph 门控上下文。
 * track:false 只作准入判断；真正执行前由调用方补 track:true。
 */
export function buildHarnessToolGateContext(
  graphExecutor: GraphExecutor | undefined,
  toolCalls: readonly ToolCall[] | undefined,
  state: HarnessRunState,
): GateContext {
  const executionMode = state.executionMode ?? 'free';
  const graphHints: GateContext['graphHints'] = [];

  if (executionMode === 'forced' && graphExecutor?.hasGraph() && toolCalls) {
    for (const toolCall of toolCalls) {
      const check = graphExecutor.checkToolCall(toolCall.name, { track: false });
      graphHints.push({
        toolName: toolCall.name,
        action: check.action,
        message: check.message,
      });
    }
  }

  return { executionMode, graphHints };
}
