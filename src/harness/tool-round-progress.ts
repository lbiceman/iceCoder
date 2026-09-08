import type { ToolCall } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import { extractRunCommand, extractToolTargetPath, isFileWriteTool } from './branch-budget-tool-path.js';
import { toolCallSignature } from './harness-permission-runtime.js';
import { isHarnessVerificationCommand } from './verification-digest.js';

const MEANINGFUL_TEST_READ_RE = /\.test\.|\/test\/|\\test\\/i;

export interface ToolRoundProgressInput {
  executableToolCalls: ToolCall[];
  failedSignatures: string[];
  policyBlockedSignatures?: string[];
  branchBudget?: BranchBudgetTracker;
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

function isMeaningfulSuccessfulTool(
  call: ToolCall,
  branchBudget?: BranchBudgetTracker,
): boolean {
  if (isFileWriteTool(call.name)) {
    const over = branchBudget?.shouldBranchRecover();
    if (over?.triggered && over.dimension === 'file_edit' && over.key) {
      const path = extractToolTargetPath(call.name, call.arguments);
      if (path && path === over.key) return false;
    }
    return true;
  }
  if (call.name === 'run_command') {
    const command = extractRunCommand(call.arguments);
    return !!command && isHarnessVerificationCommand(command);
  }
  if (call.name === 'read_file') {
    const path = String(call.arguments.path ?? call.arguments.file_path ?? '');
    return MEANINGFUL_TEST_READ_RE.test(path);
  }
  return false;
}

export function classifyToolRoundProgress(input: ToolRoundProgressInput): ToolRoundProgress {
  if (input.executableToolCalls.length === 0) return 'non_progress_success';
  const succeeded = succeededCalls(input);
  if (succeeded.length === 0) return 'all_failed_or_blocked';
  return succeeded.some(call => isMeaningfulSuccessfulTool(call, input.branchBudget))
    ? 'meaningful_progress'
    : 'non_progress_success';
}
