import { describe, expect, it } from 'vitest';
import { gateProbeBaseline } from '../../src/harness/gate-probe-baseline';

describe('gateProbeBaseline', () => {
  it('returns the baseline marker string', () => {
    expect(gateProbeBaseline()).toBe('gate-probe-baseline');
  });
});
