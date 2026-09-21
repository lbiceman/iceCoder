import { describe, expect, it } from 'vitest';
import { aggregateMemorySeries } from '../../src/web/routes/memory-telemetry.js';
import { makeTimeBuckets } from '../../src/web/telemetry-series.js';

describe('telemetry time buckets', () => {
  it('uses 24 hourly slots for a 1-day window', () => {
    const now = Date.parse('2026-09-21T15:30:00+08:00');
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    const buckets = makeTimeBuckets(1, now);
    expect(buckets).toHaveLength(24);
    expect(buckets[0]?.timestamp).toBe(hourStart.getTime() - 23 * 3_600_000);
    expect(buckets.at(-1)?.timestamp).toBe(hourStart.getTime());
  });

  it('uses daily slots for a 7-day window', () => {
    const now = Date.parse('2026-09-21T15:30:00+08:00');
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const buckets = makeTimeBuckets(7, now);
    expect(buckets).toHaveLength(7);
    expect(buckets[0]?.timestamp).toBe(dayStart.getTime() - 6 * 86_400_000);
    expect(buckets.at(-1)?.timestamp).toBe(dayStart.getTime());
  });
});

describe('memory telemetry series', () => {
  it('counts recall / extract / executed dream and ignores skips', () => {
    const now = Date.parse('2026-09-21T15:30:00+08:00');
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    const series = aggregateMemorySeries([
      { type: 'memory_recall', timestamp: iso(0) },
      { type: 'memory_extract', timestamp: iso(0) },
      { type: 'memory_extract', timestamp: iso(0), skipReason: 'empty' },
      { type: 'memory_dream', timestamp: iso(-86_400_000), executed: true },
      { type: 'memory_dream', timestamp: iso(0), executed: false },
    ], 7, now);
    expect(series).toHaveLength(7);
    expect(series.reduce((sum, row) => sum + row.recall, 0)).toBe(1);
    expect(series.reduce((sum, row) => sum + row.extract, 0)).toBe(1);
    expect(series.reduce((sum, row) => sum + row.dream, 0)).toBe(1);
    expect(series.at(-1)?.recall).toBe(1);
    expect(series.at(-2)?.dream).toBe(1);
  });

  it('clamps rolling-window events that fall before the first hour slot', () => {
    const now = Date.parse('2026-09-21T15:30:00+08:00');
    const series = aggregateMemorySeries([
      { type: 'memory_recall', timestamp: new Date(now - 23.5 * 3_600_000).toISOString() },
    ], 1, now);
    expect(series).toHaveLength(24);
    expect(series[0]?.recall).toBe(1);
  });
});
