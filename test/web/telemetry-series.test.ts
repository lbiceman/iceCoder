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
      { type: 'memory_recall', timestamp: iso(0), selectedCount: 3, usedLLM: true, durationMs: 120 },
      { type: 'memory_extract', timestamp: iso(0), usedPromptCache: true, durationMs: 400 },
      { type: 'memory_extract', timestamp: iso(0), skipReason: 'session_extract_cap' },
      { type: 'memory_dream', timestamp: iso(-86_400_000), executed: true, filesModified: 2, filesDeleted: 1, filesEvicted: 1, durationMs: 50 },
      { type: 'memory_dream', timestamp: iso(0), executed: false },
      { type: 'memory_cap_evict', timestamp: iso(0), filesEvicted: 4, durationMs: 10 },
      { type: 'session_memory', timestamp: iso(0), wrote: true },
      { type: 'session_memory', timestamp: iso(0), wrote: false },
      { type: 'memory_index_rebuild', timestamp: iso(0), entryCount: 3, trigger: 'drift' },
    ], 7, now);
    expect(series).toHaveLength(7);
    expect(series.reduce((sum, row) => sum + row.recall, 0)).toBe(1);
    expect(series.reduce((sum, row) => sum + row.extract, 0)).toBe(1);
    expect(series.reduce((sum, row) => sum + row.dream, 0)).toBe(1);
    expect(series.at(-1)?.recall).toBe(1);
    expect(series.at(-1)?.recallSelected).toBe(3);
    expect(series.at(-1)?.recallLlm).toBe(1);
    expect(series.at(-1)?.recallMs).toBe(120);
    expect(series.at(-1)?.extractCache).toBe(1);
    expect(series.at(-1)?.extractMs).toBe(400);
    expect(series.at(-1)?.extractSkip).toBe(1);
    expect(series.at(-1)?.skips.session_extract_cap).toBe(1);
    expect(series.at(-1)?.capEvict).toBe(1);
    expect(series.at(-1)?.capFiles).toBe(4);
    expect(series.at(-1)?.capMs).toBe(10);
    expect(series.at(-1)?.sessionWrote).toBe(1);
    expect(series.at(-1)?.sessionReject).toBe(1);
    expect(series.at(-1)?.indexRebuild).toBe(1);
    expect(series.at(-2)?.dream).toBe(1);
    expect(series.at(-2)?.dreamModified).toBe(2);
    expect(series.at(-2)?.dreamDeleted).toBe(1);
    expect(series.at(-2)?.dreamEvicted).toBe(1);
    expect(series.at(-2)?.dreamMs).toBe(50);
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
