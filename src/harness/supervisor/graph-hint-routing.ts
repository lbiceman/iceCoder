import type { ExecutionMode } from '../../types/supervisor.js';
import type { RoundEvalResult } from '../task-graph-executor.js';

/**
 * §15.3 / T11 / W2 — free 段 evaluateRound 不再向对话注入 graph 文案；
 * 仍发 telemetry 事件，便于观察接管前的弱信号。
 */
export interface GraphHintRoutingInput {
  executionMode: ExecutionMode;
  action: RoundEvalResult['action'];
  message?: string;
}

export interface GraphHintRoutingDecision {
  /** 是否将 message 经 CorrectionPort 注入到对话。 */
  injectToCorrectionPort: boolean;
  /** 是否仍然发出对应的 task_graph_branch / hint telemetry 事件。 */
  emitTelemetry: boolean;
}

export function decideGraphHintRouting(input: GraphHintRoutingInput): GraphHintRoutingDecision {
  const hasMessage = !!input.message;
  if (!hasMessage) {
    return { injectToCorrectionPort: false, emitTelemetry: false };
  }

  if (input.executionMode !== 'forced') {
    return { injectToCorrectionPort: false, emitTelemetry: true };
  }

  return { injectToCorrectionPort: true, emitTelemetry: true };
}
