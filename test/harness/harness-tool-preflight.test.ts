import { describe, expect, it } from 'vitest';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import { TaskState } from '../../src/harness/task-state.js';
import {
  buildDiagnosticGateMessage,
  checkDelegatePreflight,
  checkToolPreflight,
  isDistArtifactPath,
  shouldActivateBuildDiagnosticGate,
  shouldClearBuildDiagnosticGate,
  taskMentionsBlockedVerificationPipeline,
} from '../../src/harness/harness-tool-preflight.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';

describe('harness-tool-preflight', () => {
  it('blocks read_file on dist when verification failed', () => {
    const taskState = new TaskState('goal');
    taskState.forceVerificationFailed();
    const decision = checkToolPreflight({
      toolName: 'read_file',
      args: { path: 'dist/src/scenes/MapSelectScene.js' },
      taskState,
    });
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('dist_read');
    expect(isDistArtifactPath('build/out.js')).toBe(true);
  });

  it('blocks build commands under diagnostic gate but allows tsc --noEmit', () => {
    const blocked = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'npm run build 2>&1' },
      buildDiagnosticGateActive: true,
    });
    expect(blocked.blocked).toBe(true);

    const allowed = checkToolPreflight({
      toolName: 'run_command',
      args: { command: 'npx tsc --noEmit 2>&1' },
      buildDiagnosticGateActive: true,
    });
    expect(allowed.blocked).toBe(false);
  });

  it('activates diagnostic gate when build command hits branch budget', () => {
    const budget = new BranchBudgetTracker({ commandRetryMax: 2 });
    budget.recordFailedCommandAttempt('npm run build 2>&1');
    budget.recordFailedCommandAttempt('npm run build 2>&1');
    const tc = { name: 'run_command', arguments: { command: 'npm run build 2>&1' } };
    const sig = toolCallSignature(tc);
    expect(shouldActivateBuildDiagnosticGate({
      branchBudget: budget,
      executionFailedSignatures: [],
      policyBlockedSignatures: [sig],
      toolCalls: [tc],
      signatureOf: toolCallSignature,
    })).toBe(true);
    expect(buildDiagnosticGateMessage()).toMatch(/Diagnostic Gate/);
  });

  it('blocks delegate tasks that rerun build under diagnostic gate', () => {
    const blocked = checkDelegatePreflight({
      task: 'Execute npm run build 2>&1 and report stderr',
      buildDiagnosticGateActive: true,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('delegate_build_blocked');
  });

  it('blocks delegate tasks with implicit build intent when regex misses commands', () => {
    expect(taskMentionsBlockedVerificationPipeline('Fix build until it passes')).toBe(true);
    const blocked = checkDelegatePreflight({
      task: 'Please fix the build pipeline until verification passes',
      buildDiagnosticGateActive: true,
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe('delegate_build_blocked');
  });

  it('allows read-only delegate tasks under diagnostic gate', () => {
    const allowed = checkDelegatePreflight({
      task: 'Read-only inspect src/scenes/MainMenuScene.ts and explain the bug',
      buildDiagnosticGateActive: true,
    });
    expect(allowed.blocked).toBe(false);
  });

  it('clears diagnostic gate after successful src edit', () => {
    const tc = { name: 'edit_file', arguments: { path: 'src/scenes/MainMenuScene.ts' } };
    expect(shouldClearBuildDiagnosticGate({
      toolCalls: [tc],
      failedSignatures: [],
      signatureOf: toolCallSignature,
    })).toBe(true);
  });
});
