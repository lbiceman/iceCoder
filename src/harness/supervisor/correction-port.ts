import type { UnifiedMessage } from '../../llm/types.js';
import type { CorrectionBlock, CorrectionPort, CorrectionSource, SupervisorPhase } from '../../types/supervisor.js';
import type { CorrectionBudgetTracker } from './correction-budget.js';
import type { BoundaryRejectReason, RecoveryBoundary } from './recovery-boundary.js';

export interface MessageCorrectionPortOptions {
  /** §2.6 I4 — free 段 C 类 inject 预算；缺省时不强制（兼容历史调用方）。 */
  budget?: CorrectionBudgetTracker;
  /**
   * §11 / §19.6 — `RecoveryBoundary`：phase × source × kind 的硬门禁。
   * 缺省时退回历史 `shouldSuppress` 行为（free 段 supervisor 的 takeover 类静默 drop）。
   * 提供时本 port 严格按 boundary.decide 路由：
   *   - 拒绝 → drop 且不计 budget；调用方经 `onBoundaryRejected` 落 timeline；
   *   - 允许 → 继续走 budget 检查与 msgs.push。
   */
  recoveryBoundary?: RecoveryBoundary;
  /**
   * 预算耗尽时的回调，用于让上层（通常是 SupervisorRuntimeBridge）落一条
   * `failure:correction_budget_exhausted` timeline。被拒绝的 inject **不写 msgs**。
   */
  onBudgetRejected?: (args: {
    block: CorrectionBlock;
    ctx: { phase: SupervisorPhase; source: CorrectionSource };
  }) => void;
  /**
   * RecoveryBoundary 拒绝时的回调；上层把违规写 timeline 便于 §19.6 回归。
   * 与 `onBudgetRejected` 互斥（boundary 失败不会再走 budget）。
   */
  onBoundaryRejected?: (args: {
    block: CorrectionBlock;
    ctx: { phase: SupervisorPhase; source: CorrectionSource };
    reason: BoundaryRejectReason;
  }) => void;
}

export class MessageCorrectionPort implements CorrectionPort {
  private readonly budget?: CorrectionBudgetTracker;
  private readonly recoveryBoundary?: RecoveryBoundary;
  private readonly onBudgetRejected?: MessageCorrectionPortOptions['onBudgetRejected'];
  private readonly onBoundaryRejected?: MessageCorrectionPortOptions['onBoundaryRejected'];

  constructor(
    private readonly messages: UnifiedMessage[],
    options: MessageCorrectionPortOptions = {},
  ) {
    this.budget = options.budget;
    this.recoveryBoundary = options.recoveryBoundary;
    this.onBudgetRejected = options.onBudgetRejected;
    this.onBoundaryRejected = options.onBoundaryRejected;
  }

  inject(block: CorrectionBlock, ctx: { phase: SupervisorPhase; source: CorrectionSource }): void {
    if (this.recoveryBoundary) {
      const decision = this.recoveryBoundary.mayInjectCorrection({
        phase: ctx.phase,
        source: ctx.source,
        blockKind: block.kind,
      });
      if (!decision.allowed) {
        this.onBoundaryRejected?.({ block, ctx, reason: decision.reason });
        return;
      }
    } else if (legacyShouldSuppress(block, ctx)) {
      // 历史调用方：保留 W7 兼容路径（free 段 supervisor 的 takeover 类静默 drop）。
      return;
    }

    if (this.budget && !this.budget.tryConsume({ block, phase: ctx.phase, source: ctx.source })) {
      // I4：free 段超限 → drop inject；timeline 由 onBudgetRejected 上报。
      this.onBudgetRejected?.({ block, ctx });
      return;
    }

    this.messages.push({ role: 'user', content: block.content });
  }
}

function legacyShouldSuppress(block: CorrectionBlock, ctx: { phase: SupervisorPhase; source: CorrectionSource }): boolean {
  if (ctx.source !== 'supervisor' || ctx.phase !== 'free') {
    return false;
  }

  // W7：free 段仅抑制 takeover 类长策略（接管文案是 phase=takeover 的专属）。
  //     recovery 类是熔断前的硬阈值提示（如 "Repeated failed tool call detected"、
  //     branch budget warning、6 轮全失败警告），是 free 段最后的自纠偏路径，
  //     在 CorrectionBudget 真正落地之前不应整类抑制；否则 adaptive 接通后
  //     free 段会失去自我恢复能力。
  return block.kind === 'takeover';
}
