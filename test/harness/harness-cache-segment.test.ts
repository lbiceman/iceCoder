import { describe, expect, it, vi } from 'vitest';
import { logCacheSegmentReset } from '../../src/harness/harness-cache-segment.js';

describe('logCacheSegmentReset', () => {
  it('logs round and reason', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logCacheSegmentReset(5, 'proactive-fork');
    expect(spy).toHaveBeenCalledWith('[cache-segment] reset round=5 reason=proactive-fork');
    spy.mockRestore();
  });
});
