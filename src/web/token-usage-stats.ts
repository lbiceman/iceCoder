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
  usedModel?: string;
}

export type TokenUsageByModel = Record<string, TokenUsageWindows>;

export interface TokenUsageSummary extends TokenUsageWindows {
  byModel: TokenUsageByModel;
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

function readUsedModel(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * 从 UI 会话消息中抽出带时间戳的 turnTokenUsage。
 * 时间优先 completedAt（agent 气泡完成时刻），否则 sentAt。
 * 使用模型以消息级 `usedModel` 为准；兼容旧数据写在 turnTokenUsage.model / usedModel。
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

    const usedModel = readUsedModel(msg.usedModel)
      || readUsedModel((usage as Record<string, unknown>).usedModel)
      || readUsedModel((usage as Record<string, unknown>).model);
    records.push({
      timestamp,
      inputTokens,
      outputTokens,
      ...(usedModel ? { usedModel } : {}),
    });
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

export function aggregateTurnTokenByModel(
  records: TurnTokenRecord[],
  now = Date.now(),
): TokenUsageByModel {
  const grouped = new Map<string, TurnTokenRecord[]>();
  for (const record of records) {
    const key = record.usedModel || '';
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }
  const out: TokenUsageByModel = {};
  for (const [model, list] of grouped) {
    out[model] = aggregateTurnTokenWindows(list, now);
  }
  return out;
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
): Promise<TokenUsageSummary> {
  const records = await collectSessionTurnTokenRecords(sessionsDir);
  return {
    ...aggregateTurnTokenWindows(records, now),
    byModel: aggregateTurnTokenByModel(records, now),
  };
}
