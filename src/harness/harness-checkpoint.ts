import type { UnifiedMessage } from '../llm/types.js';
import type { TaskCheckpointManager, TaskCheckpointStatus, TaskCheckpointUpdate } from './checkpoint.js';
import type { LoopController } from './loop-controller.js';
import type { RepoContext } from './repo-context.js';
import type { RuntimeTelemetry } from './runtime-telemetry.js';
import type { TaskState } from './task-state.js';
import type { StopReason } from './types.js';

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
  runtimeState: {
    taskState: TaskState;
    repoContext: RepoContext;
  },
): void {
  const loopState = deps.loopController.getState();
  const task = runtimeState.taskState.snapshot();
  deps.runtimeTelemetry?.recordSummary({
    stopReason,
    task,
    repo: runtimeState.repoContext.snapshot(),
    rounds: loopState.currentRound,
    toolCalls: loopState.totalToolCalls,
    verificationRate: task.verificationStatus === 'passed' ? 1 : 0,
    noToolFinal: loopState.totalToolCalls === 0,
    tokensPerSuccessfulTask: stopReason === 'model_done'
      ? loopState.totalInputTokens + loopState.totalOutputTokens
      : undefined,
  });
}
