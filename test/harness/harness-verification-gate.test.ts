import { describe, expect, it } from 'vitest';
import {
  maybeResetVerificationGateCounter,
  shouldResetVerificationGateCounter,
} from '../../src/harness/harness-verification-gate.js';

describe('shouldResetVerificationGateCounter', () => {
  it('blocking cleared → reset', () => {
    expect(shouldResetVerificationGateCounter(3, 3, false)).toBe(true);
  });

  it('pending decreased while still blocking → reset', () => {
    expect(shouldResetVerificationGateCounter(3, 2, true)).toBe(true);
  });

  it('tools ran but no verification progress → do not reset', () => {
    expect(shouldResetVerificationGateCounter(3, 3, true)).toBe(false);
  });

  it('pending increased → do not reset', () => {
    expect(shouldResetVerificationGateCounter(2, 3, true)).toBe(false);
  });

  it('acceptance pending decreased while still blocking → reset', () => {
    expect(shouldResetVerificationGateCounter(0, 0, true, 3, 2)).toBe(true);
  });

  it('acceptance unchanged and file pending unchanged → do not reset', () => {
    expect(shouldResetVerificationGateCounter(2, 2, true, 3, 3)).toBe(false);
  });
});

describe('maybeResetVerificationGateCounter', () => {
  it('resets counter when shouldReset is true', () => {
    const state = { verificationGateContinuationCount: 5 };
    maybeResetVerificationGateCounter(state, 2, 0, false);
    expect(state.verificationGateContinuationCount).toBe(0);
  });

  it('preserves counter when verification did not progress', () => {
    const state = { verificationGateContinuationCount: 3 };
    maybeResetVerificationGateCounter(state, 2, 2, true);
    expect(state.verificationGateContinuationCount).toBe(3);
  });
});
