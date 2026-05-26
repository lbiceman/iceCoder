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

/** 工具轮结果：全失败/拦截 | 有实质进展 | 只读空转（如读已有 src 文件）。 */
export type ToolRoundProgress = 'all_failed_or_blocked' | 'meaningful_progress' | 'non_progress_success';

export type RecoveryRoundProgressInput = ToolRoundProgressInput;

function succeededCalls(input: ToolRoundProgressInput): ToolCall[] {
  const failed = new Set(input.failedSignatures);
  const blocked = new Set(input.policyBlockedSignatures ?? []);
  return input.executableToolCalls.filter((tc) => {
    const sig = toolCallSignature(tc);
    return !failed.has(sig) && !blocked.has(sig);
  });
}

function isMeaningfulSuccessfulTool(
  tc: ToolCall,
  branchBudget?: BranchBudgetTracker,
): boolean {
  if (isFileWriteTool(tc.name)) {
    const over = branchBudget?.shouldBranchRecover();
    if (over?.triggered && over.dimension === 'file_edit' && over.key) {
      const path = extractToolTargetPath(tc.name, tc.arguments);
      if (path && path === over.key) return false;
    }
    return true;
  }

  if (tc.name === 'run_command') {
    const command = extractRunCommand(tc.arguments);
    return !!command && isHarnessVerificationCommand(command);
  }

  if (tc.name === 'read_file') {
    const path = String(tc.arguments.path ?? tc.arguments.file_path ?? '');
    return MEANINGFUL_TEST_READ_RE.test(path);
  }

  return false;
}

/**
 * 判定工具轮是「全失败/拦截」「实质进展」还是「只读空转」。
 * 用于 consecutiveToolFailures 与 RecoveryBudget：读已有 src 文件不算进展，避免熔断/续段永远触发不了。
 */
export function classifyToolRoundProgress(input: ToolRoundProgressInput): ToolRoundProgress {
  if (input.executableToolCalls.length === 0) {
    return 'non_progress_success';
  }

  const succeeded = succeededCalls(input);
  if (succeeded.length === 0) {
    return 'all_failed_or_blocked';
  }

  if (succeeded.some(tc => isMeaningfulSuccessfulTool(tc, input.branchBudget))) {
    return 'meaningful_progress';
  }

  return 'non_progress_success';
}

/**
 * takeover 恢复段是否算作「有效进展轮」。
 * 无效轮（只读 src / 重复写卡死文件 / 全失败）不计入 RecoveryBudgetManager。
 */
export function computeRecoveryRoundEffective(input: RecoveryRoundProgressInput): boolean {
  return classifyToolRoundProgress(input) === 'meaningful_progress';
}
