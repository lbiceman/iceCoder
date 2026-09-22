/**
 * 从 token-usage.jsonl 汇总 Token 消耗（与会话文件无关）。
 */

import {
  readTokenUsageLogEvents,
  type TokenUsageLogEvent,
} from '../llm/token-usage-log.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const TOKEN_USAGE_WINDOW_DAYS = {
  day: 1,
  week: 7,
  month: 30,
} as const;

export const TOKEN_USAGE_SERIES_HOURS = 24;
export const TOKEN_USAGE_SERIES_DAYS = 31;

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsageWindows {
  day: TokenUsageTotals;
  week: TokenUsageTotals;
  month: TokenUsageTotals;
  all: TokenUsageTotals;
}

export interface TokenUsageKindTotals extends TokenUsageTotals {
  turns: number;
}

export interface TokenUsageByKind {
  chat: TokenUsageKindTotals;
  memory: TokenUsageKindTotals;
}

export interface TokenUsageBucket extends TokenUsageTotals {
  key: string;
  timestamp: number;
  turns: number;
  byModel: Record<string, TokenUsageTotals>;
  byKind: TokenUsageByKind;
}

export interface TokenUsageSeries {
  hourly: TokenUsageBucket[];
  daily: TokenUsageBucket[];
}

export interface TokenUsageRecord {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  usedModel?: string;
  source?: string;
}

export type TokenUsageByModel = Record<string, TokenUsageWindows>;

export interface TokenUsageSummary extends TokenUsageWindows {
  byModel: TokenUsageByModel;
  series: TokenUsageSeries;
}

export function emptyTokenUsageTotals(): TokenUsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function emptyTokenUsageKindTotals(): TokenUsageKindTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 };
}

export function emptyTokenUsageByKind(): TokenUsageByKind {
  return {
    chat: emptyTokenUsageKindTotals(),
    memory: emptyTokenUsageKindTotals(),
  };
}

export function isMemoryTokenSource(source?: string): boolean {
  return source === 'memory_extract'
    || source === 'memory_recall'
    || source === 'memory_dream';
}

export function emptyTokenUsageWindows(): TokenUsageWindows {
  return {
    day: emptyTokenUsageTotals(),
    week: emptyTokenUsageTotals(),
    month: emptyTokenUsageTotals(),
    all: emptyTokenUsageTotals(),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfLocalDay(ts: number): Date {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfLocalHour(ts: number): Date {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d;
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localHourKey(d: Date): string {
  return `${localDateKey(d)}T${pad2(d.getHours())}:00`;
}

function emptyTokenUsageBucket(key: string, timestamp: number): TokenUsageBucket {
  return {
    key,
    timestamp,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turns: 0,
    byModel: {},
    byKind: emptyTokenUsageByKind(),
  };
}

function addUsage(target: TokenUsageTotals, inputTokens: number, outputTokens: number): void {
  target.inputTokens += inputTokens;
  target.outputTokens += outputTokens;
  target.totalTokens += inputTokens + outputTokens;
}

function readFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function tokenUsageEventsToRecords(events: TokenUsageLogEvent[]): TokenUsageRecord[] {
  const records: TokenUsageRecord[] = [];
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    const inputTokens = Math.max(0, readFiniteNumber(event.inputTokens));
    const outputTokens = Math.max(0, readFiniteNumber(event.outputTokens));
    if (inputTokens <= 0 && outputTokens <= 0) continue;
    const usedModel = typeof event.model === 'string' && event.model.trim() ? event.model.trim() : '';
    records.push({
      timestamp,
      inputTokens,
      outputTokens,
      ...(usedModel ? { usedModel } : {}),
      ...(event.source ? { source: event.source } : {}),
    });
  }
  return records;
}

export function aggregateTokenUsageWindows(
  records: TokenUsageRecord[],
  now = Date.now(),
): TokenUsageWindows {
  const windows = emptyTokenUsageWindows();
  const dayCutoff = now - TOKEN_USAGE_WINDOW_DAYS.day * DAY_MS;
  const weekCutoff = now - TOKEN_USAGE_WINDOW_DAYS.week * DAY_MS;
  const monthCutoff = now - TOKEN_USAGE_WINDOW_DAYS.month * DAY_MS;

  for (const record of records) {
    addUsage(windows.all, record.inputTokens, record.outputTokens);
    if (record.timestamp >= monthCutoff) {
      addUsage(windows.month, record.inputTokens, record.outputTokens);
    }
    if (record.timestamp >= weekCutoff) {
      addUsage(windows.week, record.inputTokens, record.outputTokens);
    }
    if (record.timestamp >= dayCutoff) {
      addUsage(windows.day, record.inputTokens, record.outputTokens);
    }
  }

  return windows;
}

function addToBucket(bucket: TokenUsageBucket, record: TokenUsageRecord): void {
  bucket.turns += 1;
  addUsage(bucket, record.inputTokens, record.outputTokens);
  const kind = isMemoryTokenSource(record.source) ? 'memory' : 'chat';
  bucket.byKind[kind].turns += 1;
  addUsage(bucket.byKind[kind], record.inputTokens, record.outputTokens);
  const model = record.usedModel;
  if (!model) return;
  if (!bucket.byModel[model]) bucket.byModel[model] = emptyTokenUsageTotals();
  addUsage(bucket.byModel[model], record.inputTokens, record.outputTokens);
}

/** 本地时区下的 24 小时桶 + 31 天日桶，供统计页面积图使用。 */
export function aggregateTokenUsageSeries(
  records: TokenUsageRecord[],
  now = Date.now(),
): TokenUsageSeries {
  const hourStart = startOfLocalHour(now);
  const hourly: TokenUsageBucket[] = [];
  const hourlyMap = new Map<string, TokenUsageBucket>();
  for (let i = TOKEN_USAGE_SERIES_HOURS - 1; i >= 0; i -= 1) {
    const ts = hourStart.getTime() - i * HOUR_MS;
    const key = localHourKey(new Date(ts));
    const bucket = emptyTokenUsageBucket(key, ts);
    hourly.push(bucket);
    hourlyMap.set(key, bucket);
  }

  const dayStart = startOfLocalDay(now);
  const daily: TokenUsageBucket[] = [];
  const dailyMap = new Map<string, TokenUsageBucket>();
  for (let i = TOKEN_USAGE_SERIES_DAYS - 1; i >= 0; i -= 1) {
    const d = new Date(dayStart);
    d.setDate(d.getDate() - i);
    const key = localDateKey(d);
    const bucket = emptyTokenUsageBucket(key, d.getTime());
    daily.push(bucket);
    dailyMap.set(key, bucket);
  }

  const hourCutoff = hourly[0]?.timestamp ?? now;
  const dayCutoff = daily[0]?.timestamp ?? now;

  for (const record of records) {
    if (record.timestamp >= hourCutoff) {
      const bucket = hourlyMap.get(localHourKey(startOfLocalHour(record.timestamp)));
      if (bucket) addToBucket(bucket, record);
    }
    if (record.timestamp >= dayCutoff) {
      const bucket = dailyMap.get(localDateKey(startOfLocalDay(record.timestamp)));
      if (bucket) addToBucket(bucket, record);
    }
  }

  return { hourly, daily };
}

export function aggregateTokenUsageByModel(
  records: TokenUsageRecord[],
  now = Date.now(),
): TokenUsageByModel {
  const grouped = new Map<string, TokenUsageRecord[]>();
  for (const record of records) {
    const key = record.usedModel || '';
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }
  const out: TokenUsageByModel = {};
  for (const [model, list] of grouped) {
    out[model] = aggregateTokenUsageWindows(list, now);
  }
  return out;
}

export async function collectTokenUsageRecords(logPath?: string): Promise<TokenUsageRecord[]> {
  return tokenUsageEventsToRecords(await readTokenUsageLogEvents(logPath));
}

export async function summarizeTokenUsage(
  logPath?: string,
  now = Date.now(),
): Promise<TokenUsageSummary> {
  const records = await collectTokenUsageRecords(logPath);
  return {
    ...aggregateTokenUsageWindows(records, now),
    byModel: aggregateTokenUsageByModel(records, now),
    series: aggregateTokenUsageSeries(records, now),
  };
}
