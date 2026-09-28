/**
 * 子 Agent 结束后把系统记录并入父 Harness 的运行时状态：
 * - 改动文件 → 父 TaskState / RepoContext（等同父 Agent 自己写过这些文件，推进 mutation version）
 * - 验证证据 → 父 VerificationState（只在命令之后工作区再无任何写入时导入）
 */

import type { ToolCall } from '../../llm/types.js';
import type { RepoContext } from '../repo-context.js';
import type { RunCommandResultClassification } from '../run-command-result.js';
import type { TaskState } from '../task-state.js';
import type { VerificationPlan } from '../verification-plan.js';
import type { VerificationRuntimeState } from '../verification-state.js';
import { recordVerificationCommandResult } from '../verification-state.js';
import type { AgentFileChange } from './agent-result.js';

export interface AgentEvidenceRecord {
  toolCallId: string;
  classification: RunCommandResultClassification;
}

export interface AgentTaskOutcome {
  agentId: string;
  filesChanged: AgentFileChange[];
  /** 已按新鲜度过滤：命令之后没有任何子 Agent 再写工作区 */
  freshEvidence: AgentEvidenceRecord[];
}

function syntheticFileCall(parentToolCallId: string, index: number, change: AgentFileChange): ToolCall {
  const id = `${parentToolCallId}:merge:${index}`;
  if (change.deleted) {
    return { id, name: 'fs_operation', arguments: { operation: 'delete', path: change.path } };
  }
  return { id, name: 'write_file', arguments: { path: change.path } };
}

export function mergeAgentFileChanges(
  parentToolCallId: string,
  outcome: AgentTaskOutcome,
  target: { taskState: TaskState; repoContext: RepoContext },
): void {
  outcome.filesChanged.forEach((change, index) => {
    const call = syntheticFileCall(parentToolCallId, index, change);
    const result = { success: true, output: `[sub-agent ${outcome.agentId}] ${change.path}` };
    target.taskState.recordToolResult(call, result);
    target.repoContext.recordToolResult(call, result);
  });
}

/** 须在父 verificationState 已同步最新 mutation version 之后调用。 */
export function importAgentVerificationEvidence(
  outcome: AgentTaskOutcome,
  verificationState: VerificationRuntimeState,
  plan: VerificationPlan | null,
): number {
  if (!plan) return 0;
  let imported = 0;
  for (const evidence of outcome.freshEvidence) {
    const recorded = recordVerificationCommandResult(verificationState, {
      plan,
      result: evidence.classification,
      evidenceRef: `${outcome.agentId}:${evidence.toolCallId}`,
    });
    if (recorded.matchedCommands.length > 0) imported++;
  }
  return imported;
}
