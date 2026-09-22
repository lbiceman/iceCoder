/**
 * Token 用量独立账本：每次 LLM 成功调用追加一行 JSONL。
 * 与会话文件解耦，删除会话不影响统计。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getTokenUsageLogPath } from '../cli/paths.js';
import type { TokenUsage, TokenUsageSource } from './types.js';

export const TOKEN_USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface TokenUsageLogEvent {
  type: 'token_usage';
  timestamp: string;
  source: TokenUsageSource;
  inputTokens: number;
  outputTokens: number;
  sessionId?: string;
  model?: string;
  provider?: string;
  cacheReadTokens?: number;
  cacheMissTokens?: number;
  cacheCreationTokens?: number;
}

const TOKEN_USAGE_SOURCES: ReadonlySet<TokenUsageSource> = new Set([
  'chat',
  'compaction',
  'memory_extract',
  'memory_recall',
  'memory_dream',
  'step_review',
  'image_read',
  'sub_agent',
  'unknown',
]);

export function normalizeTokenUsageSource(value: unknown): TokenUsageSource {
  return typeof value === 'string' && TOKEN_USAGE_SOURCES.has(value as TokenUsageSource)
    ? value as TokenUsageSource
    : 'unknown';
}

export function resolveUsedModel(
  provider: { model?: unknown },
  options?: { model?: unknown },
): string {
  const fromOpts = typeof options?.model === 'string' ? options.model.trim() : '';
  if (fromOpts) return fromOpts;
  return typeof provider.model === 'string' && provider.model.trim() ? provider.model.trim() : '';
}

let writeChain: Promise<void> = Promise.resolve();

export function recordTokenUsage(event: Omit<TokenUsageLogEvent, 'type' | 'timestamp'>): void {
  const inputTokens = Math.max(0, event.inputTokens || 0);
  const outputTokens = Math.max(0, event.outputTokens || 0);
  if (inputTokens <= 0 && outputTokens <= 0) return;

  const payload: TokenUsageLogEvent = {
    type: 'token_usage',
    timestamp: new Date().toISOString(),
    source: normalizeTokenUsageSource(event.source),
    inputTokens,
    outputTokens,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.cacheReadTokens ? { cacheReadTokens: event.cacheReadTokens } : {}),
    ...(event.cacheMissTokens ? { cacheMissTokens: event.cacheMissTokens } : {}),
    ...(event.cacheCreationTokens ? { cacheCreationTokens: event.cacheCreationTokens } : {}),
  };

  const filePath = getTokenUsageLogPath();
  writeChain = writeChain.then(() => appendTokenUsageLine(filePath, payload)).catch(() => undefined);
}

export function recordTokenUsageFromCall(
  usage: TokenUsage,
  provider: { name?: string; model?: unknown },
  options?: { usageSource?: TokenUsageSource; sessionId?: string; model?: string },
): void {
  const sessionId = typeof options?.sessionId === 'string' && options.sessionId.trim()
    ? options.sessionId.trim()
    : undefined;
  const model = resolveUsedModel(provider, options);
  recordTokenUsage({
    source: options?.usageSource ?? 'unknown',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(sessionId ? { sessionId } : {}),
    ...(model ? { model } : {}),
    ...(usage.provider || provider.name ? { provider: usage.provider || provider.name } : {}),
    ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheMissTokens ? { cacheMissTokens: usage.cacheMissTokens } : {}),
    ...(usage.cacheCreationTokens ? { cacheCreationTokens: usage.cacheCreationTokens } : {}),
  });
}

async function appendTokenUsageLine(filePath: string, event: TokenUsageLogEvent): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > TOKEN_USAGE_LOG_MAX_BYTES) {
      await fs.rename(filePath, `${filePath}.old`).catch(() => undefined);
    }
  } catch {
    // 文件不存在时直接写
  }
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
}

export async function flushTokenUsageLog(): Promise<void> {
  await writeChain;
}

export async function readTokenUsageLogEvents(logPath?: string): Promise<TokenUsageLogEvent[]> {
  const primary = logPath ?? getTokenUsageLogPath();
  const events: TokenUsageLogEvent[] = [];
  for (const file of [`${primary}.old`, primary]) {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as TokenUsageLogEvent;
        if (parsed?.type === 'token_usage') events.push(parsed);
      } catch {
        // 跳过损坏行
      }
    }
  }
  return events;
}
