import type { ToolCall } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import { extractToolTargetPath, isFileWriteTool } from './branch-budget-tool-path.js';
import { toolCallSignature } from './harness-permission-runtime.js';

export interface RecoveryRoundProgressInput {
  executableToolCalls: ToolCall[];
  failedSignatures: string[];
  branchBudget?: BranchBudgetTracker;
}

/**
 * takeover 恢复段是否算作「有效进展轮」。
 * 无效轮（仅重复写同一卡死文件 / 全失败且无读测试）不计入 RecoveryBudgetManager。
 */
export function computeRecoveryRoundEffective(input: RecoveryRoundProgressInput): boolean {
  const failed = new Set(input.failedSignatures);

  for (const tc of input.executableToolCalls) {
    if (failed.has(toolCallSignature(tc))) continue;

    if (tc.name === 'run_command') return true;

    if (tc.name === 'read_file') {
      const path = String(tc.arguments.path ?? '');
      if (/\.test\.|\/test\/|\\test\\/i.test(path)) return true;
    }
  }

  const over = input.branchBudget?.shouldBranchRecover();
  if (over?.triggered && over.dimension === 'file_edit' && over.key) {
    for (const tc of input.executableToolCalls) {
      if (failed.has(toolCallSignature(tc))) continue;
      if (!isFileWriteTool(tc.name)) continue;
      const path = extractToolTargetPath(tc.name, tc.arguments);
      if (path && path !== over.key) return true;
    }
    return false;
  }

  return input.executableToolCalls.some(tc => !failed.has(toolCallSignature(tc)));
}
