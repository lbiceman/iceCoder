import { describe, expect, it, vi } from 'vitest';

import type { ForcedDegradedTier } from '../../src/types/supervisor.js';
import { computeForcedDegradedTier } from '../../src/harness/supervisor/forced-degraded.js';

describe('Forced degraded tier classification - Batch 5 / W1', () => {
  it('returns null when execution is not forced', () => {
    expect(
      computeForcedDegradedTier({
        executionMode: 'free',
        graphInitFailed: true,
        forceSwitchTriggered: true,
        plannedToolCount: 1,
        executableToolCount: 0,
        plannedHadWriteTool: true,
      }),
    ).toBeNull();
  });

  it('returns graph when forced + graph init failed', () => {
    expect(
      computeForcedDegradedTier({
        executionMode: 'forced',
        graphInitFailed: true,
        forceSwitchTriggered: false,
        plannedToolCount: 0,
        executableToolCount: 0,
        plannedHadWriteTool: false,
      }),
    ).toBe<ForcedDegradedTier>('graph');
  });

  it('returns step_queue when forced + evaluateRound force_switch triggered', () => {
    expect(
      computeForcedDegradedTier({
        executionMode: 'forced',
        graphInitFailed: false,
        forceSwitchTriggered: true,
        plannedToolCount: 1,
        executableToolCount: 1,
        plannedHadWriteTool: false,
      }),
    ).toBe<ForcedDegradedTier>('step_queue');
  });

  it('returns write_intent when forced + every planned write tool was blocked', () => {
    expect(
      computeForcedDegradedTier({
        executionMode: 'forced',
        graphInitFailed: false,
        forceSwitchTriggered: false,
        plannedToolCount: 2,
        executableToolCount: 0,
        plannedHadWriteTool: true,
      }),
    ).toBe<ForcedDegradedTier>('write_intent');
  });

  it('does not invent a tier in normal forced rounds', () => {
    expect(
      computeForcedDegradedTier({
        executionMode: 'forced',
        graphInitFailed: false,
        forceSwitchTriggered: false,
        plannedToolCount: 1,
        executableToolCount: 1,
        plannedHadWriteTool: false,
      }),
    ).toBeNull();
  });
});
