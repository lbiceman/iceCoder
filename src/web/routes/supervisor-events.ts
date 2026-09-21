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
