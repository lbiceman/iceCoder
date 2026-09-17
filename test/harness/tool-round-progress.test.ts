import { describe, expect, it } from 'vitest';
import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import { classifyToolRoundProgress } from '../../src/harness/tool-round-progress.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import type { RunCommandResultClassification } from '../../src/harness/run-command-result.js';
import type { ToolCall } from '../../src/llm/types.js';

function tc(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, name, arguments: args };
}

function classMap(
  id: string,
  classified: RunCommandResultClassification,
): Map<string, RunCommandResultClassification> {
  return new Map([[id, classified]]);
}

/** Opaque command strings: in-list, another stack, and unmatched by current verification regex. */
const OPAQUE_COMMANDS = ['npm test', 'pytest -q', './scripts/ci.sh'] as const;

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

  it('treats ordinary reads as non-progress regardless of path', () => {
    expect(classifyToolRoundProgress({
      executableToolCalls: [tc('read_file', { path: 'src/scenes/Menu.ts' })],
      failedSignatures: [],
    })).toBe('non_progress_success');
    expect(classifyToolRoundProgress({
      executableToolCalls: [tc('read_file', { path: 'test/unit/tasks.test.ts' })],
      failedSignatures: [],
    })).toBe('non_progress_success');
  });

  it.each(OPAQUE_COMMANDS)('background start of %s is not meaningful_progress', (command) => {
    const call = tc('run_command', { command }, 'c1');
    expect(classifyToolRoundProgress({
      executableToolCalls: [call],
      failedSignatures: [],
      runCommandClassifications: classMap('c1', { kind: 'background_start', command }),
    })).toBe('non_progress_success');
  });

  it.each(OPAQUE_COMMANDS)('background running of %s is not meaningful_progress', (command) => {
    const call = tc('run_command', { command, action: 'check', task_id: 'bg' }, 'c1');
    expect(classifyToolRoundProgress({
      executableToolCalls: [call],
      failedSignatures: [],
      runCommandClassifications: classMap('c1', { kind: 'background_running', command }),
    })).toBe('non_progress_success');
  });

  it.each(OPAQUE_COMMANDS)('foreground success of %s is meaningful_progress', (command) => {
    const call = tc('run_command', { command }, 'c1');
    expect(classifyToolRoundProgress({
      executableToolCalls: [call],
      failedSignatures: [],
      runCommandClassifications: classMap('c1', {
        kind: 'foreground',
        command,
        foregroundSuccess: true,
      }),
    })).toBe('meaningful_progress');
  });

  it.each(OPAQUE_COMMANDS)('background_completed of %s is meaningful_progress', (command) => {
    const call = tc('run_command', { command, action: 'check', task_id: 'bg' }, 'c1');
    expect(classifyToolRoundProgress({
      executableToolCalls: [call],
      failedSignatures: [],
      runCommandClassifications: classMap('c1', {
        kind: 'background_completed',
        command,
        exitCode: 0,
      }),
    })).toBe('meaningful_progress');
  });

  it.each(OPAQUE_COMMANDS)('edit_file success plus background start of %s is still meaningful_progress', (command) => {
    const write = tc('edit_file', { path: 'src/a.ts', content: 'x' }, 'w1');
    const run = tc('run_command', { command }, 'c1');
    expect(classifyToolRoundProgress({
      executableToolCalls: [write, run],
      failedSignatures: [],
      runCommandClassifications: classMap('c1', { kind: 'background_start', command }),
    })).toBe('meaningful_progress');
  });

  it('unclassified run_command success is not treated as verification-by-name', () => {
    expect(classifyToolRoundProgress({
      executableToolCalls: [tc('run_command', { command: 'npm test' }, 'c1')],
      failedSignatures: [],
    })).toBe('non_progress_success');
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
