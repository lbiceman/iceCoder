import type {
  CorrectionPort,
  ExecutionMode,
  GlobalModePolicy,
  SupervisorPhase,
} from '../../types/supervisor.js';
import type { RoundEvalResult } from '../task-graph-executor.js';
import type { EventTimeline } from './event-timeline.js';
import { decideGraphHintRouting, type GraphHintRoutingDecision } from './graph-hint-routing.js';

/** Graph hint timeline / 反查 tag；与 `GraphHintInput.origin` 对齐。 */
export type GraphHintReasonTag =
  | 'evaluate_round'
  | 'forced_step_warn'
  | 'forced_step_block';

export type GraphHintInput =
  | {
      origin: 'evaluate_round';
      action: RoundEvalResult['action'];
      message: string | undefined;
    }
  | {
      origin: 'forced_step';
      kind: 'warn' | 'block';
      message: string;
    };

export interface ComposeGraphHintArgs {
  round: number;
  executionMode: ExecutionMode;
  port: CorrectionPort;
  phase: SupervisorPhase;
  input: GraphHintInput;
}

/** composeGraphHint 所需 bridge 子集（避免与 supervisor-bridge 循环依赖）。 */
export interface ComposeGraphHintBridgeHost {
  isActive(): boolean;
  globalPolicy: GlobalModePolicy;
  eventTimeline: EventTimeline;
}

export function normalizeGraphHintInput(input: GraphHintInput): {
  message: string | undefined;
  action: RoundEvalResult['action'];
  reasonTag: GraphHintReasonTag;
} {
  if (input.origin === 'evaluate_round') {
    return { message: input.message, action: input.action, reasonTag: 'evaluate_round' };
  }
  return {
    message: input.message,
    action: input.kind === 'warn' ? 'inject_hint' : 'block',
    reasonTag: input.kind === 'warn' ? 'forced_step_warn' : 'forced_step_block',
  };
}

/**
 * P1-2 — Graph hint 路由与 inject 的唯一实现；`SupervisorRuntimeBridge.composeGraphHint` 委托本函数。
 */
export function runComposeGraphHint(
  bridge: ComposeGraphHintBridgeHost,
  args: ComposeGraphHintArgs,
): GraphHintRoutingDecision {
  const { message, action, reasonTag } = normalizeGraphHintInput(args.input);
  const routing = decideGraphHintRouting({
    executionMode: args.executionMode,
    action,
    message,
  });

  if (routing.injectToCorrectionPort && message) {
    args.port.inject(
      { kind: 'graph_hint', content: message },
      { phase: args.phase, source: 'supervisor', round: args.round },
    );
    if (bridge.isActive()) {
      bridge.eventTimeline.recordTyped('recover', {
        round: args.round,
        mode: bridge.globalPolicy.supervisorMode,
        reason: `graph_hint:${reasonTag}`,
        payload: { phase: args.phase, origin: args.input.origin, action },
      });
    }
  }

  return routing;
}
