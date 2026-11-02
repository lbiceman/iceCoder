import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StopReason } from './types.js';
import type { TaskStateSnapshot, RepoContextSnapshot } from '../types/runtime-snapshot.js';
import type { ToolOutcome } from './types.js';
import type { HarnessPolicyStats } from './harness-policy-stats.js';
import type { CompletionReason, CompletionStatus } from './completion-state.js';
import type { ToolResultStrategy } from '../llm/types.js';

export type HarnessFailureSource = 'llm_summarize' | 'tool_output_spill' | 'checkpoint_save';

/** round 事件里的任务摘要：列表只留最近几项，交付版本表只记条数。 */
export interface RoundTaskTelemetry {
  goal: string;
  intent: TaskStateSnapshot['intent'];
  phase: TaskStateSnapshot['phase'];
  filesRead: string[];
  filesReadCount: number;
  filesChanged: string[];
  filesChangedCount: number;
  commandsRun: string[];
  commandsRunCount: number;
  workspaceMutationVersion: number;
  deliverableWrites: number;
  deliverableConfirms: number;
}

export interface RoundRepoTelemetry {
  filesReadCount: number;
  filesChanged: string[];
  filesChangedCount: number;
  commandsRun: string[];
  testCommands: string[];
  recentDiagnostics: string[];
}

export type RuntimeTelemetryEvent =
  | {
      type: 'round';
      timestamp: string;
      sessionId: string;
      round: number;
      task: RoundTaskTelemetry;
      repo: RoundRepoTelemetry;
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
  | {
      /** 工具结果未原样注入（分页 / 裁剪 / 范围超限）时记录一条 */
      type: 'tool_result_budget';
      timestamp: string;
      sessionId: string;
      round: number;
      toolName: string;
      toolCallId: string;
      strategy: ToolResultStrategy;
      originalChars: number;
      originalTokens: number;
      injectedChars: number;
      injectedTokens: number;
      capTokens?: number;
      capChars?: number;
      capSource: 'tier' | 'remaining' | 'chars';
      path?: string;
      omittedLines?: Array<[number, number]>;
      omittedChars?: [number, number];
      spilled: boolean;
      spillFailed?: boolean;
    }
  | {
      /** read_file 读到了先前被分页省略或被压力清理掉的行 */
      type: 'tool_result_reread';
      timestamp: string;
      sessionId: string;
      round: number;
      toolCallId: string;
      rereadOf: string;
      reason: 'paged' | 'cleared' | 'spill';
      path: string;
      lines?: [number, number];
      injectedTokens: number;
    }
  | {
      /** 上下文压力下把旧工具结果换成占位 */
      type: 'tool_result_clear';
      timestamp: string;
      sessionId: string;
      cleared: number;
      clearedTokens: number;
      toolCallIds: string[];
    }
  | {
      /** 每次调用模型前：当前历史里仍生效的节省与补读占用（逐次累加 = 会话实际节省） */
      type: 'tool_result_savings';
      timestamp: string;
      sessionId: string;
      round: number;
      shapedSavedTokens: number;
      clearedSavedTokens: number;
      rereadTokens: number;
      shapedResults: number;
      clearedResults: number;
      rereadResults: number;
    }
  | {
      /** 发送前总量检查：超出硬上限时收紧本轮未发送的结果；仍超出记 overflow */
      type: 'context_budget';
      timestamp: string;
      sessionId: string;
      round: number;
      totalTokens: number;
      limitTokens: number;
      shrunkResults: number;
      shrunkTokens: number;
      overflowTokens: number;
      /** 本地估算到 provider 计数的校准系数（≥1） */
      calibration?: number;
    }
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

export interface RuntimeTelemetryLimits {
  /** 单条事件序列化后的上限；超出只留类型、时间与原始字节数 */
  maxLineBytes: number;
  /** 单个会话文件上限；超出改名为 .old（只留一份）后重开 */
  maxFileBytes: number;
  /** 同类型同内容事件在这个窗口内只落一条 */
  dedupeWindowMs: number;
  /** 所在磁盘剩余空间低于此值时停止写入 */
  minFreeDiskBytes: number;
  now: () => number;
}

export const DEFAULT_RUNTIME_TELEMETRY_LIMITS: RuntimeTelemetryLimits = {
  maxLineBytes: 8 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  dedupeWindowMs: 1_000,
  minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
  now: () => Date.now(),
};

/** 子 Agent 一次委派一份文件、数量多，单文件上限压低。 */
export const SUB_AGENT_TELEMETRY_LIMITS: Partial<RuntimeTelemetryLimits> = {
  maxFileBytes: 2 * 1024 * 1024,
};

/** 只有这些类型会在空转时高频重复；tool 等逐次计数的事件不去重。 */
const DEDUPE_EVENT_TYPES = new Set<RuntimeTelemetryEvent['type']>([
  'round',
  'compaction',
  'tool_result_savings',
  'context_budget',
  'tool_result_clear',
]);

const ROUND_LIST_LIMIT = 20;
const ROUND_ITEM_MAX_CHARS = 200;
const ROUND_GOAL_MAX_CHARS = 300;
const DISK_CHECK_INTERVAL_MS = 60_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function tail(items: readonly string[], limit = ROUND_LIST_LIMIT): string[] {
  return items.slice(-limit).map(item => clip(item, ROUND_ITEM_MAX_CHARS));
}

export function summarizeRoundTask(task: TaskStateSnapshot): RoundTaskTelemetry {
  return {
    goal: clip(task.goal, ROUND_GOAL_MAX_CHARS),
    intent: task.intent,
    phase: task.phase,
    filesRead: tail(task.filesRead),
    filesReadCount: task.filesRead.length,
    filesChanged: tail(task.filesChanged),
    filesChangedCount: task.filesChanged.length,
    commandsRun: tail(task.commandsRun, 10),
    commandsRunCount: task.commandsRun.length,
    workspaceMutationVersion: task.workspaceMutationVersion,
    deliverableWrites: Object.keys(task.fileDeliverableWriteVersions ?? {}).length,
    deliverableConfirms: Object.keys(task.fileDeliverableConfirmVersions ?? {}).length,
  };
}

export function summarizeRoundRepo(repo: RepoContextSnapshot): RoundRepoTelemetry {
  return {
    filesReadCount: repo.filesRead.length,
    filesChanged: tail(repo.filesChanged),
    filesChangedCount: repo.filesChanged.length,
    commandsRun: tail(repo.commandsRun, 10),
    testCommands: tail(repo.testCommands, 5),
    recentDiagnostics: tail(repo.recentDiagnostics, 5),
  };
}

interface TelemetryFileState {
  size: number | null;
  chain: Promise<void>;
  lastWritten: Map<string, { key: string; at: number }>;
  suppressed: Map<string, number>;
  diskCheckedAt: number;
  diskOk: boolean;
  diskWarned: boolean;
}

/** 同一会话可能同时有多个实例在写，按文件共享写队列与计数。 */
const fileStates = new Map<string, TelemetryFileState>();

function fileStateFor(filePath: string): TelemetryFileState {
  const key = filePath.toLowerCase();
  let state = fileStates.get(key);
  if (!state) {
    state = {
      size: null,
      chain: Promise.resolve(),
      lastWritten: new Map(),
      suppressed: new Map(),
      diskCheckedAt: 0,
      diskOk: true,
      diskWarned: false,
    };
    fileStates.set(key, state);
  }
  return state;
}

export interface RecordRoundInput {
  round: number;
  task: TaskStateSnapshot;
  repo: RepoContextSnapshot;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  memoryInjectedTokenEstimate?: number;
}

export class RuntimeTelemetry {
  private readonly filePath: string;
  private readonly limits: RuntimeTelemetryLimits;
  private compactionSavedTokens = 0;

  constructor(
    sessionDir = 'data/sessions',
    private readonly sessionId = 'default',
    limits: Partial<RuntimeTelemetryLimits> = {},
  ) {
    this.filePath = runtimeTelemetryFile(sessionDir, sessionId);
    this.limits = { ...DEFAULT_RUNTIME_TELEMETRY_LIMITS, ...limits };
  }

  recordRound(event: RecordRoundInput): Promise<void> {
    return this.append({
      type: 'round',
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      ...event,
      task: summarizeRoundTask(event.task),
      repo: summarizeRoundRepo(event.repo),
    });
  }

  recordTool(event: Omit<Extract<RuntimeTelemetryEvent, { type: 'tool' }>, 'type' | 'timestamp' | 'sessionId'>): Promise<void> {
    return this.append({ type: 'tool', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordToolResultBudget(
    event: Omit<Extract<RuntimeTelemetryEvent, { type: 'tool_result_budget' }>, 'type' | 'timestamp' | 'sessionId'>,
  ): Promise<void> {
    return this.append({ type: 'tool_result_budget', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordToolResultReread(
    event: Omit<Extract<RuntimeTelemetryEvent, { type: 'tool_result_reread' }>, 'type' | 'timestamp' | 'sessionId'>,
  ): Promise<void> {
    return this.append({ type: 'tool_result_reread', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordToolResultClear(
    event: Omit<Extract<RuntimeTelemetryEvent, { type: 'tool_result_clear' }>, 'type' | 'timestamp' | 'sessionId'>,
  ): Promise<void> {
    return this.append({ type: 'tool_result_clear', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordToolResultSavings(
    event: Omit<Extract<RuntimeTelemetryEvent, { type: 'tool_result_savings' }>, 'type' | 'timestamp' | 'sessionId'>,
  ): Promise<void> {
    return this.append({ type: 'tool_result_savings', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordContextBudget(
    event: Omit<Extract<RuntimeTelemetryEvent, { type: 'context_budget' }>, 'type' | 'timestamp' | 'sessionId'>,
  ): Promise<void> {
    return this.append({ type: 'context_budget', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordCompaction(event: Omit<Extract<RuntimeTelemetryEvent, { type: 'compaction' }>, 'type' | 'timestamp' | 'sessionId' | 'savedTokens'>): Promise<void> {
    const savedTokens = Math.max(0, event.beforeTokens - event.afterTokens);
    this.compactionSavedTokens += savedTokens;
    return this.append({ type: 'compaction', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event, savedTokens });
  }

  recordHostGuardBlock(
    event: Omit<Extract<RuntimeTelemetryEvent, { type: 'host_guard_block' }>, 'type' | 'timestamp' | 'sessionId'>,
  ): Promise<void> {
    return this.append({ type: 'host_guard_block', timestamp: new Date().toISOString(), sessionId: this.sessionId, ...event });
  }

  recordSummary(event: Omit<Extract<RuntimeTelemetryEvent, { type: 'summary' }>, 'type' | 'timestamp' | 'sessionId' | 'compactionSavedTokens'>): Promise<void> {
    return this.append({
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
    const state = fileStateFor(this.filePath);
    const record: Record<string, unknown> = { ...event };
    if (DEDUPE_EVENT_TYPES.has(event.type)) {
      const now = this.limits.now();
      const { timestamp: _ts, ...payload } = event;
      const key = JSON.stringify(payload);
      const last = state.lastWritten.get(event.type);
      if (last && last.key === key && now - last.at < this.limits.dedupeWindowMs) {
        state.suppressed.set(event.type, (state.suppressed.get(event.type) ?? 0) + 1);
        return state.chain;
      }
      const suppressed = state.suppressed.get(event.type) ?? 0;
      if (suppressed > 0) {
        record.suppressedDuplicates = suppressed;
        state.suppressed.delete(event.type);
      }
      state.lastWritten.set(event.type, { key, at: now });
    }

    let line = JSON.stringify(record);
    const originalBytes = Buffer.byteLength(line);
    if (originalBytes > this.limits.maxLineBytes) {
      line = JSON.stringify({
        type: event.type,
        timestamp: event.timestamp,
        sessionId: event.sessionId,
        ...('round' in event ? { round: event.round } : {}),
        truncated: true,
        originalBytes,
      });
    }
    const data = `${line}\n`;

    state.chain = state.chain
      .then(() => this.writeLine(state, data))
      .catch(err => {
        console.debug('[runtime-telemetry] write failed:', err instanceof Error ? err.message : err);
      });
    return state.chain;
  }

  private async writeLine(state: TelemetryFileState, data: string): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    if (!(await this.hasDiskRoom(state, dir))) return;

    if (state.size === null) {
      state.size = await fs.stat(this.filePath).then(s => s.size, () => 0);
    }
    const bytes = Buffer.byteLength(data);
    if (state.size > 0 && state.size + bytes > this.limits.maxFileBytes) {
      await fs.rename(this.filePath, `${this.filePath}.old`).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      state.size = 0;
    }
    await fs.appendFile(this.filePath, data, 'utf-8');
    state.size += bytes;
  }

  private async hasDiskRoom(state: TelemetryFileState, dir: string): Promise<boolean> {
    const now = Date.now();
    if (state.diskCheckedAt === 0 || now - state.diskCheckedAt >= DISK_CHECK_INTERVAL_MS) {
      state.diskCheckedAt = now;
      try {
        const stats = await fs.statfs(dir);
        state.diskOk = stats.bavail * stats.bsize >= this.limits.minFreeDiskBytes;
      } catch {
        state.diskOk = true;
      }
      if (state.diskOk) state.diskWarned = false;
    }
    if (!state.diskOk && !state.diskWarned) {
      state.diskWarned = true;
      console.warn(`[runtime-telemetry] 磁盘剩余空间不足，暂停写入 ${this.filePath}`);
    }
    return state.diskOk;
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
