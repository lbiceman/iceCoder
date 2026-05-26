import { describe, expect, it } from 'vitest';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import {
  classifyToolRoundProgress,
  computeRecoveryRoundEffective,
} from '../../src/harness/recovery-round-progress.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import type { ToolCall } from '../../src/llm/types.js';

function tc(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, name, arguments: args };
}

describe('classifyToolRoundProgress', () => {
  it('all_failed_or_blocked when every call fails', () => {
    const calls = [tc('read_file', { path: 'src/a.ts' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: calls,
      failedSignatures: [toolCallSignature(calls[0]!)],
    })).toBe('all_failed_or_blocked');
  });

  it('all_failed_or_blocked when every call is policy-blocked', () => {
    const calls = [tc('write_file', { path: 'src/a.ts', content: 'x' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: calls,
      failedSignatures: [],
      policyBlockedSignatures: [toolCallSignature(calls[0]!)],
    })).toBe('all_failed_or_blocked');
  });

  it('non_progress_success when only src read succeeds', () => {
    const calls = [tc('read_file', { path: 'src/scenes/Menu.ts' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: calls,
      failedSignatures: [],
    })).toBe('non_progress_success');
  });

  it('meaningful_progress when test file read succeeds', () => {
    const calls = [tc('read_file', { path: 'test/unit/tasks.test.ts' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: calls,
      failedSignatures: [],
    })).toBe('meaningful_progress');
  });

  it('meaningful_progress when verification command succeeds', () => {
    const calls = [tc('run_command', { command: 'npm test' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: calls,
      failedSignatures: [],
    })).toBe('meaningful_progress');
  });

  it('non_progress_success for diagnostic shell even when command succeeds', () => {
    const calls = [tc('run_command', { command: 'dir src/scenes' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: calls,
      failedSignatures: [],
    })).toBe('non_progress_success');
  });

  it('meaningful_progress when writing a different file while one file is overheated', () => {
    const budget = new BranchBudgetTracker({ fileEditMax: 1 });
    budget.recordFileEdit('src/tasks.ts');
    budget.recordFileEdit('src/tasks.ts');

    const calls = [tc('write_file', { path: 'src/other.ts', content: 'x' })];
    expect(classifyToolRoundProgress({
      executableToolCalls: calls,
      failedSignatures: [],
      branchBudget: budget,
    })).toBe('meaningful_progress');
  });
});

describe('computeRecoveryRoundEffective', () => {
  it('true when run_command verification succeeds', () => {
    const calls = [tc('run_command', { command: 'npm test' })];
    expect(computeRecoveryRoundEffective({
      executableToolCalls: calls,
      failedSignatures: [],
    })).toBe(true);
  });

  it('false when only src read succeeds', () => {
    const calls = [tc('read_file', { path: 'src/scenes/Menu.ts' })];
    expect(computeRecoveryRoundEffective({
      executableToolCalls: calls,
      failedSignatures: [],
    })).toBe(false);
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

  it('false when all calls policy-blocked', () => {
    const calls = [tc('write_file', { path: 'src/a.ts', content: 'x' })];
    expect(computeRecoveryRoundEffective({
      executableToolCalls: calls,
      failedSignatures: [],
      policyBlockedSignatures: [toolCallSignature(calls[0]!)],
    })).toBe(false);
  });
});
