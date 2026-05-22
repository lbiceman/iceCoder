import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  EventTimeline as EventTimelineContract,
  EventTimelineConfig,
  RuntimeEvent,
  SupervisorTimelineEventType,
} from '../../types/supervisor.js';

export interface EventTimelineOptions {
  /** Relative paths resolve against ICE_DATA_DIR (same root as supervisor-config.json). */
  dataDir?: string;
  /** Test hook: skip disk writes while still recording in memory. */
  memoryOnly?: boolean;
}

interface TimelineSink {
  append(line: string): Promise<void>;
  flush?(): Promise<void>;
}

export class EventTimeline implements EventTimelineContract {
  private readonly config: EventTimelineConfig;
  private readonly sink: TimelineSink;
  private readonly recentEvents: RuntimeEvent[] = [];

  constructor(config: EventTimelineConfig, options: EventTimelineOptions = {}) {
    this.config = config;
    this.sink = options.memoryOnly
      ? new MemoryTimelineSink()
      : new FileTimelineSink(resolveTimelinePath(config.persistPath, options.dataDir));
  }

  record(event: Omit<RuntimeEvent, 'ts'> & { ts?: number }): void {
    if (!this.config.enabled) return;

    const normalized: RuntimeEvent = {
      ts: event.ts ?? Date.now(),
      round: event.round,
      mode: event.mode,
      event: event.event,
      reason: event.reason,
      ...(event.payload ? { payload: event.payload } : {}),
    };

    this.recentEvents.push(normalized);
    this.trimRecentEvents();
    const line = `${JSON.stringify(normalized)}\n`;
    this.sink.append(line).catch(err => {
      console.debug('[event-timeline] write failed:', err instanceof Error ? err.message : err);
    });
  }

  recordTyped(
    event: SupervisorTimelineEventType,
    params: {
      round: number;
      mode: string;
      reason: string;
      payload?: Record<string, unknown>;
      ts?: number;
    },
  ): void {
    this.record({
      event,
      round: params.round,
      mode: params.mode,
      reason: params.reason,
      payload: params.payload,
      ts: params.ts,
    });
  }

  getRecentEvents(limit?: number): readonly RuntimeEvent[] {
    if (limit == null || limit >= this.recentEvents.length) {
      return [...this.recentEvents];
    }
    return this.recentEvents.slice(-limit);
  }

  /**
   * L2-6 / T08 — checkpoint resume 时把磁盘上的 timeline 尾部 N 条事件推回内存 recent。
   * 不写 sink（避免重复落 JSONL）；仅恢复 in-memory 视图，便于 UI 续显与回放对账。
   */
  restoreRecentEvents(events: readonly RuntimeEvent[] | undefined): void {
    this.recentEvents.length = 0;
    if (!events || events.length === 0) return;
    for (const ev of events) {
      this.recentEvents.push({
        ts: ev.ts,
        round: ev.round,
        mode: ev.mode,
        event: ev.event,
        reason: ev.reason,
        ...(ev.payload ? { payload: { ...ev.payload } } : {}),
      });
    }
    this.trimRecentEvents();
  }

  async flush(): Promise<void> {
    await this.sink.flush?.();
  }

  private trimRecentEvents(): void {
    const max = this.config.maxEventsInCheckpoint;
    if (max == null || max <= 0 || this.recentEvents.length <= max) {
      return;
    }
    this.recentEvents.splice(0, this.recentEvents.length - max);
  }
}

export function resolveTimelinePath(persistPath: string, dataDir?: string): string {
  if (path.isAbsolute(persistPath)) {
    return persistPath;
  }

  const base = dataDir ?? process.env.ICE_DATA_DIR ?? path.join(process.cwd(), 'data');

  // Default `data/runtime/...` → `{ICE_DATA_DIR}/runtime/...`, aligned with supervisor-config.json root.
  if (persistPath.startsWith('data/') || persistPath.startsWith('data\\')) {
    const relative = persistPath.replace(/^data[/\\]/, '');
    return path.resolve(base, relative);
  }

  return path.resolve(base, persistPath);
}

class MemoryTimelineSink implements TimelineSink {
  readonly lines: string[] = [];

  async append(line: string): Promise<void> {
    this.lines.push(line);
  }

  async flush(): Promise<void> {}
}

class FileTimelineSink implements TimelineSink {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  append(line: string): Promise<void> {
    this.pending = this.pending.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, 'utf-8');
    });
    return this.pending;
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
