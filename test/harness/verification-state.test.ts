import { describe, expect, it, vi } from 'vitest';

import {
  createVerificationRuntimeState,
  isVerificationFresh,
  markVerificationFailed,
  markVerificationPassed,
  markVerificationUnavailable,
  markWorkspaceMutation,
  sanitizeVerificationRuntimeState,
  tryConsumeVerificationContinuation,
} from '../../src/harness/verification-state.js';

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
    });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(isVerificationFresh(state, 'plan-a')).toBe(false);
  });

  it('becomes fresh only after a pass at the current version and fingerprint', () => {
    const state = createVerificationRuntimeState();
    markWorkspaceMutation(state);
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
    markVerificationPassed(state, {
      planFingerprint: 'plan-a',
      source: 'project',
    });
    expect(isVerificationFresh(state, 'plan-a')).toBe(true);

    markWorkspaceMutation(state);

    expect(isVerificationFresh(state, 'plan-a')).toBe(false);
    expect(state.lastResult?.status).toBe('passed');
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
    markVerificationPassed(state, {
      planFingerprint: 'plan-old',
      source: 'project',
    });
    markWorkspaceMutation(state);

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
    });
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
