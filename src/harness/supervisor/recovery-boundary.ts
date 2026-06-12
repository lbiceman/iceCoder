import type {
  CorrectionBlock,
  CorrectionSource,
  SupervisorPhase,
} from '../../types/supervisor.js';

/**
 * §11 / §19.6 — `RecoveryBoundary`（纠偏写入门禁）。
 *
 * 单一来源判定「某次 C 类 inject 在当前 phase × source × kind 是否允许写 msgs」。
 *
 * 与 `CorrectionBudgetTracker` 的分工：
 *   - `RecoveryBoundary`（本类）：**phase × source × kind** 的硬规则（与运行预算无关）；
 *   - `CorrectionBudgetTracker`：free 段 supervisor 的 recovery/graph_hint **次数预算**（I4）。
 *
 * Harness/各模块所有 C 类 inject 都应：先过 `RecoveryBoundary.mayInjectCorrection` →
 * 再过 `CorrectionBudgetTracker.tryConsume`（由 `MessageCorrectionPort` 内部串联）。
 *
 * boundary 拒绝的 inject **不写 msgs**；调用方可通过 `onRejected` 把违规写入 EventTimeline
 * （`failure:recovery_boundary_rejected:{reason}`），便于 §19.6 全相位对照表的回归审计。
 *
 * shadow 段（globalPolicy.shadow=true）由 bridge 自身在 applyDecision 拦截；本 boundary
 * 不需要再处理 shadow 语义。
 */
export type BoundaryRejectReason =
  /** free 段 supervisor 注入 takeover 文案（takeover 文案专属 takeover phase）。 */
  | 'free_phase_rejects_takeover_block'
  /** takeover 段非 supervisor 想写 C 类（含 lifecycle/memory/compaction）。 */
  | 'takeover_phase_requires_supervisor_source'
  /** handoff_pending/cooldown 段：非 supervisor 不得注入 takeover/recovery。 */
  | 'handoff_phase_rejects_non_supervisor_recovery';

export type BoundaryDecision =
  | { allowed: true; budgetCountable: boolean }
  | { allowed: false; reason: BoundaryRejectReason };

export interface RecoveryBoundaryMayInjectArgs {
  phase: SupervisorPhase;
  source: CorrectionSource;
  blockKind: CorrectionBlock['kind'];
}

export class RecoveryBoundary {
  /**
   * §19.6 互斥表的纯函数版本：判断本次 inject 是否允许穿过门禁。
   *
   * 允许放行的典型场景：
   *   - free 段：lifecycle/memory/compaction A 类（一律放行）；supervisor 的 recovery/graph_hint
   *     由 CorrectionBudget 单独管控；supervisor 的 shadow_diagnostic（shadow 段允许累计）；
   *   - takeover 段：仅 supervisor；
   *   - handoff_pending/cooldown：supervisor 任意 / 非 supervisor 仅 graph_hint/shadow_diagnostic。
   */
  mayInjectCorrection(args: RecoveryBoundaryMayInjectArgs): BoundaryDecision {
    if (
      args.phase === 'free'
      && args.source === 'supervisor'
      && args.blockKind === 'takeover'
    ) {
      return { allowed: false, reason: 'free_phase_rejects_takeover_block' };
    }

    if (args.phase === 'takeover' && args.source !== 'supervisor') {
      return { allowed: false, reason: 'takeover_phase_requires_supervisor_source' };
    }

    if (
      (args.phase === 'handoff_pending' || args.phase === 'cooldown')
      && args.source !== 'supervisor'
      && (args.blockKind === 'takeover' || args.blockKind === 'recovery')
    ) {
      return { allowed: false, reason: 'handoff_phase_rejects_non_supervisor_recovery' };
    }

    // I4 计数权收口到 boundary：仅 free × supervisor × recovery/graph_hint 交给 budget。
    const budgetCountable = args.phase === 'free'
      && args.source === 'supervisor'
      && (args.blockKind === 'recovery' || args.blockKind === 'graph_hint');
    return { allowed: true, budgetCountable };
  }
}

export function createRecoveryBoundary(): RecoveryBoundary {
  return new RecoveryBoundary();
}
