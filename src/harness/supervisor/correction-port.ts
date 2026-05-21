import type { UnifiedMessage } from '../../llm/types.js';
import type {
  CorrectionBlock,
  CorrectionInjectContext,
  CorrectionPort,
} from '../../types/supervisor.js';
import type { CorrectionBudgetTracker } from './correction-budget.js';
import type { BoundaryRejectReason, RecoveryBoundary } from './recovery-boundary.js';

export interface MessageCorrectionPortOptions {
  /** §2.6 I4 — free 段 C 类 inject 预算；缺省时不强制（兼容历史调用方）。 */
  budget?: CorrectionBudgetTracker;
  /**
   * §11 / §19.6 — `RecoveryBoundary`：phase × source × kind 的硬门禁。
   * 缺省时退回历史 `shouldSuppress` 行为（free 段 supervisor 的 takeover 类静默 drop）。
   * 提供时本 port 严格按 boundary 路由：
   *   - 拒绝 → drop 且不计 budget；调用方经 `onBoundaryRejected` 落 timeline；
   *   - 允许且 `budgetCountable` → 调用 `CorrectionBudgetTracker.tryConsume()` 扣减次数；
   *   - 允许且非 budgetCountable → 直接写 msgs。
   */
  recoveryBoundary?: RecoveryBoundary;
  /**
   * 预算耗尽时的回调，用于让上层（通常是 SupervisorRuntimeBridge）落一条
   * `failure:correction_budget_exhausted` timeline。被拒绝的 inject **不写 msgs**。
   */
  onBudgetRejected?: (args: {
    block: CorrectionBlock;
    ctx: CorrectionInjectContext;
  }) => void;
  /**
   * RecoveryBoundary 拒绝时的回调；上层把违规写 timeline 便于 §19.6 回归。
   * 与 `onBudgetRejected` 互斥（boundary 失败不会再走 budget）。
   */
  onBoundaryRejected?: (args: {
    block: CorrectionBlock;
    ctx: CorrectionInjectContext;
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

  inject(block: CorrectionBlock, ctx: CorrectionInjectContext): void {
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
      if (decision.budgetCountable && this.budget && !this.budget.tryConsume()) {
        // I4：boundary 已放行但 free 段次数超限 → drop inject；timeline 由 onBudgetRejected 上报。
        this.onBudgetRejected?.({ block, ctx });
        return;
      }
    } else if (legacyShouldSuppress(block, ctx)) {
      // 历史调用方：保留 W7 兼容路径（free 段 supervisor 的 takeover 类静默 drop）。
      return;
    }

    this.messages.push({ role: 'user', content: block.content });
  }
}

function legacyShouldSuppress(block: CorrectionBlock, ctx: CorrectionInjectContext): boolean {
  if (ctx.source !== 'supervisor' || ctx.phase !== 'free') {
    return false;
  }

  return block.kind === 'takeover';
}
