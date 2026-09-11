import type { UnifiedMessage } from '../llm/types.js';
import type { TaskCheckpointManager, TaskCheckpointStatus, TaskCheckpointUpdate } from './checkpoint.js';
import type { LoopController } from './loop-controller.js';
import type { RepoContext } from './repo-context.js';
import type { RuntimeTelemetry } from './runtime-telemetry.js';
import type { TaskState } from './task-state.js';
import type { StopReason } from './types.js';
import type { HarnessRunState } from './harness-run-state.js';
import { CompletionFactsView } from './completion-facts-view.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import type { OperationOutcomeLedger } from './operation-outcome.js';
import type { CompletionCondition } from './completion-condition.js';
import type {
  CompletionGateReason,
  CompletionStatus,
} from './completion-gate.js';

export interface CheckpointDeps {
  checkpointManager?: TaskCheckpointManager;
  loopController: LoopController;
  runtimeTelemetry?: RuntimeTelemetry;
  enqueueCheckpointPersist: <T>(task: () => Promise<T>) => Promise<T>;
}

export interface CheckpointRuntimeState {
  taskState: TaskState;
  repoContext: RepoContext;
  failedToolCallSignatures: Map<string, number>;
  branchBudget?: BranchBudgetTracker;
  operationOutcomes?: OperationOutcomeLedger;
  restoredCompletionConditions?: CompletionCondition[];
  taskAcceptance?: HarnessRunState['taskAcceptance'];
  completionGateContinuationCount?: number;
  completionGateBlockingSignature?: string;
  completionStatus?: CompletionStatus;
  completionReason?: CompletionGateReason;
}

export async function saveTaskCheckpoint(
  deps: CheckpointDeps,
  status: TaskCheckpointStatus,
  userGoal: string,
  messages: UnifiedMessage[],
  runtimeState: CheckpointRuntimeState | undefined,
  stopReason?: StopReason,
): Promise<void> {
  if (!deps.checkpointManager || !runtimeState) return;

  await deps.enqueueCheckpointPersist(async () => {
    try {
      const failedToolCalls = [...runtimeState.failedToolCallSignatures.entries()]
        .filter(([, count]) => count > 0)
        .map(([signature, count]) => `${signature} (x${count})`);

      const checkpointSave: TaskCheckpointUpdate = {
        status,
        userGoal,
        taskState: runtimeState.taskState.snapshot(),
        repoContext: runtimeState.repoContext.snapshot(),
        loopState: deps.loopController.getState(),
        messages,
        failedToolCalls,
        stopReason,
        completion: {
          conditions: CompletionFactsView.fromHarnessRunState(
            runtimeState as HarnessRunState,
          ).conditionSnapshot(),
          operationOutcomes: runtimeState.operationOutcomes?.snapshot() ?? [],
          status: runtimeState.completionStatus,
          reason: runtimeState.completionReason,
          continuationCount: runtimeState.completionGateContinuationCount ?? 0,
          blockingSignature: runtimeState.completionGateBlockingSignature,
        },
        resumableExecution: {
          branchBudget: runtimeState.branchBudget?.snapshot(),
          failedToolCallSignatures: Object.fromEntries(runtimeState.failedToolCallSignatures),
        },
      };
      await deps.checkpointManager!.save(checkpointSave);
    } catch (err) {
      console.debug('[harness] checkpoint save failed:', err instanceof Error ? err.message : err);
    }
  });
}

export function recordTelemetrySummary(
  deps: CheckpointDeps,
  stopReason: StopReason,
  runtimeState: HarnessRunState,
  completion?: {
    status: import('./completion-gate.js').CompletionStatus;
    reason: import('./completion-gate.js').CompletionGateReason;
  },
): void {
  const loopState = deps.loopController.getState();
  const task = runtimeState.taskState.snapshot();
  const verification = CompletionFactsView.fromHarnessRunState(runtimeState).verificationSignal();
  deps.runtimeTelemetry?.recordSummary({
    stopReason,
    ...(completion
      ? { completionStatus: completion.status, completionReason: completion.reason }
      : {}),
    task,
    repo: runtimeState.repoContext.snapshot(),
    rounds: loopState.currentRound,
    toolCalls: loopState.totalToolCalls,
    verificationRate: verification.status === 'passed' ? 1 : 0,
    noToolFinal: loopState.totalToolCalls === 0,
    tokensPerSuccessfulTask: stopReason === 'model_done'
      ? loopState.totalInputTokens + loopState.totalOutputTokens
      : undefined,
    harnessPolicy: runtimeState.harnessPolicyStats,
  });
}
