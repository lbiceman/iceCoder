import type { LLMResponse, ToolDefinition } from '../llm/types.js';
import type { CheckpointDeps } from './harness-checkpoint.js';
import { shouldApplyCasualHarness } from './casual-mode.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { HarnessLogger } from './logger.js';
import type { StopHandlerDeps } from './harness-stop-handler.js';
import { handleHarnessStop } from './harness-stop-handler.js';
import type { LoopController } from './loop-controller.js';
import type { GraphExecutor } from './task-graph-executor.js';
import type { TokenBudgetTracker } from './token-budget.js';
import { inferTaskDomain } from './task-domain.js';
import type { CorrectionPort, TaskContext } from '../types/supervisor.js';
import type { SupervisorRuntimeBridge } from './supervisor/supervisor-bridge.js';
import {
  maxFailedSignatureCount,
  topFileEditFromInspect,
} from './supervisor/passive-observer.js';
import {
  applyTakeoverRecoveryMainPath,
  resolveRecoveryMainPathSignals,
  shouldRunRecoveryMainPath,
} from './harness-recovery-main-path.js';
import { injectSegmentRenewalRebuild } from './harness-rebuild-inject.js';
import type {
  ChatFunction,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from './types.js';

export interface SupervisorRoundDeps extends StopHandlerDeps, ResilienceBridgeDeps, CheckpointDeps {
  loopController: LoopController;
  graphExecutor: GraphExecutor;
  workspaceRoot: string;
  supervisorBridge?: SupervisorRuntimeBridge;
  supervisorRiskScoreProvider?: () => number;
  tokenBudgetTracker?: TokenBudgetTracker;
  supervisorObserverSuppressInject?: boolean;
}

export interface EvaluateSupervisorAfterRoundArgs {
  state: HarnessRunState;
  round: number;
  currentTools: ToolDefinition[];
  tokenUsage: { input: number; output: number };
  chatFn: ChatFunction;
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  streamFn?: StreamFunction;
  /** 无工具轮：空数组；工具轮：可执行工具列表。 */
  toolNames: string[];
  toolSuccess: boolean[];
  hadWriteTool: boolean;
  allToolsFailedThisRound: boolean;
  repeatedToolSignatures: string[];
  branchRecoverTriggered: boolean;
  recoveryRoundEffective: boolean;
  lastAssistantText?: string;
}

export type EvaluateSupervisorAfterRoundResult =
  | { action: 'continue' }
  | { action: 'return'; result: HarnessResult };

/**
 * 工具轮 / 无工具轮共用的 L2 after-round：observe → evaluate → takeover 主路径 / 续段 / checkpoint。
 */
export async function evaluateSupervisorAfterRound(
  deps: SupervisorRoundDeps,
  args: EvaluateSupervisorAfterRoundArgs,
): Promise<EvaluateSupervisorAfterRoundResult> {
  const bridge = deps.supervisorBridge;
  if (!bridge?.isActive()) {
    return { action: 'continue' };
  }

  const intent = args.state.taskState.snapshot().intent;
  if (shouldApplyCasualHarness(intent)) {
    return { action: 'continue' };
  }

  const {
    state,
    round,
    currentTools,
    tokenUsage,
    chatFn,
    logger,
    onStep,
    streamFn,
  } = args;
  const msgs = state.messages;
  const supervisorPhaseBefore = state.supervisorPhase;
  const taskContext = buildTaskContextForObserver(state, args.branchRecoverTriggered);
  const runtimeRound = {
    round,
    toolNames: args.toolNames,
    toolSuccess: args.toolSuccess,
    hadWriteTool: args.hadWriteTool,
  };

  bridge.observeAfterTools({
    phase: state.supervisorPhase,
    round: runtimeRound,
    consecutiveToolFailures: state.consecutiveToolFailures,
    consecutiveReadOnlyRounds: state.consecutiveReadOnlyRounds,
    consecutiveNoToolRounds: state.consecutiveNoToolRounds,
    stableRoundsSinceLastFailure: state.stableRoundsSinceLastFailure ?? 0,
    allToolsFailedThisRound: args.allToolsFailedThisRound,
    repeatedToolSignatures: args.repeatedToolSignatures,
    maxFailedSignatureCount: maxFailedSignatureCount(state.failedToolCallSignatures),
    topFileEdit: topFileEditFromBranchBudget(state.branchBudget),
    branchRecoverTriggered: args.branchRecoverTriggered,
    task: taskContext,
    lastAssistantText: args.lastAssistantText,
  });

  const correctionPort: CorrectionPort = bridge.createCorrectionPort(msgs, round);

  const decision = await bridge.evaluateAfterRound({
    round: runtimeRound,
    task: taskContext,
    riskScore: deps.supervisorRiskScoreProvider?.() ?? 0.5,
    correctionPort,
    tokenUsage: {
      used: tokenUsage.output,
      total: deps.tokenBudgetTracker?.getTotalBudget?.() ?? 0,
    },
    recoveryRoundEffective: args.recoveryRoundEffective,
    takeoverEvidenceProvider: () => buildTakeoverEvidence(state),
  });

  state.supervisorPhase = bridge.getSupervisorPhase();

  if (shouldRunRecoveryMainPath(supervisorPhaseBefore, state.supervisorPhase, decision)) {
    const freshTakeoverEntry = decision.action === 'takeover';
    if (freshTakeoverEntry) {
      state.lastRecoveryExtractRound = undefined;
    }
    applyTakeoverRecoveryMainPath({
      bridge,
      state,
      task: taskContext,
      round: runtimeRound,
      signals: resolveRecoveryMainPathSignals(decision, bridge),
      graphExecutor: deps.graphExecutor,
      correctionPort,
      messages: msgs,
      loopController: deps.loopController,
      onStep,
      freshTakeoverEntry,
    });
  }

  const segmentRenewal = bridge.consumePendingSegmentRenewal();
  if (segmentRenewal) {
    state.segmentRenewalCount = bridge.getSegmentRenewalCount();
    state.branchBudget?.resetCommandRetriesForVerificationCommands();
    state.buildDiagnosticGateActive = false;
    injectSegmentRenewalRebuild({
      deps,
      state,
      msgs,
      correctionPort,
      renewal: segmentRenewal,
    });
  }

  if (decision.action === 'fail' && decision.kind === 'checkpoint') {
    deps.loopController.stop('user_checkpoint');
    return {
      action: 'return',
      result: await handleHarnessStop(deps, {
        reason: 'user_checkpoint',
        messages: msgs,
        chatFn,
        tools: currentTools,
        logger,
        onStep,
        streamFn,
        runtimeState: state,
      }),
    };
  }

  return { action: 'continue' };
}

function topFileEditFromBranchBudget(
  branchBudget: HarnessRunState['branchBudget'],
): { path: string; count: number } | undefined {
  if (!branchBudget) return undefined;
  return topFileEditFromInspect(branchBudget.inspect().fileEdits);
}

function buildTaskContextForObserver(
  state: HarnessRunState,
  branchBudgetTriggered: boolean,
): TaskContext {
  const snap = state.taskState.snapshot();
  const repo = state.repoContext.snapshot();
  return {
    goal: snap.goal,
    intent: snap.intent,
    domain: inferTaskDomain(snap.intent, snap.goal),
    filesChanged: [...repo.filesChanged],
    filesRead: [...repo.filesRead],
    commandsRun: [...repo.commandsRun],
    recentFailureCount: state.consecutiveToolFailures,
    branchBudgetTriggers: branchBudgetTriggered
      ? (state.branchBudget?.recoverTriggerCount ?? 1)
      : 0,
  };
}

function buildTakeoverEvidence(state: HarnessRunState): {
  recentFailedSignatures?: string[];
  pendingAcceptanceCommands?: string[];
} {
  const evidence: { recentFailedSignatures?: string[]; pendingAcceptanceCommands?: string[] } = {};

  if (state.failedToolCallSignatures && state.failedToolCallSignatures.size > 0) {
    const top = [...state.failedToolCallSignatures.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([sig, count]) => `${sig.length > 80 ? sig.slice(0, 77) + '...' : sig} (x${count})`);
    if (top.length > 0) evidence.recentFailedSignatures = top;
  }

  if (state.taskAcceptance?.isActive()) {
    const pending = state.taskAcceptance.getPendingCommands().slice(0, 3).map(c => c.label);
    if (pending.length > 0) evidence.pendingAcceptanceCommands = pending;
  }

  return evidence;
}

/** 无工具轮 after-round 包装。 */
export async function evaluateSupervisorAfterNoToolRound(
  deps: SupervisorRoundDeps,
  args: Omit<EvaluateSupervisorAfterRoundArgs, 'toolNames' | 'toolSuccess' | 'hadWriteTool' | 'allToolsFailedThisRound' | 'repeatedToolSignatures' | 'branchRecoverTriggered' | 'recoveryRoundEffective'> & {
    response: LLMResponse;
  },
): Promise<EvaluateSupervisorAfterRoundResult> {
  return evaluateSupervisorAfterRound(deps, {
    ...args,
    toolNames: [],
    toolSuccess: [],
    hadWriteTool: false,
    allToolsFailedThisRound: false,
    repeatedToolSignatures: [],
    branchRecoverTriggered: false,
    recoveryRoundEffective: false,
    lastAssistantText: typeof args.response.content === 'string' ? args.response.content : undefined,
  });
}
