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

export function createSupervisorEventsRouter(): Router {
  const router = Router();
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const parsedDays = Number.parseInt(req.query.days as string, 10);
    const days = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 90) : 7;
    const runtimePath = path.join(getRuntimeDataDir(), DEFAULT_RUNTIME_TELEMETRY_LOG);
    const events = extractExecutionModeEvents(await readJsonlFile(runtimePath, days));
    res.json({
      success: true,
      days,
      executionMode: {
        enter: events.filter(event => event.type === 'execution_mode_enter').length,
        exit: events.filter(event => event.type === 'execution_mode_exit').length,
        recent: events.slice(-20),
      },
    });
  });
  return router;
}
