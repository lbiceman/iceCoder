import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EventTimeline,
  resolveTimelinePath,
} from '../../src/harness/supervisor/event-timeline.js';

describe('EventTimeline - L2-1 / M10', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ice-timeline-'));
    tempDirs.push(dir);
    return dir;
  }

  it('appends JSONL records for core supervisor event types', async () => {
    const dir = await makeTempDir();
    const persistPath = path.join(dir, 'supervisor-events.jsonl');
    const timeline = new EventTimeline(
      { enabled: true, persistPath },
      { memoryOnly: false },
    );

    timeline.recordTyped('switch', { round: 1, mode: 'adaptive', reason: 'free->forced: pending_steps' });
    timeline.recordTyped('recover', { round: 2, mode: 'adaptive', reason: 'takeover start' });
    timeline.recordTyped('handoff', { round: 5, mode: 'adaptive', reason: 'handoff' });
    timeline.recordTyped('drift', { round: 3, mode: 'adaptive', reason: 'alignment low' });
    timeline.recordTyped('failure', { round: 6, mode: 'strict', reason: 'checkpoint' });
    timeline.recordTyped('rollback', { round: 7, mode: 'strict', reason: 'rollback' });
    timeline.recordTyped('timeout', { round: 8, mode: 'adaptive', reason: 'recovery timeout' });
    timeline.recordTyped('shadow_diagnostic', { round: 4, mode: 'adaptive', reason: 'would takeover' });

    await timeline.flush();

    const raw = await readFile(persistPath, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(8);

    const parsed = lines.map(line => JSON.parse(line));
    expect(parsed.map(row => row.event)).toEqual([
      'switch',
      'recover',
      'handoff',
      'drift',
      'failure',
      'rollback',
      'timeout',
      'shadow_diagnostic',
    ]);
    expect(parsed[0]).toMatchObject({
      round: 1,
      mode: 'adaptive',
      event: 'switch',
      reason: 'free->forced: pending_steps',
    });
    expect(typeof parsed[0].ts).toBe('number');
  });

  it('respects enabled=false and writes nothing', async () => {
    const dir = await makeTempDir();
    const persistPath = path.join(dir, 'disabled.jsonl');
    const timeline = new EventTimeline(
      { enabled: false, persistPath },
      { memoryOnly: false },
    );

    timeline.recordTyped('switch', { round: 1, mode: 'off', reason: 'ignored' });
    await timeline.flush();

    await expect(readFile(persistPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(timeline.getRecentEvents()).toEqual([]);
  });

  it('keeps recent events in memory for checkpoint tail export', () => {
    const timeline = new EventTimeline(
      { enabled: true, persistPath: 'unused.jsonl' },
      { memoryOnly: true },
    );

    for (let round = 1; round <= 5; round += 1) {
      timeline.recordTyped('switch', { round, mode: 'adaptive', reason: `r${round}` });
    }

    expect(timeline.getRecentEvents()).toHaveLength(5);
    expect(timeline.getRecentEvents(2).map(e => e.round)).toEqual([4, 5]);
  });

  it('trims in-memory buffer when maxEventsInCheckpoint is set', () => {
    const timeline = new EventTimeline(
      { enabled: true, persistPath: 'unused.jsonl', maxEventsInCheckpoint: 3 },
      { memoryOnly: true },
    );

    for (let round = 1; round <= 5; round += 1) {
      timeline.recordTyped('switch', { round, mode: 'adaptive', reason: `r${round}` });
    }

    expect(timeline.getRecentEvents().map(e => e.round)).toEqual([3, 4, 5]);
  });

  it('resolves default persist path under ICE_DATA_DIR', () => {
    const dataDir = path.join(process.cwd(), 'custom-data');
    const resolved = resolveTimelinePath('data/runtime/supervisor-events.jsonl', dataDir);
    expect(resolved).toBe(path.resolve(dataDir, 'runtime/supervisor-events.jsonl'));
  });

  it('resolves non-data paths against ICE_DATA_DIR', () => {
    const dataDir = path.join(process.cwd(), 'custom-data');
    const resolved = resolveTimelinePath('runtime/events.jsonl', dataDir);
    expect(resolved).toBe(path.resolve(dataDir, 'runtime/events.jsonl'));
  });
});
