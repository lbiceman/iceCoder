/**
 * 按会话 UI 消息上的 turnTokenUsage（气泡「合计」）汇总 Token 消耗。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sessionIdFromMessageFileName } from './session-index-store.js';

const DAY_MS = 86_400_000;

export const TOKEN_USAGE_WINDOW_DAYS = {
  day: 1,
  week: 7,
  month: 30,
} as const;

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsageWindows {
  day: TokenUsageTotals;
  week: TokenUsageTotals;
  month: TokenUsageTotals;
}

export interface TurnTokenRecord {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
}

export function emptyTokenUsageTotals(): TokenUsageTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function emptyTokenUsageWindows(): TokenUsageWindows {
  return {
    day: emptyTokenUsageTotals(),
    week: emptyTokenUsageTotals(),
    month: emptyTokenUsageTotals(),
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

/**
 * 从 UI 会话消息中抽出带时间戳的 turnTokenUsage。
 * 时间优先 completedAt（agent 气泡完成时刻），否则 sentAt。
 */
export function extractTurnTokenRecords(messages: unknown): TurnTokenRecord[] {
  const records: TurnTokenRecord[] = [];
  if (!Array.isArray(messages)) return records;

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const usage = msg.turnTokenUsage;
    if (!usage || typeof usage !== 'object') continue;

    const inputTokens = Math.max(0, readFiniteNumber((usage as Record<string, unknown>).inputTokens));
    const outputTokens = Math.max(0, readFiniteNumber((usage as Record<string, unknown>).outputTokens));
    if (inputTokens <= 0 && outputTokens <= 0) continue;

    const completedAt = readFiniteNumber(msg.completedAt);
    const sentAt = readFiniteNumber(msg.sentAt);
    const timestamp = completedAt > 0 ? completedAt : sentAt;
    if (timestamp <= 0) continue;

    records.push({ timestamp, inputTokens, outputTokens });
  }

  return records;
}

export function aggregateTurnTokenWindows(
  records: TurnTokenRecord[],
  now = Date.now(),
): TokenUsageWindows {
  const windows = emptyTokenUsageWindows();
  const dayCutoff = now - TOKEN_USAGE_WINDOW_DAYS.day * DAY_MS;
  const weekCutoff = now - TOKEN_USAGE_WINDOW_DAYS.week * DAY_MS;
  const monthCutoff = now - TOKEN_USAGE_WINDOW_DAYS.month * DAY_MS;

  for (const record of records) {
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

export async function collectSessionTurnTokenRecords(sessionsDir: string): Promise<TurnTokenRecord[]> {
  const names = await fs.readdir(sessionsDir).catch((): string[] => []);
  const batches = await Promise.all(names.map(async (name) => {
    if (!sessionIdFromMessageFileName(name)) return [] as TurnTokenRecord[];
    try {
      const raw = await fs.readFile(path.join(sessionsDir, name), 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return extractTurnTokenRecords(parsed);
    } catch {
      return [] as TurnTokenRecord[];
    }
  }));
  return batches.flat();
}

export async function summarizeSessionTokenUsage(
  sessionsDir: string,
  now = Date.now(),
): Promise<TokenUsageWindows> {
  const records = await collectSessionTurnTokenRecords(sessionsDir);
  return aggregateTurnTokenWindows(records, now);
}
