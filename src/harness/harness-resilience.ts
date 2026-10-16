import type { ToolCall } from '../llm/types.js';
import type { CheckpointSaveTrigger } from '../types/runtime-checkpoint.js';
import type { CheckpointEngine } from './checkpoint-engine.js';
import { shouldSkipResilienceCheckpoint } from './casual-mode.js';
import type { HarnessRunState } from './harness-run-state.js';
import { toolCallSignature } from './harness-permission-runtime.js';
import type { StopReason } from './types.js';
import type { VerificationOutputTailEntry } from '../types/runtime-checkpoint.js';

export interface ResilienceBridgeDeps {
  /** 没有会话目录时不创建引擎，相关落盘路径直接跳过。 */
  checkpointEngine?: CheckpointEngine;
  enqueueCheckpointPersist: <T>(task: () => Promise<T>) => Promise<T>;
  workspaceRoot?: string;
}

function checkpointVerificationOutputTail(state: HarnessRunState): VerificationOutputTailEntry[] | undefined {
  return state.verificationOutputBuffer?.snapshot();
}

/**
 * 记录一轮工具调用到 checkpointEngine。没有 checkpoint 引擎（无会话目录）时跳过。
 *
 * 磁盘写入必须经 enqueueCheckpointPersist，与 TaskCheckpointManager 串行，避免绕过队列与 v1 save 交叉 rename。
 */
export async function resilienceRecordToolCalls(
  deps: ResilienceBridgeDeps,
  toolCalls: ToolCall[],
  failedSignatures: Set<string>,
  state: HarnessRunState,
): Promise<void> {
  if (!deps.checkpointEngine) return;

  const engine = deps.checkpointEngine;

  for (const tc of toolCalls) {
    const sig = toolCallSignature(tc);
    if (failedSignatures.has(sig)) {
      await deps.enqueueCheckpointPersist(async () => {
        try {
          await engine.save({
            trigger: 'tool_failed',
            verificationOutputTail: checkpointVerificationOutputTail(state),
            appendFailure: {
              signature: sig,
              count: 1,
              at: Date.now(),
            },
            appendTool: {
              toolName: tc.name,
              success: false,
              signature: sig,
              at: Date.now(),
            },
          });
        } catch (err) {
          console.warn(
            '[harness] resilience v2 save (tool_failed) failed:',
            err instanceof Error ? err.message : err,
          );
        }
      });
      continue;
    }

    engine.stage({
      trigger: 'step_completed',
      verificationOutputTail: checkpointVerificationOutputTail(state),
      appendTool: {
        toolName: tc.name,
        success: true,
        signature: sig,
        at: Date.now(),
      },
    });
  }
  // step_completed 由本轮收尾的 saveTaskCheckpoint 一次落盘，这里只 stage。
}

/**
 * v2 checkpoint 合并保存。在以下 hook 点调用：
 *   tool_failed / verification_failed / compaction / final_draft
 */
export async function resilienceSaveCheckpoint(
  deps: ResilienceBridgeDeps,
  trigger: CheckpointSaveTrigger,
  state: HarnessRunState | undefined,
  stopReason?: StopReason,
): Promise<void> {
  if (!deps.checkpointEngine) return;
  if (!state) return;
  if (shouldSkipResilienceCheckpoint(state.taskState.snapshot().intent)) return;

  const engine = deps.checkpointEngine;
  if (!engine.shouldPersistOnTrigger(trigger)) return;

  await deps.enqueueCheckpointPersist(async () => {
    try {
      await engine.save({
        trigger,
        verificationOutputTail: checkpointVerificationOutputTail(state),
        lastStopReason: stopReason,
      });
    } catch (err) {
      console.warn(
        `[harness] resilience v2 save (${trigger}) failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  });
}
