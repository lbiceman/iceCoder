/**
 * Supervisor 事件遥测 API。
 *
 * GET /api/supervisor/events — 汇总 supervisor-events.jsonl + runtime telemetry 中的 execution mode。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRuntimeDataDir } from '../../cli/paths.js';
import { resolveTimelinePath } from '../../harness/supervisor/event-timeline.js';
import type { RuntimeEvent, SupervisorTimelineEventType } from '../../types/supervisor.js';
import type { ExecutionModeTelemetryPayload } from '../../types/supervisor.js';

const DEFAULT_SUPERVISOR_LOG = 'data/runtime/supervisor-events.jsonl';
const DEFAULT_RUNTIME_TELEMETRY_LOG = 'data/runtime/telemetry.jsonl';

/** 与 EventTimeline / RuntimeTelemetry 落盘根一致（ICE_DATA_DIR/runtime/...）。 */
export function defaultSupervisorLogPaths(): { supervisorLog: string; runtimeLog: string } {
  return {
    supervisorLog: resolveTimelinePath(DEFAULT_SUPERVISOR_LOG, getRuntimeDataDir()),
    runtimeLog: resolveTimelinePath(DEFAULT_RUNTIME_TELEMETRY_LOG, getRuntimeDataDir()),
  };
}

export interface SupervisorEventsQuery {
  days?: number;
  event?: string;
  limit?: number;
}

interface JsonlLine {
  ts?: number;
  timestamp?: string;
  type?: string;
  event?: string;
  round?: number;
  mode?: string;
  reason?: string;
  payload?: Record<string, unknown>;
  executionMode?: string;
  enteredBy?: string[];
  enteredByPrimary?: string;
  primaryReasonHuman?: string;
  degradedTier?: string;
  forcedTaskBearingRoundsSinceEntry?: number;
  forcedMinDwellRounds?: number;
}

export async function readJsonlFile(
  logPath: string,
  days: number,
): Promise<JsonlLine[]> {
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const cutoff = Date.now() - days * 86_400_000;
    const entries: JsonlLine[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JsonlLine;
        const ts = entry.ts ?? (entry.timestamp ? Date.parse(entry.timestamp) : NaN);
        if (!Number.isFinite(ts) || ts >= cutoff) {
          entries.push(entry);
        }
      } catch {
        // skip corrupt line
      }
    }

    return entries;
  } catch {
    return [];
  }
}

export function filterSupervisorTimelineEvents(
  entries: JsonlLine[],
  eventFilter?: string,
): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  for (const e of entries) {
    if (e.event == null || e.round == null || e.mode == null || e.reason == null) continue;
    if (eventFilter && e.event !== eventFilter) continue;
    out.push({
      ts: e.ts ?? Date.now(),
      round: e.round,
      mode: e.mode,
      event: e.event as SupervisorTimelineEventType,
      reason: e.reason,
      ...(e.payload ? { payload: e.payload } : {}),
    });
  }
  return out;
}

export function extractExecutionModeEvents(entries: JsonlLine[]): Array<{
  type: 'execution_mode_enter' | 'execution_mode_exit';
  timestamp: string;
  payload: ExecutionModeTelemetryPayload;
}> {
  const out: Array<{
    type: 'execution_mode_enter' | 'execution_mode_exit';
    timestamp: string;
    payload: ExecutionModeTelemetryPayload;
  }> = [];

  for (const e of entries) {
    if (e.type !== 'execution_mode_enter' && e.type !== 'execution_mode_exit') continue;
    const payload: ExecutionModeTelemetryPayload = {
      executionMode: (e.executionMode as ExecutionModeTelemetryPayload['executionMode']) ?? 'free',
      enteredBy: (e.enteredBy as ExecutionModeTelemetryPayload['enteredBy']) ?? [],
      enteredByPrimary: e.enteredByPrimary as ExecutionModeTelemetryPayload['enteredByPrimary'],
      primaryReasonHuman: e.primaryReasonHuman ?? 'free',
      round: e.round ?? 0,
      degradedTier: e.degradedTier as ExecutionModeTelemetryPayload['degradedTier'],
      forcedTaskBearingRoundsSinceEntry: typeof e.forcedTaskBearingRoundsSinceEntry === 'number'
        ? e.forcedTaskBearingRoundsSinceEntry
        : undefined,
      forcedMinDwellRounds: typeof e.forcedMinDwellRounds === 'number'
        ? e.forcedMinDwellRounds
        : undefined,
    };
    out.push({
      type: e.type,
      timestamp: e.timestamp ?? new Date(e.ts ?? Date.now()).toISOString(),
      payload,
    });
  }

  return out;
}

export function aggregateTimelineEvents(events: RuntimeEvent[]) {
  const byEvent: Record<string, number> = {};
  const byMode: Record<string, number> = {};
  for (const e of events) {
    byEvent[e.event] = (byEvent[e.event] ?? 0) + 1;
    byMode[e.mode] = (byMode[e.mode] ?? 0) + 1;
  }
  return { total: events.length, byEvent, byMode };
}

export function formatSupervisorEventsReport(args: {
  days: number;
  supervisorPath: string;
  runtimePath: string;
  timelineEvents: RuntimeEvent[];
  executionModeEvents: ReturnType<typeof extractExecutionModeEvents>;
  recentLimit: number;
}): string {
  const { days, supervisorPath, timelineEvents, executionModeEvents, recentLimit } = args;
  const agg = aggregateTimelineEvents(timelineEvents);
  const enters = executionModeEvents.filter(e => e.type === 'execution_mode_enter');
  const exits = executionModeEvents.filter(e => e.type === 'execution_mode_exit');

  const lines: string[] = [];
  lines.push(`📊 **Supervisor 事件报告**（最近 ${days} 天）`);
  lines.push('');
  lines.push(`**Execution Mode** 进入 ${enters.length} 次 · 退出 ${exits.length} 次`);

  if (enters.length > 0) {
    lines.push('');
    lines.push('**最近进入 forced**');
    for (const e of enters.slice(-Math.min(5, enters.length))) {
      const p = e.payload;
      const tier = p.degradedTier ? ` · 降级=${p.degradedTier}` : '';
      lines.push(
        `- 第 ${p.round} 轮 · ${p.primaryReasonHuman}${tier}`,
      );
      if (p.enteredBy?.length) {
        lines.push(`  信号：${p.enteredBy.join(' + ')}`);
      }
    }
  } else {
    lines.push('- （runtime telemetry 中暂无 execution_mode 记录）');
  }

  lines.push('');
  if (agg.total > 0) {
    const eventParts = Object.entries(agg.byEvent)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}:${n}`)
      .join(' · ');
    lines.push(`**L2 Timeline** 共 ${agg.total} 条（\`${supervisorPath}\`）`);
    lines.push(eventParts);
  } else {
    lines.push(`**L2 Timeline** 暂无数据（\`${supervisorPath}\` 不存在或为空）`);
  }

  if (timelineEvents.length > 0) {
    lines.push('');
    lines.push(`**最近 ${Math.min(recentLimit, timelineEvents.length)} 条 Timeline**`);
    const recent = [...timelineEvents]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, recentLimit);
    for (const e of recent) {
      const when = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
      lines.push(`- [R${e.round}] ${when} · ${e.event} · ${e.reason} (${e.mode})`);
    }
  }

  lines.push('');
  lines.push('过滤示例：`~supervisor event=recover` · 天数：`~supervisor days=3`');

  return lines.join('\n');
}

export async function buildSupervisorEventsReport(
  query: SupervisorEventsQuery = {},
  paths: { supervisorLog?: string; runtimeLog?: string } = {},
): Promise<{ report: string; timelineEvents: RuntimeEvent[]; executionModeEvents: ReturnType<typeof extractExecutionModeEvents> }> {
  const days = Math.min(Math.max(query.days ?? 7, 1), 90);
  const recentLimit = Math.min(Math.max(query.limit ?? 10, 1), 50);
  const eventFilter = query.event?.trim() || undefined;

  const defaults = defaultSupervisorLogPaths();
  const supervisorPath = paths.supervisorLog ?? defaults.supervisorLog;
  const runtimePath = paths.runtimeLog ?? defaults.runtimeLog;

  const supervisorRaw = await readJsonlFile(supervisorPath, days);
  const runtimeRaw = await readJsonlFile(runtimePath, days);

  const timelineEvents = filterSupervisorTimelineEvents(supervisorRaw, eventFilter);
  const executionModeEvents = extractExecutionModeEvents(runtimeRaw);

  const report = formatSupervisorEventsReport({
    days,
    supervisorPath,
    runtimePath,
    timelineEvents,
    executionModeEvents,
    recentLimit,
  });

  return { report, timelineEvents, executionModeEvents };
}

export function createSupervisorEventsRouter(): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const days = parseInt(req.query.days as string, 10);
      const limit = parseInt(req.query.limit as string, 10);
      const event = req.query.event as string | undefined;
      const format = (req.query.format as string) || 'text';

      const result = await buildSupervisorEventsReport({
        days: Number.isFinite(days) ? days : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        event,
      });

      if (format === 'json') {
        res.json({
          success: true,
          days: Number.isFinite(days) ? days : 7,
          event: event ?? null,
          timeline: aggregateTimelineEvents(result.timelineEvents),
          executionMode: {
            enter: result.executionModeEvents.filter(e => e.type === 'execution_mode_enter').length,
            exit: result.executionModeEvents.filter(e => e.type === 'execution_mode_exit').length,
            recent: result.executionModeEvents.slice(-10),
          },
          recentTimeline: result.timelineEvents.slice(-20),
        });
        return;
      }

      res.json({ success: true, report: result.report });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: `Supervisor 事件报告生成失败: ${message}` });
    }
  });

  return router;
}
