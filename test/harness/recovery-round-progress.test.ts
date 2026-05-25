import { describe, expect, it } from 'vitest';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import { computeRecoveryRoundEffective } from '../../src/harness/recovery-round-progress.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import type { ToolCall } from '../../src/llm/types.js';

function tc(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, name, arguments: args };
}

describe('computeRecoveryRoundEffective', () => {
  it('true when run_command succeeds', () => {
    const calls = [tc('run_command', { command: 'npm test' })];
    expect(computeRecoveryRoundEffective({
      executableToolCalls: calls,
      failedSignatures: [],
    })).toBe(true);
  });

  it('true when read_file on test path succeeds', () => {
    const calls = [tc('read_file', { path: 'test/unit/tasks.test.ts' })];
    expect(computeRecoveryRoundEffective({
      executableToolCalls: calls,
      failedSignatures: [],
    })).toBe(true);
  });

  it('false when only repeated failed write to overheated file', () => {
    const budget = new BranchBudgetTracker({ fileEditMax: 1 });
    budget.recordFileEdit('src/tasks.ts');
    budget.recordFileEdit('src/tasks.ts');

    const calls = [tc('write_file', { path: 'src/tasks.ts', content: 'x' })];
    const failed = [toolCallSignature(calls[0]!)];
    expect(computeRecoveryRoundEffective({
      executableToolCalls: calls,
      failedSignatures: failed,
      branchBudget: budget,
    })).toBe(false);
  });

  it('true when writing a different file while one file is overheated', () => {
    const budget = new BranchBudgetTracker({ fileEditMax: 1 });
    budget.recordFileEdit('src/tasks.ts');
    budget.recordFileEdit('src/tasks.ts');

    const calls = [tc('write_file', { path: 'src/other.ts', content: 'x' })];
    expect(computeRecoveryRoundEffective({
      executableToolCalls: calls,
      failedSignatures: [],
      branchBudget: budget,
    })).toBe(true);
  });
});
