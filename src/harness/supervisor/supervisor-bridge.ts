import type { UnifiedMessage } from '../../llm/types.js';
import type {
  CorrectionPort,
  DeviationSignal,
  ExecutionMode,
  GlobalModePolicy,
  ResolvedSupervisorConfig,
  RuntimeRound,
  SupervisorDecision,
  SupervisorEvaluateContext,
  SupervisorPhase,
  TaskContext,
} from '../../types/supervisor.js';
import { MessageCorrectionPort } from './correction-port.js';
import { EventTimeline, type EventTimelineOptions } from './event-timeline.js';

export interface SupervisorRuntimeBridgeOptions extends EventTimelineOptions {}

export interface ObserveAfterToolsContext {
  phase: SupervisorPhase;
  round: RuntimeRound;
  task: TaskContext;
}

export interface EvaluateAfterRoundContext {
  phase: SupervisorPhase;
  round: RuntimeRound;
  task: TaskContext;
  signals: DeviationSignal[];
  riskScore: number;
}

/**
 * L2 监管层统一入口骨架：聚合 config / GlobalPolicy / EventTimeline。
 * Harness 四钩子（§14.1）后续只经本 bridge 调用，避免 harness.ts 散落监管逻辑。
 */
export class SupervisorRuntimeBridge {
  readonly config: ResolvedSupervisorConfig;
  readonly globalPolicy: GlobalModePolicy;
  readonly eventTimeline: EventTimeline;

  constructor(config: ResolvedSupervisorConfig, options: SupervisorRuntimeBridgeOptions = {}) {
    this.config = config;
    this.globalPolicy = config.globalPolicy;
    this.eventTimeline = new EventTimeline(config.eventTimeline, options);
  }

  /** off 模式早退：不写入 timeline、不跑 L2 钩子副作用。 */
  isActive(): boolean {
    return this.globalPolicy.recoverySupervisorEnabled;
  }

  /** §8.9 switch — execution mode 切换可观测性。 */
  recordExecutionModeSwitch(params: {
    round: number;
    from: ExecutionMode;
    to: ExecutionMode;
    reason: string;
  }): void {
    if (!this.isActive()) return;

    this.eventTimeline.recordTyped('switch', {
      round: params.round,
      mode: this.globalPolicy.supervisorMode,
      reason: `${params.from}->${params.to}: ${params.reason}`,
    });
  }

  /**
   * §15.8 shadow：记录「本会接管」到 timeline，不改 supervisorPhase。
   * 可选经 CorrectionPort 注入 shadow_diagnostic（仍不改 phase）。
   */
  recordShadowWouldTakeover(params: {
    round: number;
    phase: SupervisorPhase;
    reason: string;
    signals?: DeviationSignal[];
    messages?: UnifiedMessage[];
    correctionPort?: CorrectionPort;
  }): void {
    if (!this.isActive() || !this.globalPolicy.shadow) return;

    this.eventTimeline.recordTyped('shadow_diagnostic', {
      round: params.round,
      mode: this.globalPolicy.supervisorMode,
      reason: params.reason,
      payload: params.signals?.length ? { signals: params.signals } : undefined,
    });

    const port = params.correctionPort
      ?? (params.messages ? new MessageCorrectionPort(params.messages) : undefined);
    port?.inject(
      { kind: 'shadow_diagnostic', content: `[Shadow] Would takeover: ${params.reason}` },
      { phase: params.phase, source: 'supervisor' },
    );
  }

  /** L2-2：工具轮结束后 PassiveObserver 入口（当前为 no-op）。 */
  observeAfterTools(_ctx: ObserveAfterToolsContext): void {
    if (!this.isActive()) return;
  }

  /**
   * L2-3：轮次结束后 RecoverySupervisor.evaluate 入口（当前为 continue）。
   * shadow 模式下若未来 decision=takeover，应只写 timeline 不改 phase。
   */
  async evaluateAfterRound(ctx: EvaluateAfterRoundContext): Promise<SupervisorDecision> {
    if (!this.isActive()) {
      return { action: 'continue' };
    }

    return this.applyDecision({ action: 'continue' }, ctx.phase, ctx.round.round);
  }

  /** 将 RecoverySupervisor 决策落 timeline；shadow 下拦截全部 phase 变更决策。 */
  applyDecision(
    decision: SupervisorDecision,
    phase: SupervisorPhase,
    round: number,
  ): SupervisorDecision {
    if (!this.isActive()) {
      return { action: 'continue' };
    }

    if (this.globalPolicy.shadow && decision.action !== 'continue') {
      this.recordShadowBlockedDecision(decision, phase, round);
      return { action: 'continue' };
    }

    this.recordDecisionEvent(decision, round);
    return decision;
  }

  /** 供 L2-3+ 直接构造 evaluate context。 */
  buildEvaluateContext(params: {
    phase: SupervisorPhase;
    round: RuntimeRound;
    task: TaskContext;
    signals: DeviationSignal[];
    riskScore: number;
  }): SupervisorEvaluateContext {
    return {
      phase: params.phase,
      mode: this.globalPolicy.supervisorMode,
      shadow: this.globalPolicy.shadow,
      round: params.round,
      signals: params.signals,
      riskScore: params.riskScore,
      task: params.task,
    };
  }

  private recordShadowBlockedDecision(
    decision: Exclude<SupervisorDecision, { action: 'continue' }>,
    phase: SupervisorPhase,
    round: number,
  ): void {
    if (decision.action === 'takeover') {
      this.recordShadowWouldTakeover({
        round,
        phase,
        reason: decision.reason,
        signals: decision.signals,
      });
      return;
    }

    this.eventTimeline.recordTyped('shadow_diagnostic', {
      round,
      mode: this.globalPolicy.supervisorMode,
      reason: formatShadowBlockedReason(decision),
      payload: { wouldAction: decision.action },
    });
  }

  private recordDecisionEvent(decision: SupervisorDecision, round: number): void {
    const mode = this.globalPolicy.supervisorMode;

    switch (decision.action) {
      case 'takeover':
        this.eventTimeline.recordTyped('recover', {
          round,
          mode,
          reason: decision.reason,
          payload: decision.signals.length ? { signals: decision.signals } : undefined,
        });
        break;
      case 'handoff_pending':
      case 'handoff':
        this.eventTimeline.recordTyped('handoff', {
          round,
          mode,
          reason: decision.action,
        });
        break;
      case 'fail':
        this.eventTimeline.recordTyped(decision.kind === 'rollback' ? 'rollback' : 'failure', {
          round,
          mode,
          reason: decision.kind,
        });
        break;
      case 'continue':
        break;
    }
  }
}

export function createSupervisorRuntimeBridge(
  config: ResolvedSupervisorConfig,
  options: SupervisorRuntimeBridgeOptions = {},
): SupervisorRuntimeBridge {
  return new SupervisorRuntimeBridge(config, options);
}

function formatShadowBlockedReason(decision: Exclude<SupervisorDecision, { action: 'continue' }>): string {
  switch (decision.action) {
    case 'takeover':
      return decision.reason;
    case 'handoff_pending':
      return 'would_handoff_pending';
    case 'handoff':
      return 'would_handoff';
    case 'fail':
      return `would_fail:${decision.kind}`;
  }
}
