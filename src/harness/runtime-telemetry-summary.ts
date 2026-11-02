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
  failures: number;
  toolResultBudget: ToolResultBudgetStats;
}

/** 工具结果裁剪的收益与代价：省下的 token 对比因此多出的补读 */
export interface ToolResultBudgetStats {
  /** 未原样注入的结果条数 */
  shapedResults: number;
  /** 写入时裁剪省下的 token（原始 - 注入） */
  shapedSavedTokens: number;
  /** 被拒的超限范围读取 */
  rangeErrors: number;
  /** 压力清理的结果条数与 token */
  clearedResults: number;
  clearedTokens: number;
  /** 补读省略 / 清理 / 落盘内容的次数与首次注入 token */
  rereads: number;
  rereadTokens: number;
  /**
   * 按模型调用累计：每次调用时历史里仍生效的节省（裁剪 + 清理）之和。
   * 被裁剪的结果每轮都随历史重发，这才是实际少发的 token。
   */
  cumulativeSavedTokens: number;
  /** 按模型调用累计：补读结果每轮随历史重发的占用 */
  cumulativeRereadTokens: number;
  /** 计入累计的模型调用次数 */
  measuredCalls: number;
  /** 发送前总量检查收紧的结果与 token；收紧后仍超出的次数与 token */
  budgetShrunkResults: number;
  budgetShrunkTokens: number;
  budgetOverflows: number;
  budgetOverflowTokens: number;
}

/** 由累计量派生的收益指标 */
export interface ToolResultBudgetDerived {
  /** 累计节省 − 累计补读占用 */
  netSavedTokens: number;
  /** 每节省 1000 token 对应的补读次数；无节省时为 null */
  rereadsPer1kSaved: number | null;
}

function emptyToolResultBudgetStats(): ToolResultBudgetStats {
  return {
    shapedResults: 0,
    shapedSavedTokens: 0,
    rangeErrors: 0,
    clearedResults: 0,
    clearedTokens: 0,
    rereads: 0,
    rereadTokens: 0,
    cumulativeSavedTokens: 0,
    cumulativeRereadTokens: 0,
    measuredCalls: 0,
    budgetShrunkResults: 0,
    budgetShrunkTokens: 0,
    budgetOverflows: 0,
    budgetOverflowTokens: 0,
  };
}

function addToolResultBudgetStats(into: ToolResultBudgetStats, from: ToolResultBudgetStats): void {
  for (const key of Object.keys(into) as Array<keyof ToolResultBudgetStats>) {
    into[key] += from[key];
  }
}

export function deriveToolResultBudget(stats: ToolResultBudgetStats): ToolResultBudgetDerived {
  return {
    netSavedTokens: stats.cumulativeSavedTokens - stats.cumulativeRereadTokens,
    rereadsPer1kSaved: stats.cumulativeSavedTokens > 0
      ? stats.rereads / (stats.cumulativeSavedTokens / 1000)
      : null,
  };
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
  failures: number;
  permissionDecisions: Record<string, number>;
  toolResultBudget: ToolResultBudgetStats;
  sessionsDetail: RuntimeTelemetrySessionSummary[];
}

interface MutableSessionStats {
  toolResultBudget: ToolResultBudgetStats;
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
  failures: number;
}

function emptySessionStats(sessionId: string): MutableSessionStats {
  return {
    sessionId,
    toolResultBudget: emptyToolResultBudgetStats(),
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
    failures: 0,
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
        session.rounds += 1 + (typeof event.suppressedDuplicates === 'number' ? event.suppressedDuplicates : 0);
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
      case 'tool_result_budget':
        if (event.strategy === 'range_error') {
          session.toolResultBudget.rangeErrors++;
          break;
        }
        session.toolResultBudget.shapedResults++;
        session.toolResultBudget.shapedSavedTokens += Math.max(
          0,
          (event.originalTokens || 0) - (event.injectedTokens || 0),
        );
        break;
      case 'tool_result_clear':
        session.toolResultBudget.clearedResults += event.cleared || 0;
        session.toolResultBudget.clearedTokens += event.clearedTokens || 0;
        break;
      case 'tool_result_reread':
        session.toolResultBudget.rereads++;
        session.toolResultBudget.rereadTokens += event.injectedTokens || 0;
        break;
      case 'tool_result_savings':
        session.toolResultBudget.measuredCalls++;
        session.toolResultBudget.cumulativeSavedTokens +=
          (event.shapedSavedTokens || 0) + (event.clearedSavedTokens || 0);
        session.toolResultBudget.cumulativeRereadTokens += event.rereadTokens || 0;
        break;
      case 'context_budget':
        session.toolResultBudget.budgetShrunkResults += event.shrunkResults || 0;
        session.toolResultBudget.budgetShrunkTokens += event.shrunkTokens || 0;
        if ((event.overflowTokens || 0) > 0) {
          session.toolResultBudget.budgetOverflows++;
          session.toolResultBudget.budgetOverflowTokens += event.overflowTokens;
        }
        break;
      case 'host_guard_block':
        session.hostGuardBlocks++;
        break;
      case 'failure':
        session.failures++;
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
      failures: s.failures,
      toolResultBudget: { ...s.toolResultBudget },
    }))
    .sort((a, b) => b.rounds - a.rounds || a.sessionId.localeCompare(b.sessionId));

  const totalSummaries = sessionsDetail.reduce((sum, s) => sum + s.summaries, 0);
  const totalTokenSamples = sessionStats.reduce((sum, s) => sum + s.tokensPerSuccessfulTaskCount, 0);
  const totalTokensPerSuccessfulTask = sessionStats.reduce((sum, s) => sum + s.tokensPerSuccessfulTaskTotal, 0);
  const toolResultBudget = emptyToolResultBudgetStats();
  for (const s of sessionStats) addToolResultBudgetStats(toolResultBudget, s.toolResultBudget);

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
    failures: sessionsDetail.reduce((sum, s) => sum + s.failures, 0),
    permissionDecisions,
    toolResultBudget,
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
  const derived = deriveToolResultBudget(summary.toolResultBudget);
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
    `- failures: ${summary.failures}`,
    '',
    '## Tool Result Budget',
    '',
    `- shaped_results: ${summary.toolResultBudget.shapedResults}`,
    `- shaped_saved_tokens: ${Math.round(summary.toolResultBudget.shapedSavedTokens)}`,
    `- range_errors: ${summary.toolResultBudget.rangeErrors}`,
    `- cleared_results: ${summary.toolResultBudget.clearedResults}`,
    `- cleared_tokens: ${Math.round(summary.toolResultBudget.clearedTokens)}`,
    `- rereads: ${summary.toolResultBudget.rereads}`,
    `- reread_tokens: ${Math.round(summary.toolResultBudget.rereadTokens)}`,
    `- measured_llm_calls: ${summary.toolResultBudget.measuredCalls}`,
    `- cumulative_saved_tokens: ${Math.round(summary.toolResultBudget.cumulativeSavedTokens)}`,
    `- cumulative_reread_tokens: ${Math.round(summary.toolResultBudget.cumulativeRereadTokens)}`,
    `- net_saved_tokens: ${Math.round(derived.netSavedTokens)}`,
    `- rereads_per_1k_saved: ${derived.rereadsPer1kSaved === null ? 'n/a' : roundMetric(derived.rereadsPer1kSaved)}`,
    `- budget_shrunk_results: ${summary.toolResultBudget.budgetShrunkResults}`,
    `- budget_shrunk_tokens: ${Math.round(summary.toolResultBudget.budgetShrunkTokens)}`,
    `- budget_overflows: ${summary.toolResultBudget.budgetOverflows}`,
    `- budget_overflow_tokens: ${Math.round(summary.toolResultBudget.budgetOverflowTokens)}`,
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
