import type { UnifiedMessage } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import type { HarnessRunState } from './harness-run-state.js';
import { topFileEditFromInspect } from './supervisor/passive-observer.js';
import type { CorrectionPort } from '../types/supervisor.js';
import {
  applyRebuildEscalationBypasses,
  buildRebuildEscalationMessage,
  canInjectRebuildEscalation,
  collectRebuildEscalationContext,
  type RebuildEscalationTrigger,
} from './rebuild-escalation.js';
import type { PendingSegmentRenewal } from './supervisor/supervisor-bridge.js';

export interface RebuildEscalationInjectDeps {
  workspaceRoot: string;
  supervisorObserverSuppressInject?: boolean;
  /** false 时直写 msgs（与 tool-round injectRecoveryMessage 一致） */
  executionModeDecisionEnabled?: boolean;
}

function topFileEditFromBranchBudget(
  branchBudget: BranchBudgetTracker | undefined,
): { path: string; count: number } | undefined {
  if (!branchBudget) return undefined;
  return topFileEditFromInspect(branchBudget.inspect().fileEdits);
}

function deliverRecoveryContent(
  deps: RebuildEscalationInjectDeps,
  state: HarnessRunState,
  msgs: UnifiedMessage[],
  correctionPort: CorrectionPort,
  content: string,
): void {
  if (deps.supervisorObserverSuppressInject) return;
  if (!deps.executionModeDecisionEnabled) {
    msgs.push({ role: 'user', content });
    return;
  }
  correctionPort.inject(
    { kind: 'recovery', content, preserveOnCompaction: true },
    { phase: state.supervisorPhase, source: 'supervisor' },
  );
}

export function tryInjectRebuildEscalation(
  deps: RebuildEscalationInjectDeps,
  state: HarnessRunState,
  msgs: UnifiedMessage[],
  correctionPort: CorrectionPort,
  failureCount: number,
  trigger: RebuildEscalationTrigger,
): void {
  if (!canInjectRebuildEscalation({
    rebuildEscalationInjections: state.rebuildEscalationInjections,
    rebuildEscalationInjectedThisRound: state.rebuildEscalationInjectedThisRound,
    suppressInject: deps.supervisorObserverSuppressInject,
  })) return;

  const topFile = topFileEditFromBranchBudget(state.branchBudget);
  const rebuildCtx = collectRebuildEscalationContext(
    msgs,
    topFile,
    state.verificationOutputBuffer,
    deps.workspaceRoot,
  );
  const bypasses = applyRebuildEscalationBypasses(
    state.branchBudget,
    topFile,
    rebuildCtx.lastVerificationCommand,
    msgs,
    state.verificationOutputBuffer,
    deps.workspaceRoot,
  );
  deliverRecoveryContent(
    deps,
    state,
    msgs,
    correctionPort,
    buildRebuildEscalationMessage(failureCount, { ...rebuildCtx, ...bypasses }, trigger),
  );
  state.rebuildEscalationInjections += 1;
  state.rebuildEscalationInjectedThisRound = true;
  state.harnessPolicyStats.rebuildEscalationCount += 1;
}

export function injectSegmentRenewalRebuild(args: {
  deps: RebuildEscalationInjectDeps;
  state: HarnessRunState;
  msgs: UnifiedMessage[];
  correctionPort: CorrectionPort;
  renewal: PendingSegmentRenewal;
}): void {
  const { deps, state, msgs, correctionPort, renewal } = args;
  tryInjectRebuildEscalation(
    deps,
    state,
    msgs,
    correctionPort,
    renewal.segmentIndex,
    'segment_renewal_budget',
  );
  console.log(
    `[harness] Recovery budget 续段 #${renewal.segmentIndex}（${renewal.reason}），注入 Rebuild Escalation`,
  );
}
