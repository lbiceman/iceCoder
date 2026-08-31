import { describe, expect, it } from 'vitest';
import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import { classifyToolRoundProgress } from '../../src/harness/tool-round-progress.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import type { ToolCall } from '../../src/llm/types.js';

function tc(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, name, arguments: args };
}

describe('classifyToolRoundProgress', () => {
  it('classifies fully failed or blocked rounds', () => {
    const failed = [tc('read_file', { path: 'src/a.ts' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: failed,
      failedSignatures: [toolCallSignature(failed[0]!)],
    })).toBe('all_failed_or_blocked');

    const blocked = [tc('write_file', { path: 'src/a.ts', content: 'x' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: blocked,
      failedSignatures: [],
      policyBlockedSignatures: [toolCallSignature(blocked[0]!)],
    })).toBe('all_failed_or_blocked');
  });

  it('distinguishes useful evidence from read-only spinning', () => {
    expect(classifyToolRoundProgress({
      executableToolCalls: [tc('read_file', { path: 'src/scenes/Menu.ts' })],
      failedSignatures: [],
    })).toBe('non_progress_success');
    expect(classifyToolRoundProgress({
      executableToolCalls: [tc('read_file', { path: 'test/unit/tasks.test.ts' })],
      failedSignatures: [],
    })).toBe('meaningful_progress');
    expect(classifyToolRoundProgress({
      executableToolCalls: [tc('run_command', { command: 'npm test' })],
      failedSignatures: [],
    })).toBe('meaningful_progress');
  });

  it('allows progress on another file while one file is over budget', () => {
    const budget = new BranchBudgetTracker({ fileEditMax: 1 });
    budget.recordFileEdit('src/tasks.ts');
    budget.recordFileEdit('src/tasks.ts');
    expect(classifyToolRoundProgress({
      executableToolCalls: [tc('write_file', { path: 'src/other.ts', content: 'x' })],
      failedSignatures: [],
      branchBudget: budget,
    })).toBe('meaningful_progress');
  });
});
