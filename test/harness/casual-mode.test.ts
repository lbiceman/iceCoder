import { describe, it, expect } from 'vitest';
import { shouldApplyCasualHarness } from '../../src/harness/casual-mode.js';

describe('casual-mode', () => {
  it('question / inspect 默认启用减负', () => {
    expect(shouldApplyCasualHarness('question')).toBe(true);
    expect(shouldApplyCasualHarness('inspect')).toBe(true);
  });

  it('工程 intent 不启用减负', () => {
    expect(shouldApplyCasualHarness('edit')).toBe(false);
    expect(shouldApplyCasualHarness('debug')).toBe(false);
  });
});
