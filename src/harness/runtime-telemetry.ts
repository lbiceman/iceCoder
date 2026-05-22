import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StopReason } from './types.js';
import type { TaskStateSnapshot, RepoContextSnapshot } from '../types/runtime-snapshot.js';
import type { ExecutionModeTelemetryPayload } from '../types/supervisor.js';

export type RuntimeTelemetryEvent =
  | {
      type: 'round';
      timestamp: string;
      sessionId: string;
      round: number;
      task: TaskStateSnapshot;
      repo: RepoContextSnapshot;
      tokenUsage?: { inputTokens: number; outputTokens: number };
      memoryInjectedTokenEstimate?: number;
    }
  | {
      type: 'tool';
      timestamp: string;
      sessionId: string;
      round: number;
      toolName: string;
      success: boolean;
      permission?: string;
      outputLength?: number;
    }
  | ({
      type: 'execution_mode_enter';
      timestamp: string;
      sessionId: string;
    } & ExecutionModeTelemetryPayload)
  | ({
      type: 'execution_mode_exit';
      timestamp: string;
      sessionId: string;
    } & ExecutionModeTelemetryPayload)
  | {
      type: 'compaction';
      timestamp: string;
      sessionId: string;
      beforeMessages: number;
      afterMessages: number;
      beforeTokens: number;
      afterTokens: number;
      savedTokens: number;
    }
  | {
      type: 'summary';
      timestamp: string;
      sessionId: string;
      stopReason?: StopReason;
      task: TaskStateSnapshot;
      repo: RepoContextSnapshot;
      rounds: number;
      toolCalls: number;
      verificationRate: number;
      noToolFinal: boolean;
      tokensPerSuccessfulTask?: number;
      compactionSavedTokens: number;
    };

export class RuntimeTelemetry {
  private readonly filePath: string;
  private compactionSavedTokens = 0;

  constructor(sessionDir = 'data/sessions', private readonly sessionId = 'default') {
    const baseDir = process.env.ICE_RUNTIME_DIR
      ? path.resolve(process.env.ICE_RUNTIME_DIR)
      : path.resolve(sessionDir, '..', 'runtime');
    this.filePath = path.join(baseDir, 'telemetry.jsonl');
  }

  recordRound(event: Omit<Extract<RuntimeTelemetryEvent, { type: 'round' }>, 'type' | 'timestamp' | 'sessionId'>): void {
    this.append({ type: 'round', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordTool(event: Omit<Extract<RuntimeTelemetryEvent, { type: 'tool' }>, 'type' | 'timestamp' | 'sessionId'>): void {
    this.append({ type: 'tool', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordExecutionMode(
    type: 'execution_mode_enter' | 'execution_mode_exit',
    event: ExecutionModeTelemetryPayload,
  ): void {
    this.append({ type, timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordCompaction(event: Omit<Extract<RuntimeTelemetryEvent, { type: 'compaction' }>, 'type' | 'timestamp' | 'sessionId' | 'savedTokens'>): void {
    const savedTokens = Math.max(0, event.beforeTokens - event.afterTokens);
    this.compactionSavedTokens += savedTokens;
    this.append({ type: 'compaction', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event, savedTokens });
  }

  recordSummary(event: Omit<Extract<RuntimeTelemetryEvent, { type: 'summary' }>, 'type' | 'timestamp' | 'sessionId' | 'compactionSavedTokens'>): void {
    this.append({
      type: 'summary',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      ...event,
      compactionSavedTokens: this.compactionSavedTokens,
    });
  }

  private append(event: RuntimeTelemetryEvent): void {
    fs.mkdir(path.dirname(this.filePath), { recursive: true })
      .then(() => fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8'))
      .catch(err => console.debug('[runtime-telemetry] write failed:', err instanceof Error ? err.message : err));
  }
}
