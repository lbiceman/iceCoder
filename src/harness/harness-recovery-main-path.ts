import type { UnifiedMessage } from '../llm/types.js';
import type {
  CorrectionPort,
  DeviationSignal,
  RuntimeRound,
  SupervisorDecision,
  SupervisorPhase,
  TaskContext,
} from '../types/supervisor.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { GraphExecutor } from './task-graph-executor.js';
import type { LoopController } from './loop-controller.js';
import type { SupervisorRuntimeBridge, RecoveryMainPathResult } from './supervisor/supervisor-bridge.js';
import type { WorkspaceStateExtractorInput } from './supervisor/workspace-state-extractor.js';
import {
  markForcedDegraded,
  syncExecutionModeLoopState,
} from './supervisor/execution-mode-constraints.js';
import {
  isBuildVerificationCommand,
  isTestVerificationCommand,
} from './verification-digest.js';
import type { HarnessStepEvent } from './types.js';

export interface ApplyTakeoverRecoveryMainPathArgs {
  bridge: SupervisorRuntimeBridge;
  state: HarnessRunState;
  task: TaskContext;
  round: RuntimeRound;
  signals: readonly DeviationSignal[];
  graphExecutor: GraphExecutor;
  correctionPort?: CorrectionPort;
  messages: UnifiedMessage[];
  loopController?: LoopController;
  onStep?: (event: HarnessStepEvent) => void;
  /** true = free/cooldown 新进入 takeover，重置 extract 轮次计数。 */
  freshTakeoverEntry?: boolean;
}

/**
 * 是否在本轮 after-round 后执行 §10 恢复主路径。
 *
 * - `decision.action === 'takeover'`：free/cooldown 新进入接管；
 * - handoff_pending 因新 signal 退回 takeover：decision 为 continue，但 phase 已回退。
 */
export function shouldRunRecoveryMainPath(
  phaseBefore: SupervisorPhase,
  phaseAfter: SupervisorPhase,
  decision: SupervisorDecision,
): boolean {
  if (decision.action === 'takeover') return true;
  return phaseBefore === 'handoff_pending' && phaseAfter === 'takeover';
}

export function resolveRecoveryMainPathSignals(
  decision: SupervisorDecision,
  bridge: SupervisorRuntimeBridge,
): readonly DeviationSignal[] {
  if (decision.action === 'takeover') return decision.signals;
  return bridge.getAccumulatedDeviationSignals();
}

function compactSummary(text: string, maxLen = 400): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** 从 TaskState / verification buffer / repo 诊断组装 M5 可选摘要字段。 */
export function buildRecoverySummaries(
  state: HarnessRunState,
): Pick<WorkspaceStateExtractorInput, 'buildSummary' | 'testSummary' | 'lintSummary'> {
  const snap = state.taskState.snapshot();
  let testSummary: string | undefined;
  if (snap.verificationStatus === 'passed') testSummary = 'passed';
  else if (snap.verificationStatus === 'failed') testSummary = 'failed';
  else if (snap.verificationStatus === 'required') testSummary = 'required';

  let buildSummary: string | undefined;
  let lintSummary: string | undefined;

  const bufferEntries = state.verificationOutputBuffer.snapshot();
  for (let i = bufferEntries.length - 1; i >= 0; i--) {
    const entry = bufferEntries[i];
    const body = compactSummary(entry.outputBody);
    if (!body) continue;
    if (isBuildVerificationCommand(entry.command) && !buildSummary) {
      buildSummary = `failed: ${body}`;
    } else if (/\blint\b/i.test(entry.command) && !lintSummary) {
      lintSummary = `failed: ${body}`;
    } else if (
      isTestVerificationCommand(entry.command)
      && testSummary !== 'passed'
      && !testSummary
    ) {
      testSummary = 'failed';
    }
  }

  if (state.buildDiagnosticGateActive && !buildSummary) {
    buildSummary = 'failed: build_diagnostic_gate_active';
  }

  const diagnostics = state.repoContext.snapshot().recentDiagnostics;
  if (!buildSummary && diagnostics.length > 0) {
    buildSummary = compactSummary(diagnostics.slice(-2).join('; '));
  }

  return { buildSummary, testSummary, lintSummary };
}

export function buildRecoveryExtractInput(state: HarnessRunState): WorkspaceStateExtractorInput {
  return {
    task: state.taskState.snapshot(),
    repo: state.repoContext.snapshot(),
    ...buildRecoverySummaries(state),
    gitSummary: deriveRecoveryGitSummary(state),
  };
}

function deriveRecoveryGitSummary(state: HarnessRunState): string | undefined {
  const repo = state.repoContext.snapshot();
  if (repo.filesChanged.length === 0 && repo.recentDiagnostics.length === 0) {
    return 'clean';
  }
  const head = repo.filesChanged.length > 0 ? `M:${repo.filesChanged.length}` : 'M:0';
  if (repo.recentDiagnostics.length === 0) return head;
  return `${head} diag:${repo.recentDiagnostics.length}`;
}

function computeRoundsSinceExtract(
  state: HarnessRunState,
  round: number,
  freshTakeoverEntry: boolean,
): number {
  if (freshTakeoverEntry || state.lastRecoveryExtractRound == null) return 0;
  return Math.max(0, round - state.lastRecoveryExtractRound);
}

/**
 * L2-6 §10 — takeover 决策后串联恢复主路径（M5→M8 + replaceGraph）。
 * 须在 `evaluateAfterRound` 返回且 phase 已 commit 之后调用。
 */
export function applyTakeoverRecoveryMainPath(
  args: ApplyTakeoverRecoveryMainPathArgs,
): RecoveryMainPathResult {
  const snap = args.state.taskState.snapshot();
  const repo = args.state.repoContext.snapshot();
  const freshEntry = args.freshTakeoverEntry === true;
  const roundsSinceExtract = computeRoundsSinceExtract(args.state, args.round.round, freshEntry);

  const result = args.bridge.runRecoveryMainPath({
    round: args.round.round,
    task: args.task,
    signals: args.signals,
    extractInput: buildRecoveryExtractInput(args.state),
    confidenceInput: {
      roundsSinceExtract,
      lastVerifyPassed: snap.verificationStatus === 'passed',
      repoFilesChanged: [...repo.filesChanged],
    },
    graphExecutor: args.graphExecutor,
    correctionPort: args.correctionPort,
    messages: args.messages,
  });

  args.state.lastRecoveryExtractRound = args.round.round;

  if (result.tier === 'strong_hint' && result.fallbackReason) {
    if (!markForcedDegraded(args.state, 'step_queue')
      && args.state.supervisorPhase === 'takeover') {
      args.state.forcedDegradedTier = 'step_queue';
    }
    if (args.loopController) {
      syncExecutionModeLoopState(args.loopController, args.state);
    }
  }

  if (result.tier === 'template_graph' && result.graph) {
    args.onStep?.({
      type: 'task_graph_init',
      graphGoal: args.task.goal,
      graphIntent: args.task.intent,
      plan: args.graphExecutor.toView() ?? undefined,
    });
  }

  return result;
}
