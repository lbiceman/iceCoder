import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StopReason } from './types.js';
import type { TaskStateSnapshot, RepoContextSnapshot } from '../types/runtime-snapshot.js';
import type { ExecutionModeTelemetryPayload } from '../types/supervisor.js';
import type { ToolOutcome } from './types.js';
import type { HarnessPolicyStats } from './harness-policy-stats.js';
import type { CompletionReason, CompletionStatus } from './completion-state.js';

export type HarnessFailureSource = 'llm_summarize' | 'tool_output_spill' | 'checkpoint_save';

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
      outcome?: ToolOutcome;
      policyReason?: string;
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
      type: 'host_guard_block';
      timestamp: string;
      sessionId: string;
      round: number;
      toolName: string;
      matchLabel?: string;
      source: 'preflight' | 'shell';
    }
  | {
      type: 'failure';
      timestamp: string;
      sessionId: string;
      source: HarnessFailureSource;
      message: string;
    }
  | {
      type: 'summary';
      timestamp: string;
      sessionId: string;
      stopReason?: StopReason;
      completionStatus?: CompletionStatus;
      completionReason?: CompletionReason;
      task: TaskStateSnapshot;
      repo: RepoContextSnapshot;
      rounds: number;
      toolCalls: number;
      verificationRate: number;
      noToolFinal: boolean;
      tokensPerSuccessfulTask?: number;
      compactionSavedTokens: number;
      harnessPolicy?: HarnessPolicyStats;
    };

/** 每个会话一个文件，避免所有会话追加进同一份 telemetry.jsonl。 */
export function runtimeTelemetryFile(sessionDir: string, sessionId = 'default'): string {
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'session';
  return path.join(path.resolve(sessionDir), `${safeSession}.telemetry.jsonl`);
}

export class RuntimeTelemetry {
  private readonly filePath: string;
  private compactionSavedTokens = 0;

  constructor(sessionDir = 'data/sessions', private readonly sessionId = 'default') {
    this.filePath = runtimeTelemetryFile(sessionDir, sessionId);
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

  recordHostGuardBlock(
    event: Omit<Extract<RuntimeTelemetryEvent, { type: 'host_guard_block' }>, 'type' | 'timestamp' | 'sessionId'>,
  ): void {
    this.append({ type: 'host_guard_block', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
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

  recordFailure(event: { source: HarnessFailureSource; message: string }): Promise<void> {
    return this.append({
      type: 'failure',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      source: event.source,
      message: event.message,
    });
  }

  private append(event: RuntimeTelemetryEvent): Promise<void> {
    return fs.mkdir(path.dirname(this.filePath), { recursive: true })
      .then(() => fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8'))
      .then(() => undefined)
      .catch(err => {
        console.debug('[runtime-telemetry] write failed:', err instanceof Error ? err.message : err);
      });
  }
}

/** 把原先吞掉的失败打到 warn，并追加一条 failure telemetry。写入失败不再向外抛。 */
export async function warnHarnessFailure(input: {
  source: HarnessFailureSource;
  message: string;
  sessionId?: string;
  sessionDir?: string;
  telemetry?: RuntimeTelemetry;
}): Promise<void> {
  const message = input.message || 'unknown failure';
  console.warn(`[harness] ${input.source} failed:`, message);
  try {
    const telemetry = input.telemetry
      ?? new RuntimeTelemetry(input.sessionDir, input.sessionId ?? 'default');
    await telemetry.recordFailure({ source: input.source, message });
  } catch (err) {
    console.warn(
      '[harness] failure telemetry failed:',
      err instanceof Error ? err.message : err,
    );
  }
}
