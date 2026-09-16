import { describe, expect, it, vi } from 'vitest';

import {
  createVerificationRuntimeState,
  isVerificationFresh,
  markVerificationFailed,
  markVerificationPassed,
  markVerificationUnavailable,
  recordVerificationCommandResult,
  sanitizeVerificationRuntimeState,
  syncVerificationWorkspaceMutation,
  tryConsumeVerificationContinuation,
} from '../../src/harness/verification-state.js';
import { TaskState } from '../../src/harness/task-state.js';
import { buildVerificationPlan } from '../../src/harness/verification-plan.js';

describe('verification-state', () => {
  it('creates a JSON-persistable non-fresh state with non-negative counters', () => {
    const state = createVerificationRuntimeState();

    expect(state).toEqual({
      workspaceMutationVersion: 0,
      verifiedMutationVersion: null,
      verifiedPlanFingerprint: null,
      attemptedMutationVersion: null,
      attemptedPlanFingerprint: null,
      continuationCount: 0,
      blockingSignature: null,
      lastResult: null,
      commandProgress: [],
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(isVerificationFresh(state, 'plan-a')).toBe(false);
  });

  it('becomes fresh only after a pass at the current version and fingerprint', () => {
    const state = createVerificationRuntimeState();
    const taskState = new TaskState('edit');
    taskState.recordCommandWorkspaceMutation(['src/a.ts']);
    syncVerificationWorkspaceMutation(state, taskState);
    markVerificationPassed(state, {
      planFingerprint: 'plan-a',
      source: 'user',
      command: 'npm test',
      exitCode: 0,
      evidenceRef: 'tool-1',
    });

    expect(state.lastResult).toEqual({
      status: 'passed',
      source: 'user',
      command: 'npm test',
      exitCode: 0,
      evidenceRef: 'tool-1',
    });
    expect(state.verifiedMutationVersion).toBe(state.workspaceMutationVersion);
    expect(isVerificationFresh(state, 'plan-a')).toBe(true);
    expect(isVerificationFresh(state, 'plan-b')).toBe(false);
  });

  it('makes a previous pass stale after a workspace mutation', () => {
    const state = createVerificationRuntimeState();
    const taskState = new TaskState('edit');
    markVerificationPassed(state, {
      planFingerprint: 'plan-a',
      source: 'project',
    });
    expect(isVerificationFresh(state, 'plan-a')).toBe(true);

    taskState.recordCommandWorkspaceMutation(['src/a.ts']);
    syncVerificationWorkspaceMutation(state, taskState);

    expect(isVerificationFresh(state, 'plan-a')).toBe(false);
    expect(state.lastResult?.status).toBe('passed');
  });

  it('clears verified and attempted identities when mutation version saturates', () => {
    const state = createVerificationRuntimeState();
    const taskState = new TaskState('edit');
    taskState.applySnapshot({
      ...taskState.snapshot(),
      workspaceMutationVersion: Number.MAX_SAFE_INTEGER,
    });
    state.workspaceMutationVersion = Number.MAX_SAFE_INTEGER;
    state.verifiedMutationVersion = Number.MAX_SAFE_INTEGER;
    state.verifiedPlanFingerprint = 'plan-a';
    state.attemptedMutationVersion = Number.MAX_SAFE_INTEGER;
    state.attemptedPlanFingerprint = 'plan-a';

    syncVerificationWorkspaceMutation(state, taskState);

    expect(state.verifiedMutationVersion).toBeNull();
    expect(state.verifiedPlanFingerprint).toBeNull();
    expect(state.attemptedMutationVersion).toBeNull();
    expect(state.attemptedPlanFingerprint).toBeNull();
  });

  it('records failed and unavailable results without treating them as fresh', () => {
    const state = createVerificationRuntimeState();
    markVerificationPassed(state, {
      planFingerprint: 'plan-a',
      source: 'runtime_default',
    });

    markVerificationFailed(state, {
      planFingerprint: 'plan-a',
      source: 'runtime_default',
      command: 'npm test',
      exitCode: 1,
      evidenceRef: 'tool-2',
      blockingSignature: 'npm-test:1',
    });
    expect(state.lastResult).toEqual({
      status: 'failed',
      source: 'runtime_default',
      command: 'npm test',
      exitCode: 1,
      evidenceRef: 'tool-2',
    });
    expect(state.blockingSignature).toBe('npm-test:1');
    expect(state.verifiedMutationVersion).toBe(0);
    expect(state.verifiedPlanFingerprint).toBe('plan-a');
    expect(state.attemptedMutationVersion).toBe(0);
    expect(state.attemptedPlanFingerprint).toBe('plan-a');
    expect(isVerificationFresh(state, 'plan-a')).toBe(false);

    markVerificationUnavailable(state, {
      planFingerprint: 'plan-a',
      source: 'runtime_default',
      command: 'npm test',
      evidenceRef: 'tool-3',
      blockingSignature: 'runner-unavailable',
    });
    expect(state.lastResult?.status).toBe('unavailable');
    expect(state.blockingSignature).toBe('runner-unavailable');
    expect(state.attemptedMutationVersion).toBe(0);
    expect(state.attemptedPlanFingerprint).toBe('plan-a');
    expect(isVerificationFresh(state, 'plan-a')).toBe(false);
  });

  it('records attempts without populating verified fields before any pass', () => {
    const state = createVerificationRuntimeState();

    markVerificationFailed(state, {
      planFingerprint: 'plan-a',
      source: 'user',
      exitCode: 1,
    });

    expect(state.verifiedMutationVersion).toBeNull();
    expect(state.verifiedPlanFingerprint).toBeNull();
    expect(state.attemptedMutationVersion).toBe(0);
    expect(state.attemptedPlanFingerprint).toBe('plan-a');
  });

  it('keeps the previous pass identity when a newer plan attempt fails', () => {
    const state = createVerificationRuntimeState();
    const taskState = new TaskState('edit');
    markVerificationPassed(state, {
      planFingerprint: 'plan-old',
      source: 'project',
    });
    taskState.recordCommandWorkspaceMutation(['src/a.ts']);
    syncVerificationWorkspaceMutation(state, taskState);

    markVerificationFailed(state, {
      planFingerprint: 'plan-new',
      source: 'project',
      exitCode: 1,
    });

    expect(state.verifiedMutationVersion).toBe(0);
    expect(state.verifiedPlanFingerprint).toBe('plan-old');
    expect(state.attemptedMutationVersion).toBe(1);
    expect(state.attemptedPlanFingerprint).toBe('plan-new');
  });

  it('treats TaskState mutation version as the authoritative source on restore', () => {
    const state = createVerificationRuntimeState();
    state.workspaceMutationVersion = 5;
    state.verifiedMutationVersion = 5;
    state.verifiedPlanFingerprint = 'plan-a';
    state.lastResult = { status: 'passed', source: 'user' };

    syncVerificationWorkspaceMutation(state, new TaskState('legacy snapshot'));

    expect(state.workspaceMutationVersion).toBe(0);
    expect(state.verifiedMutationVersion).toBeNull();
    expect(state.verifiedPlanFingerprint).toBeNull();
    expect(isVerificationFresh(state, 'plan-a')).toBe(false);
  });

  it('does not consult wall-clock time when deciding freshness', () => {
    const state = createVerificationRuntimeState();
    markVerificationPassed(state, {
      planFingerprint: 'plan-a',
      source: 'user',
    });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('freshness must not depend on time');
    });

    expect(isVerificationFresh(state, 'plan-a')).toBe(true);
    now.mockRestore();
  });

  it('sanitizes malformed persisted state and clamps counters to non-negative integers', () => {
    const sanitized = sanitizeVerificationRuntimeState({
      workspaceMutationVersion: -7,
      verifiedMutationVersion: 3.9,
      verifiedPlanFingerprint: 42,
      continuationCount: -9,
      blockingSignature: '',
      lastResult: {
        status: 'failed',
        source: 'project',
        command: 7,
        exitCode: Number.NaN,
        evidenceRef: 'tool-4',
      },
    });

    expect(sanitized).toEqual({
      workspaceMutationVersion: 0,
      verifiedMutationVersion: null,
      verifiedPlanFingerprint: null,
      attemptedMutationVersion: null,
      attemptedPlanFingerprint: null,
      continuationCount: 0,
      blockingSignature: null,
      lastResult: {
        status: 'failed',
        source: 'project',
        evidenceRef: 'tool-4',
      },
      commandProgress: [],
    });
  });

  it('records exact successful command-chain segments and marks the plan fresh', () => {
    const plan = buildVerificationPlan({
      source: 'user',
      commands: ['npm test', 'npm run lint'],
      workspaceRoot: process.cwd(),
    })!;
    const state = createVerificationRuntimeState();

    const recorded = recordVerificationCommandResult(state, {
      plan,
      result: {
        kind: 'foreground',
        command: 'cd /d D:\\repo && npm test 2>&1 && npm run lint 2>&1',
        foregroundSuccess: true,
        exitCode: 0,
      },
      evidenceRef: 'tool-chain',
    });

    expect(recorded).toEqual({
      matchedCommands: ['npm test', 'npm run lint'],
      allRequiredPassed: true,
    });
    expect(state.commandProgress).toEqual([
      expect.objectContaining({
        command: 'npm test',
        status: 'passed',
        mutationVersion: 0,
        evidenceRef: 'tool-chain',
      }),
      expect.objectContaining({
        command: 'npm run lint',
        status: 'passed',
        mutationVersion: 0,
        evidenceRef: 'tool-chain',
      }),
    ]);
    expect(isVerificationFresh(state, plan.fingerprint)).toBe(true);
  });

  it('records only the exact failed plan command and ignores unrelated probes', () => {
    const plan = buildVerificationPlan({
      source: 'project',
      commands: ['npm test', 'npm run lint'],
      workspaceRoot: process.cwd(),
    })!;
    const state = createVerificationRuntimeState();

    recordVerificationCommandResult(state, {
      plan,
      result: {
        kind: 'foreground',
        command: 'npm test',
        foregroundSuccess: true,
        exitCode: 0,
      },
      evidenceRef: 'tool-test',
    });
    const unrelated = recordVerificationCommandResult(state, {
      plan,
      result: {
        kind: 'foreground',
        command: 'git diff --name-only -- test/',
        foregroundSuccess: false,
        exitCode: 129,
      },
      evidenceRef: 'tool-diff',
    });
    const failed = recordVerificationCommandResult(state, {
      plan,
      result: {
        kind: 'foreground',
        command: 'npm run lint',
        foregroundSuccess: false,
        exitCode: 2,
      },
      evidenceRef: 'tool-lint',
    });

    expect(unrelated).toEqual({ matchedCommands: [], allRequiredPassed: false });
    expect(failed).toEqual({
      matchedCommands: ['npm run lint'],
      allRequiredPassed: false,
    });
    expect(state.commandProgress.map(item => ({
      command: item.command,
      status: item.status,
      evidenceRef: item.evidenceRef,
    }))).toEqual([
      { command: 'npm test', status: 'passed', evidenceRef: 'tool-test' },
      { command: 'npm run lint', status: 'failed', evidenceRef: 'tool-lint' },
    ]);
    expect(state.lastResult).toMatchObject({
      status: 'failed',
      command: 'npm run lint',
      exitCode: 2,
    });
    expect(isVerificationFresh(state, plan.fingerprint)).toBe(false);
  });

  it('ignores background start/running and naturally stales progress after mutation', () => {
    const plan = buildVerificationPlan({
      source: 'runtime_default',
      commands: ['npm test'],
      workspaceRoot: process.cwd(),
    })!;
    const state = createVerificationRuntimeState();

    for (const result of [
      { kind: 'background_start', command: 'npm test' },
      { kind: 'background_running', command: 'npm test' },
    ] as const) {
      expect(recordVerificationCommandResult(state, {
        plan,
        result,
        evidenceRef: `tool-${result.kind}`,
      })).toEqual({ matchedCommands: [], allRequiredPassed: false });
    }
    expect(state.commandProgress).toEqual([]);

    recordVerificationCommandResult(state, {
      plan,
      result: {
        kind: 'background_completed',
        command: 'npm test',
        exitCode: 0,
      },
      evidenceRef: 'tool-complete',
    });
    expect(isVerificationFresh(state, plan.fingerprint)).toBe(true);

    const taskState = new TaskState('edit');
    taskState.recordCommandWorkspaceMutation(['src/a.ts']);
    syncVerificationWorkspaceMutation(state, taskState);

    expect(isVerificationFresh(state, plan.fingerprint)).toBe(false);
    expect(state.commandProgress[0]?.mutationVersion).toBe(0);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('requires every required command to pass at the same mutation version', () => {
    const plan = buildVerificationPlan({
      source: 'user',
      commands: ['npm test', 'npm run lint'],
      workspaceRoot: process.cwd(),
    })!;
    const state = createVerificationRuntimeState();
    recordVerificationCommandResult(state, {
      plan,
      result: { kind: 'foreground', command: 'npm test', foregroundSuccess: true },
      evidenceRef: 'test-v0',
    });

    const taskState = new TaskState('edit');
    taskState.recordCommandWorkspaceMutation(['src/a.ts']);
    syncVerificationWorkspaceMutation(state, taskState);
    const partial = recordVerificationCommandResult(state, {
      plan,
      result: { kind: 'foreground', command: 'npm run lint', foregroundSuccess: true },
      evidenceRef: 'lint-v1',
    });

    expect(partial.allRequiredPassed).toBe(false);
    expect(isVerificationFresh(state, plan.fingerprint)).toBe(false);

    const complete = recordVerificationCommandResult(state, {
      plan,
      result: { kind: 'foreground', command: 'npm test', foregroundSuccess: true },
      evidenceRef: 'test-v1',
    });
    expect(complete.allRequiredPassed).toBe(true);
    expect(isVerificationFresh(state, plan.fingerprint)).toBe(true);
  });

  it.each([
    {
      workspaceMutationVersion: -1,
      verifiedMutationVersion: 0,
      verifiedPlanFingerprint: 'plan-a',
    },
    {
      workspaceMutationVersion: 1.5,
      verifiedMutationVersion: 1,
      verifiedPlanFingerprint: 'plan-a',
    },
    {
      workspaceMutationVersion: 1,
      verifiedMutationVersion: -1,
      verifiedPlanFingerprint: 'plan-a',
    },
    {
      workspaceMutationVersion: 1,
      verifiedMutationVersion: 1.5,
      verifiedPlanFingerprint: 'plan-a',
    },
    {
      workspaceMutationVersion: 1,
      verifiedMutationVersion: 2,
      verifiedPlanFingerprint: 'plan-a',
    },
    {
      workspaceMutationVersion: 1,
      verifiedMutationVersion: 1,
      verifiedPlanFingerprint: null,
    },
    {
      workspaceMutationVersion: 1,
      verifiedPlanFingerprint: 'plan-a',
    },
    {
      verifiedMutationVersion: 0,
      verifiedPlanFingerprint: 'plan-a',
    },
  ])('fails closed for malformed freshness state %#', (freshness) => {
    const state = sanitizeVerificationRuntimeState({
      ...freshness,
      continuationCount: 0,
      blockingSignature: null,
      lastResult: { status: 'passed', source: 'user' },
    });

    expect(isVerificationFresh(state, 'plan-a')).toBe(false);
  });

  it('does not restore a passed result without complete verification evidence', () => {
    const state = sanitizeVerificationRuntimeState({
      workspaceMutationVersion: 2,
      verifiedMutationVersion: 2,
      verifiedPlanFingerprint: '',
      continuationCount: 0,
      lastResult: { status: 'passed', source: 'user' },
    });

    expect(state.verifiedMutationVersion).toBeNull();
    expect(state.verifiedPlanFingerprint).toBeNull();
    expect(isVerificationFresh(state, 'plan-a')).toBe(false);
  });

  it('sanitizes into a detached state and falls back for invalid input', () => {
    const persisted = {
      workspaceMutationVersion: 4,
      verifiedMutationVersion: 4,
      verifiedPlanFingerprint: 'plan-a',
      attemptedMutationVersion: 4,
      attemptedPlanFingerprint: 'plan-a',
      continuationCount: 2,
      blockingSignature: null,
      lastResult: {
        status: 'passed',
        source: 'user',
        command: 'npm test',
        exitCode: 0,
      },
    };
    const restored = sanitizeVerificationRuntimeState(persisted);
    persisted.workspaceMutationVersion = 99;

    expect(restored.workspaceMutationVersion).toBe(4);
    expect(isVerificationFresh(restored, 'plan-a')).toBe(true);
    expect(sanitizeVerificationRuntimeState(null)).toEqual(createVerificationRuntimeState());
  });

  it('consumes continuation budget without direct field mutation', () => {
    const state = createVerificationRuntimeState();

    expect(tryConsumeVerificationContinuation(state, 1)).toBe(true);
    expect(state.continuationCount).toBe(1);
    expect(tryConsumeVerificationContinuation(state, 1)).toBe(false);
    expect(state.continuationCount).toBe(1);
    expect(tryConsumeVerificationContinuation(state, -1)).toBe(false);
  });
});
