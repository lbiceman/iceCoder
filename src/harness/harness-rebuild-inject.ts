import type { UnifiedMessage } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import type { HarnessRunState } from './harness-run-state.js';
import {
  applyRebuildEscalationBypasses,
  buildRebuildEscalationMessage,
  canInjectRebuildEscalation,
  collectRebuildEscalationContext,
  type RebuildEscalationTrigger,
} from './rebuild-escalation.js';

export interface RebuildEscalationInjectDeps {
  workspaceRoot: string;
  /** false 时直写 msgs（与 tool-round injectRecoveryMessage 一致） */
  executionModeDecisionEnabled?: boolean;
}

function topFileEditFromBranchBudget(
  branchBudget: BranchBudgetTracker | undefined,
): { path: string; count: number } | undefined {
  if (!branchBudget) return undefined;
  let best: { path: string; count: number } | undefined;
  for (const [path, count] of Object.entries(branchBudget.inspect().fileEdits)) {
    if (!best || count > best.count) best = { path, count };
  }
  return best;
}

function deliverRecoveryContent(
  deps: RebuildEscalationInjectDeps,
  msgs: UnifiedMessage[],
  content: string,
): void {
  if (!deps.executionModeDecisionEnabled) {
    msgs.push({ role: 'user', content });
    return;
  }
  msgs.push({ role: 'user', content, preserveOnCompaction: true });
}

export function tryInjectRebuildEscalation(
  deps: RebuildEscalationInjectDeps,
  state: HarnessRunState,
  msgs: UnifiedMessage[],
  failureCount: number,
  trigger: RebuildEscalationTrigger,
  extras?: { stuckCommand?: string },
): boolean {
  if (!canInjectRebuildEscalation({
    rebuildEscalationInjections: state.rebuildEscalationInjections,
    rebuildEscalationInjectedThisRound: state.rebuildEscalationInjectedThisRound,
  })) return false;

  const topFile = topFileEditFromBranchBudget(state.branchBudget);
  const rebuildCtx = collectRebuildEscalationContext(
    msgs,
    topFile,
    state.verificationOutputBuffer,
    deps.workspaceRoot,
  );
  const stuckCommand = extras?.stuckCommand;
  const commandForBypass = stuckCommand || rebuildCtx.lastVerificationCommand;
  const bypasses = applyRebuildEscalationBypasses(
    state.branchBudget,
    topFile,
    commandForBypass,
    msgs,
    state.verificationOutputBuffer,
    deps.workspaceRoot,
  );
  if (
    stuckCommand
    && rebuildCtx.lastVerificationCommand
    && stuckCommand !== rebuildCtx.lastVerificationCommand
    && state.branchBudget?.wouldBlockCommandRetry(rebuildCtx.lastVerificationCommand)
  ) {
    state.branchBudget.grantCommandRetryBypass(rebuildCtx.lastVerificationCommand);
    bypasses.commandBypassGranted = true;
  }
  deliverRecoveryContent(
    deps,
    msgs,
    buildRebuildEscalationMessage(
      failureCount,
      { ...rebuildCtx, ...bypasses, stuckCommand },
      trigger,
    ),
  );
  state.rebuildEscalationInjections += 1;
  state.rebuildEscalationInjectedThisRound = true;
  state.harnessPolicyStats.rebuildEscalationCount += 1;
  return true;
}
