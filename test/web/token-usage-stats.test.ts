import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateTurnTokenWindows,
  collectSessionTurnTokenRecords,
  extractTurnTokenRecords,
  summarizeSessionTokenUsage,
} from '../../src/web/token-usage-stats.js';

const DAY_MS = 86_400_000;

describe('extractTurnTokenRecords', () => {
  it('reads agent bubble turnTokenUsage with completedAt', () => {
    const records = extractTurnTokenRecords([
      {
        role: 'agent',
        completedAt: 1_700_000_000_000,
        turnTokenUsage: { inputTokens: 230930, outputTokens: 637 },
      },
    ]);
    expect(records).toEqual([
      { timestamp: 1_700_000_000_000, inputTokens: 230930, outputTokens: 637 },
    ]);
  });

  it('falls back to sentAt and skips empty or undated usage', () => {
    const records = extractTurnTokenRecords([
      { role: 'user', sentAt: 10, turnTokenUsage: { inputTokens: 1, outputTokens: 2 } },
      { role: 'agent', turnTokenUsage: { inputTokens: 9, outputTokens: 1 } },
      { role: 'agent', completedAt: 20, turnTokenUsage: { inputTokens: 0, outputTokens: 0 } },
      { role: 'agent', completedAt: 30, content: 'no usage' },
    ]);
    expect(records).toEqual([
      { timestamp: 10, inputTokens: 1, outputTokens: 2 },
    ]);
  });
});

describe('aggregateTurnTokenWindows', () => {
  it('buckets rolling 1 / 7 / 30 day windows', () => {
    const now = 1_800_000_000_000;
    const windows = aggregateTurnTokenWindows([
      { timestamp: now - 12 * 60 * 60 * 1000, inputTokens: 10, outputTokens: 1 },
      { timestamp: now - 3 * DAY_MS, inputTokens: 100, outputTokens: 5 },
      { timestamp: now - 20 * DAY_MS, inputTokens: 1000, outputTokens: 50 },
      { timestamp: now - 40 * DAY_MS, inputTokens: 9999, outputTokens: 9 },
    ], now);

    expect(windows.day).toEqual({ inputTokens: 10, outputTokens: 1, totalTokens: 11 });
    expect(windows.week).toEqual({ inputTokens: 110, outputTokens: 6, totalTokens: 116 });
    expect(windows.month).toEqual({ inputTokens: 1110, outputTokens: 56, totalTokens: 1166 });
  });
});

describe('collectSessionTurnTokenRecords', () => {
  it('sums turnTokenUsage from session message files only', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-token-usage-'));
    const now = Date.now();
    await fs.writeFile(path.join(dir, 'alpha.json'), JSON.stringify([
      { role: 'agent', completedAt: now - 1000, turnTokenUsage: { inputTokens: 20, outputTokens: 3 } },
    ]));
    await fs.writeFile(path.join(dir, 'alpha.structured.json'), JSON.stringify([
      { role: 'agent', completedAt: now, turnTokenUsage: { inputTokens: 999, outputTokens: 999 } },
    ]));
    await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify([]));

    const records = await collectSessionTurnTokenRecords(dir);
    expect(records).toEqual([
      { timestamp: now - 1000, inputTokens: 20, outputTokens: 3 },
    ]);

    const summary = await summarizeSessionTokenUsage(dir, now);
    expect(summary.day.totalTokens).toBe(23);
  });
});
