import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateTokenUsageByModel,
  aggregateTokenUsageSeries,
  aggregateTokenUsageWindows,
  collectTokenUsageRecords,
  summarizeTokenUsage,
  tokenUsageEventsToRecords,
  TOKEN_USAGE_SERIES_DAYS,
  TOKEN_USAGE_SERIES_HOURS,
} from '../../src/web/token-usage-stats.js';
import type { TokenUsageLogEvent } from '../../src/llm/token-usage-log.js';

const DAY_MS = 86_400_000;

function event(partial: Partial<TokenUsageLogEvent> & Pick<TokenUsageLogEvent, 'timestamp' | 'inputTokens' | 'outputTokens'>): TokenUsageLogEvent {
  return {
    type: 'token_usage',
    source: 'chat',
    ...partial,
  };
}

describe('tokenUsageEventsToRecords', () => {
  it('reads jsonl events with model and skips empty usage', () => {
    const records = tokenUsageEventsToRecords([
      event({
        timestamp: new Date(1_700_000_000_000).toISOString(),
        inputTokens: 230930,
        outputTokens: 637,
        model: 'DeepSeek-V3.2',
      }),
      event({
        timestamp: new Date(40).toISOString(),
        inputTokens: 3,
        outputTokens: 1,
        model: 'gpt-4o',
        source: 'memory_extract',
      }),
      event({
        timestamp: new Date(20).toISOString(),
        inputTokens: 0,
        outputTokens: 0,
      }),
      event({
        timestamp: 'not-a-date',
        inputTokens: 9,
        outputTokens: 1,
      }),
    ]);
    expect(records).toEqual([
      {
        timestamp: 1_700_000_000_000,
        inputTokens: 230930,
        outputTokens: 637,
        usedModel: 'DeepSeek-V3.2',
        source: 'chat',
      },
      {
        timestamp: 40,
        inputTokens: 3,
        outputTokens: 1,
        usedModel: 'gpt-4o',
        source: 'memory_extract',
      },
    ]);
  });
});

describe('aggregateTokenUsageWindows', () => {
  it('buckets rolling 1 / 7 / 30 day windows', () => {
    const now = 1_800_000_000_000;
    const windows = aggregateTokenUsageWindows([
      { timestamp: now - 12 * 60 * 60 * 1000, inputTokens: 10, outputTokens: 1 },
      { timestamp: now - 3 * DAY_MS, inputTokens: 100, outputTokens: 5 },
      { timestamp: now - 20 * DAY_MS, inputTokens: 1000, outputTokens: 50 },
      { timestamp: now - 40 * DAY_MS, inputTokens: 9999, outputTokens: 9 },
    ], now);

    expect(windows.day).toEqual({ inputTokens: 10, outputTokens: 1, totalTokens: 11 });
    expect(windows.week).toEqual({ inputTokens: 110, outputTokens: 6, totalTokens: 116 });
    expect(windows.month).toEqual({ inputTokens: 1110, outputTokens: 56, totalTokens: 1166 });
    expect(windows.all).toEqual({ inputTokens: 11109, outputTokens: 65, totalTokens: 11174 });
  });
});

describe('aggregateTokenUsageByModel', () => {
  it('groups usage by model', () => {
    const now = 1_800_000_000_000;
    const byModel = aggregateTokenUsageByModel([
      { timestamp: now - 1000, inputTokens: 10, outputTokens: 2, usedModel: 'gpt-4o' },
      { timestamp: now - 2000, inputTokens: 5, outputTokens: 1, usedModel: 'gpt-4o' },
      { timestamp: now - 3000, inputTokens: 8, outputTokens: 4, usedModel: 'DeepSeek-V3.2' },
      { timestamp: now - 4000, inputTokens: 99, outputTokens: 1 },
    ], now);

    expect(byModel['gpt-4o']?.day).toEqual({ inputTokens: 15, outputTokens: 3, totalTokens: 18 });
    expect(byModel['DeepSeek-V3.2']?.day).toEqual({ inputTokens: 8, outputTokens: 4, totalTokens: 12 });
    expect(byModel['']).toBeUndefined();
  });
});

describe('collectTokenUsageRecords', () => {
  it('reads current and rotated jsonl, ignores session files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-token-usage-'));
    const now = Date.now();
    const logPath = path.join(dir, 'token-usage.jsonl');
    await fs.writeFile(logPath, [
      JSON.stringify({
        type: 'token_usage',
        timestamp: new Date(now - 1000).toISOString(),
        source: 'chat',
        inputTokens: 20,
        outputTokens: 3,
        model: 'MiniMax-M2.7',
      }),
      '',
    ].join('\n'));
    await fs.writeFile(`${logPath}.old`, `${JSON.stringify({
      type: 'token_usage',
      timestamp: new Date(now - 2000).toISOString(),
      source: 'memory_dream',
      inputTokens: 7,
      outputTokens: 1,
      model: 'MiniMax-M2.7',
    })}\n`);
    await fs.writeFile(path.join(dir, 'alpha.json'), JSON.stringify([
      { role: 'agent', completedAt: now, turnTokenUsage: { inputTokens: 999, outputTokens: 999 } },
    ]));

    const records = await collectTokenUsageRecords(logPath);
    expect(records).toEqual([
      {
        timestamp: now - 2000,
        inputTokens: 7,
        outputTokens: 1,
        usedModel: 'MiniMax-M2.7',
        source: 'memory_dream',
      },
      {
        timestamp: now - 1000,
        inputTokens: 20,
        outputTokens: 3,
        usedModel: 'MiniMax-M2.7',
        source: 'chat',
      },
    ]);

    const summary = await summarizeTokenUsage(logPath, now);
    expect(summary.day.totalTokens).toBe(31);
    expect(summary.all.totalTokens).toBe(31);
    expect(summary.byModel['MiniMax-M2.7']?.day.totalTokens).toBe(31);
    expect(summary.series.hourly).toHaveLength(TOKEN_USAGE_SERIES_HOURS);
    expect(summary.series.daily).toHaveLength(TOKEN_USAGE_SERIES_DAYS);
    const lastHour = summary.series.hourly[TOKEN_USAGE_SERIES_HOURS - 1];
    expect(lastHour.byKind.chat.totalTokens).toBe(23);
    expect(lastHour.byKind.memory.totalTokens).toBe(8);
    expect(lastHour.byKind.chat.turns).toBe(1);
    expect(lastHour.byKind.memory.turns).toBe(1);
  });
});

describe('aggregateTokenUsageSeries', () => {
  it('fills local hourly and daily buckets', () => {
    const now = new Date();
    now.setMinutes(30, 0, 0);
    const t = now.getTime();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const twoDaysAgoNoon = new Date(todayStart);
    twoDaysAgoNoon.setDate(twoDaysAgoNoon.getDate() - 2);
    twoDaysAgoNoon.setHours(12, 0, 0, 0);

    const series = aggregateTokenUsageSeries([
      { timestamp: t, inputTokens: 10, outputTokens: 2, usedModel: 'gpt-4o', source: 'chat' },
      { timestamp: twoDaysAgoNoon.getTime(), inputTokens: 5, outputTokens: 1, usedModel: 'DeepSeek-V3.2', source: 'memory_dream' },
    ], t);

    expect(series.hourly).toHaveLength(TOKEN_USAGE_SERIES_HOURS);
    expect(series.daily).toHaveLength(TOKEN_USAGE_SERIES_DAYS);
    expect(series.hourly[TOKEN_USAGE_SERIES_HOURS - 1].inputTokens).toBe(10);
    expect(series.hourly[TOKEN_USAGE_SERIES_HOURS - 1].turns).toBe(1);
    expect(series.hourly[TOKEN_USAGE_SERIES_HOURS - 1].byModel['gpt-4o']?.totalTokens).toBe(12);
    expect(series.hourly[TOKEN_USAGE_SERIES_HOURS - 1].byKind.chat.totalTokens).toBe(12);
    expect(series.hourly[TOKEN_USAGE_SERIES_HOURS - 1].byKind.memory.totalTokens).toBe(0);
    expect(series.daily[TOKEN_USAGE_SERIES_DAYS - 1].inputTokens).toBe(10);
    expect(series.daily[TOKEN_USAGE_SERIES_DAYS - 1].turns).toBe(1);
    expect(series.daily[TOKEN_USAGE_SERIES_DAYS - 3].inputTokens).toBe(5);
    expect(series.daily[TOKEN_USAGE_SERIES_DAYS - 3].turns).toBe(1);
    expect(series.daily[TOKEN_USAGE_SERIES_DAYS - 3].byModel['DeepSeek-V3.2']?.totalTokens).toBe(6);
    expect(series.daily[TOKEN_USAGE_SERIES_DAYS - 3].byKind.memory.totalTokens).toBe(6);
    expect(series.daily[TOKEN_USAGE_SERIES_DAYS - 3].byKind.chat.totalTokens).toBe(0);
  });
});
