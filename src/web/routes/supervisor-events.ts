/**
 * Execution-mode telemetry API.
 *
 * L2 timeline was removed with the single-axis supervisor architecture.
 */
import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRuntimeDataDir } from '../../cli/paths.js';
import type { ExecutionModeTelemetryPayload } from '../../types/supervisor.js';
import { makeTimeBuckets, timeBucketKey } from '../telemetry-series.js';

const DEFAULT_RUNTIME_TELEMETRY_LOG = 'runtime/telemetry.jsonl';

interface JsonlLine {
  ts?: number;
  timestamp?: string;
  type?: string;
  round?: number;
  executionMode?: string;
  enteredBy?: string[];
  enteredByPrimary?: string;
  primaryReasonHuman?: string;
  degradedTier?: string;
}

export async function readJsonlFile(logPath: string, days: number): Promise<JsonlLine[]> {
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const cutoff = Date.now() - days * 86_400_000;
    return content.split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const entry = JSON.parse(line) as JsonlLine;
        const ts = entry.ts ?? (entry.timestamp ? Date.parse(entry.timestamp) : NaN);
        return !Number.isFinite(ts) || ts >= cutoff ? [entry] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function extractExecutionModeEvents(entries: JsonlLine[]) {
  return entries.flatMap((entry) => {
    if (entry.type !== 'execution_mode_enter' && entry.type !== 'execution_mode_exit') return [];
    const payload: ExecutionModeTelemetryPayload = {
      executionMode: (entry.executionMode as ExecutionModeTelemetryPayload['executionMode']) ?? 'free',
      enteredBy: (entry.enteredBy as ExecutionModeTelemetryPayload['enteredBy']) ?? [],
      enteredByPrimary: entry.enteredByPrimary as ExecutionModeTelemetryPayload['enteredByPrimary'],
      primaryReasonHuman: entry.primaryReasonHuman ?? 'free',
      round: entry.round ?? 0,
      degradedTier: entry.degradedTier as ExecutionModeTelemetryPayload['degradedTier'],
    };
    return [{
      type: entry.type,
      timestamp: entry.timestamp ?? new Date(entry.ts ?? Date.now()).toISOString(),
      payload,
    }];
  });
}

export function aggregateExecutionModeStats(
  events: ReturnType<typeof extractExecutionModeEvents>,
) {
  const byMode: Record<string, number> = {};
  const bySignal: Record<string, number> = {};
  let enter = 0;
  let exit = 0;
  for (const event of events) {
    if (event.type === 'execution_mode_enter') {
      enter += 1;
      const mode = event.payload.executionMode || 'forced';
      byMode[mode] = (byMode[mode] || 0) + 1;
      const signal = event.payload.enteredByPrimary
        || event.payload.enteredBy[0]
        || 'unknown';
      bySignal[signal] = (bySignal[signal] || 0) + 1;
      continue;
    }
    if (event.type === 'execution_mode_exit') exit += 1;
  }
  return {
    enter,
    exit,
    byMode,
    bySignal,
    recent: events.slice(-20),
  };
}

export interface ExecutionModeSeriesBucket {
  key: string;
  timestamp: number;
  enter: number;
  exit: number;
}

const SIGNAL_LABELS: Record<string, string> = {
  task_graph_active: '任务图进行中',
  pending_steps: '未完成步骤',
  multi_write: '多文件写入',
  branch_switched: '分支切换',
  checkpoint_resumed: '检查点恢复',
  tool_failure: '工具失败',
  recovery_pending: '等待恢复',
  large_diff: '大范围改动',
  explicit_impl: '明确实现',
  engine_fail_safe: '引擎兜底',
  unknown: '其他',
};

const DEGRADED_LABELS: Record<string, string> = {
  graph: '图构建降级',
  step_queue: '步骤队列降级',
  write_intent: '写入意图降级',
};

function signalLabel(key: string): string {
  return SIGNAL_LABELS[key] || key || '其他';
}

export function filterExecutionModeEvents(
  events: ReturnType<typeof extractExecutionModeEvents>,
  eventFilter?: string,
): ReturnType<typeof extractExecutionModeEvents> {
  const filter = String(eventFilter || '').trim().toLowerCase();
  if (!filter) return events;
  return events.filter((event) => {
    if (filter === 'enter' || filter === 'execution_mode_enter') {
      return event.type === 'execution_mode_enter';
    }
    if (filter === 'exit' || filter === 'execution_mode_exit') {
      return event.type === 'execution_mode_exit';
    }
    if (event.type.toLowerCase() === filter) return true;
    const payload = event.payload;
    if (payload.executionMode?.toLowerCase() === filter) return true;
    if (payload.enteredByPrimary?.toLowerCase() === filter) return true;
    return payload.enteredBy.some((signal) => signal.toLowerCase() === filter);
  });
}

export function formatExecutionModeReport(
  stats: ReturnType<typeof aggregateExecutionModeStats>,
  days: number,
  eventFilter?: string,
): string {
  const lines: string[] = [];
  const filterNote = eventFilter ? `，event=${eventFilter}` : '';
  lines.push(`📊 **执行模式报告**（最近 ${days} 天${filterNote}）`);
  lines.push('');

  if (stats.enter === 0 && stats.exit === 0) {
    lines.push('暂无监管触发记录。');
    return lines.join('\n');
  }

  lines.push(`**进入** ${stats.enter} 次 | 退出 ${stats.exit} 次`);

  const modeParts = Object.entries(stats.byMode)
    .sort((a, b) => b[1] - a[1])
    .map(([mode, count]) => `${mode}:${count}`);
  if (modeParts.length) {
    lines.push(`**按模式** ${modeParts.join(' ')}`);
  }

  const signalParts = Object.entries(stats.bySignal)
    .sort((a, b) => b[1] - a[1])
    .map(([signal, count]) => `${signalLabel(signal)}:${count}`);
  if (signalParts.length) {
    lines.push(`**触发源** ${signalParts.join(' ')}`);
  }

  const recent = stats.recent.slice(-8);
  if (recent.length) {
    lines.push('');
    lines.push('**最近**');
    for (const event of recent) {
      const verb = event.type === 'execution_mode_enter' ? '进入' : '退出';
      const mode = event.payload.executionMode
        || (event.type === 'execution_mode_enter' ? 'forced' : 'free');
      const primary = event.payload.enteredByPrimary || event.payload.enteredBy[0];
      const reason = event.type === 'execution_mode_enter' && primary
        ? ` · ${signalLabel(primary)}`
        : '';
      const round = event.payload.round ? ` · 第 ${event.payload.round} 轮` : '';
      const degraded = event.payload.degradedTier
        ? `（${DEGRADED_LABELS[event.payload.degradedTier] || event.payload.degradedTier}）`
        : '';
      lines.push(`- ${verb} ${mode}${reason}${round}${degraded}`);
    }
  }

  return lines.join('\n');
}

export function aggregateExecutionModeSeries(
  events: ReturnType<typeof extractExecutionModeEvents>,
  days: number,
  now = Date.now(),
): ExecutionModeSeriesBucket[] {
  const hourly = days <= 1;
  const buckets = makeTimeBuckets(days, now).map((slot) => ({
    key: slot.key,
    timestamp: slot.timestamp,
    enter: 0,
    exit: 0,
  }));
  const map = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const windowStart = now - days * 86_400_000;
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  for (const event of events) {
    const ts = Date.parse(event.timestamp);
    if (!Number.isFinite(ts) || ts < windowStart) continue;
    const bucket = map.get(timeBucketKey(ts, hourly))
      || (first && ts < first.timestamp ? first : null)
      || (last && ts > last.timestamp ? last : null);
    if (!bucket) continue;
    if (event.type === 'execution_mode_enter') bucket.enter += 1;
    else if (event.type === 'execution_mode_exit') bucket.exit += 1;
  }
  return buckets;
}

export function createSupervisorEventsRouter(): Router {
  const router = Router();
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const parsedDays = Number.parseInt(req.query.days as string, 10);
    const days = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 90) : 7;
    const runtimePath = path.join(getRuntimeDataDir(), DEFAULT_RUNTIME_TELEMETRY_LOG);
    const events = extractExecutionModeEvents(await readJsonlFile(runtimePath, days));

    // ~supervisor 命令要文本报告；统计页不带 format，继续走下面的 JSON。
    if (String(req.query.format || '') === 'text') {
      const eventFilter = typeof req.query.event === 'string' ? req.query.event : '';
      const filtered = filterExecutionModeEvents(events, eventFilter);
      const stats = aggregateExecutionModeStats(filtered);
      res.json({
        success: true,
        report: formatExecutionModeReport(stats, days, eventFilter || undefined),
      });
      return;
    }

    const stats = aggregateExecutionModeStats(events);
    res.json({
      success: true,
      days,
      executionMode: {
        ...stats,
        series: aggregateExecutionModeSeries(events, days),
      },
    });
  });
  return router;
}
