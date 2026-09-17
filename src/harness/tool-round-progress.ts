import type { ToolCall } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import { extractToolTargetPath, isFileWriteTool } from './branch-budget-tool-path.js';
import { toolCallSignature } from './harness-permission-runtime.js';
import type { RunCommandResultClassification } from './run-command-result.js';

export interface ToolRoundProgressInput {
  executableToolCalls: ToolCall[];
  failedSignatures: string[];
  policyBlockedSignatures?: string[];
  branchBudget?: BranchBudgetTracker;
  /** 按 toolCall.id 对照 classifyRunCommandResult；不看命令是否像测试。 */
  runCommandClassifications?: ReadonlyMap<string, RunCommandResultClassification>;
}

export type ToolRoundProgress = 'all_failed_or_blocked' | 'meaningful_progress' | 'non_progress_success';

function succeededCalls(input: ToolRoundProgressInput): ToolCall[] {
  const failed = new Set(input.failedSignatures);
  const blocked = new Set(input.policyBlockedSignatures ?? []);
  return input.executableToolCalls.filter((call) => {
    const signature = toolCallSignature(call);
    return !failed.has(signature) && !blocked.has(signature);
  });
}

function isCompletedRunCommand(classified: RunCommandResultClassification | undefined): boolean {
  if (!classified) return false;
  if (classified.kind === 'background_start' || classified.kind === 'background_running') {
    return false;
  }
  if (classified.kind === 'background_failed') return false;
  if (classified.kind === 'background_completed') return true;
  return classified.kind === 'foreground' && classified.foregroundSuccess;
}

function isMeaningfulSuccessfulTool(
  call: ToolCall,
  input: ToolRoundProgressInput,
): boolean {
  if (isFileWriteTool(call.name)) {
    const over = input.branchBudget?.shouldBranchRecover();
    if (over?.triggered && over.dimension === 'file_edit' && over.key) {
      const path = extractToolTargetPath(call.name, call.arguments);
      if (path && path === over.key) return false;
    }
    return true;
  }
  if (call.name === 'run_command') {
    return isCompletedRunCommand(input.runCommandClassifications?.get(call.id));
  }
  return false;
}

export function classifyToolRoundProgress(input: ToolRoundProgressInput): ToolRoundProgress {
  if (input.executableToolCalls.length === 0) return 'non_progress_success';
  const succeeded = succeededCalls(input);
  if (succeeded.length === 0) return 'all_failed_or_blocked';
  return succeeded.some(call => isMeaningfulSuccessfulTool(call, input))
    ? 'meaningful_progress'
    : 'non_progress_success';
}
