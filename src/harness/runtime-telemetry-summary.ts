import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { RuntimeTelemetryEvent } from './runtime-telemetry.js';

type RuntimeTelemetryLogEntry = RuntimeTelemetryEvent & Record<string, unknown>;

export interface RuntimeTelemetrySessionSummary {
  sessionId: string;
  rounds: number;
  toolCalls: number;
  failedToolCalls: number;
  summaries: number;
  verificationRate: number;
  noToolFinalRate: number;
  tokensPerSuccessfulTask: number;
  compactionSavedTokens: number;
  hostGuardBlocks: number;
}

export interface RuntimeTelemetrySummary {
  generatedAt: string;
  source: string;
  days: number;
  eventsRead: number;
  sessions: number;
  rounds: number;
  toolCalls: number;
  failedToolCalls: number;
  verificationRate: number;
  noToolFinalRate: number;
  tokensPerSuccessfulTask: number;
  compactionSavedTokens: number;
  hostGuardBlocks: number;
  permissionDecisions: Record<string, number>;
  sessionsDetail: RuntimeTelemetrySessionSummary[];
}

interface MutableSessionStats {
  sessionId: string;
  rounds: number;
  toolCalls: number;
  failedToolCalls: number;
  summaries: number;
  verificationRateTotal: number;
  noToolFinalCount: number;
  tokensPerSuccessfulTaskTotal: number;
  tokensPerSuccessfulTaskCount: number;
  compactionEventSavedTokens: number;
  summaryCompactionSavedTokens: number;
  hostGuardBlocks: number;
}

function emptySessionStats(sessionId: string): MutableSessionStats {
  return {
    sessionId,
    rounds: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    summaries: 0,
    verificationRateTotal: 0,
    noToolFinalCount: 0,
    tokensPerSuccessfulTaskTotal: 0,
    tokensPerSuccessfulTaskCount: 0,
    compactionEventSavedTokens: 0,
    summaryCompactionSavedTokens: 0,
    hostGuardBlocks: 0,
  };
}

export async function readRuntimeTelemetryJsonl(
  filePath: string,
  days = 30,
): Promise<RuntimeTelemetryLogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const cutoff = Date.now() - Math.max(1, days) * 86_400_000;
  const entries: RuntimeTelemetryLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RuntimeTelemetryLogEntry;
      const ts = typeof parsed.timestamp === 'string' ? new Date(parsed.timestamp).getTime() : 0;
      if (Number.isFinite(ts) && ts >= cutoff) entries.push(parsed);
    } catch {
      // Ignore partial/corrupt JSONL lines.
    }
  }
  return entries;
}

export function aggregateRuntimeTelemetry(
  entries: RuntimeTelemetryLogEntry[],
  options: { source: string; days: number; generatedAt?: string },
): RuntimeTelemetrySummary {
  const sessions = new Map<string, MutableSessionStats>();
  const permissionDecisions: Record<string, number> = {};

  const sessionFor = (sessionId: string | undefined): MutableSessionStats => {
    const key = sessionId || 'unknown';
    const existing = sessions.get(key);
    if (existing) return existing;
    const created = emptySessionStats(key);
    sessions.set(key, created);
    return created;
  };

  for (const event of entries) {
    const session = sessionFor(typeof event.sessionId === 'string' ? event.sessionId : undefined);
    switch (event.type) {
      case 'round':
        session.rounds++;
        break;
      case 'tool': {
        session.toolCalls++;
        if (!event.success) session.failedToolCalls++;
        const permission = typeof event.permission === 'string' && event.permission.trim()
          ? event.permission.trim()
          : 'unknown';
        permissionDecisions[permission] = (permissionDecisions[permission] ?? 0) + 1;
        break;
      }
      case 'compaction':
        session.compactionEventSavedTokens += event.savedTokens || 0;
        break;
      case 'host_guard_block':
        session.hostGuardBlocks++;
        break;
      case 'summary':
        session.summaries++;
        session.verificationRateTotal += event.verificationRate || 0;
        if (event.noToolFinal) session.noToolFinalCount++;
        if (typeof event.tokensPerSuccessfulTask === 'number' && Number.isFinite(event.tokensPerSuccessfulTask)) {
          session.tokensPerSuccessfulTaskTotal += event.tokensPerSuccessfulTask;
          session.tokensPerSuccessfulTaskCount++;
        }
        session.summaryCompactionSavedTokens = Math.max(
          session.summaryCompactionSavedTokens,
          event.compactionSavedTokens || 0,
        );
        break;
    }
  }

  const sessionStats = [...sessions.values()];
  const sessionsDetail = sessionStats
    .map((s): RuntimeTelemetrySessionSummary => ({
      sessionId: s.sessionId,
      rounds: s.rounds,
      toolCalls: s.toolCalls,
      failedToolCalls: s.failedToolCalls,
      summaries: s.summaries,
      verificationRate: s.summaries > 0 ? s.verificationRateTotal / s.summaries : 0,
      noToolFinalRate: s.summaries > 0 ? s.noToolFinalCount / s.summaries : 0,
      tokensPerSuccessfulTask: s.tokensPerSuccessfulTaskCount > 0
        ? s.tokensPerSuccessfulTaskTotal / s.tokensPerSuccessfulTaskCount
        : 0,
      compactionSavedTokens: Math.max(s.compactionEventSavedTokens, s.summaryCompactionSavedTokens),
      hostGuardBlocks: s.hostGuardBlocks,
    }))
    .sort((a, b) => b.rounds - a.rounds || a.sessionId.localeCompare(b.sessionId));

  const totalSummaries = sessionsDetail.reduce((sum, s) => sum + s.summaries, 0);
  const totalTokenSamples = sessionStats.reduce((sum, s) => sum + s.tokensPerSuccessfulTaskCount, 0);
  const totalTokensPerSuccessfulTask = sessionStats.reduce((sum, s) => sum + s.tokensPerSuccessfulTaskTotal, 0);

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: path.resolve(options.source),
    days: options.days,
    eventsRead: entries.length,
    sessions: sessionsDetail.length,
    rounds: sessionsDetail.reduce((sum, s) => sum + s.rounds, 0),
    toolCalls: sessionsDetail.reduce((sum, s) => sum + s.toolCalls, 0),
    failedToolCalls: sessionsDetail.reduce((sum, s) => sum + s.failedToolCalls, 0),
    verificationRate: totalSummaries > 0
      ? sessionsDetail.reduce((sum, s) => sum + s.verificationRate * s.summaries, 0) / totalSummaries
      : 0,
    noToolFinalRate: totalSummaries > 0
      ? sessionsDetail.reduce((sum, s) => sum + s.noToolFinalRate * s.summaries, 0) / totalSummaries
      : 0,
    tokensPerSuccessfulTask: totalTokenSamples > 0
      ? totalTokensPerSuccessfulTask / totalTokenSamples
      : 0,
    compactionSavedTokens: sessionsDetail.reduce((sum, s) => sum + s.compactionSavedTokens, 0),
    hostGuardBlocks: sessionsDetail.reduce((sum, s) => sum + s.hostGuardBlocks, 0),
    permissionDecisions,
    sessionsDetail,
  };
}

export async function summarizeRuntimeTelemetry(
  filePath: string,
  options: { days?: number; generatedAt?: string } = {},
): Promise<RuntimeTelemetrySummary> {
  const days = options.days ?? 30;
  const entries = await readRuntimeTelemetryJsonl(filePath, days);
  return aggregateRuntimeTelemetry(entries, { source: filePath, days, generatedAt: options.generatedAt });
}

export function formatRuntimeTelemetryMarkdown(summary: RuntimeTelemetrySummary): string {
  const lines = [
    '# Runtime Telemetry Report',
    '',
    `- generated_at: ${summary.generatedAt}`,
    `- source: ${summary.source}`,
    `- days: ${summary.days}`,
    `- events_read: ${summary.eventsRead}`,
    `- sessions: ${summary.sessions}`,
    `- rounds: ${summary.rounds}`,
    `- tool_calls: ${summary.toolCalls}`,
    `- failed_tool_calls: ${summary.failedToolCalls}`,
    `- verification_rate: ${roundMetric(summary.verificationRate)}`,
    `- no_tool_final_rate: ${roundMetric(summary.noToolFinalRate)}`,
    `- tokens_per_successful_task: ${roundMetric(summary.tokensPerSuccessfulTask)}`,
    `- compaction_saved_tokens: ${Math.round(summary.compactionSavedTokens)}`,
    `- host_guard_blocks: ${summary.hostGuardBlocks}`,
    '',
    '## Permission Decisions',
    '',
  ];

  const permissions = Object.entries(summary.permissionDecisions).sort((a, b) => b[1] - a[1]);
  if (permissions.length === 0) {
    lines.push('- none');
  } else {
    for (const [permission, count] of permissions) {
      lines.push(`- ${permission}: ${count}`);
    }
  }

  lines.push('', '## Sessions', '');
  if (summary.sessionsDetail.length === 0) {
    lines.push('- none');
  } else {
    for (const session of summary.sessionsDetail.slice(0, 20)) {
      lines.push(
        `- ${session.sessionId}: rounds=${session.rounds}, tools=${session.toolCalls}, ` +
        `verification=${roundMetric(session.verificationRate)}, no_tool_final=${roundMetric(session.noToolFinalRate)}, ` +
        `saved_tokens=${Math.round(session.compactionSavedTokens)}`,
      );
    }
  }

  return lines.join('\n');
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
