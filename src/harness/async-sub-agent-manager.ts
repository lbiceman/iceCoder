import { EventEmitter } from 'node:events';

import type { ToolDefinition } from '../llm/types.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import {
  ASYNC_SUB_AGENT_SCHEMA_VERSION,
  type AnalysisArtifact,
  type AnalysisTimelinePayload,
  type AsyncSubAgentStatus,
  type AsyncSubAgentTask,
  type RequestAnalysisInput,
  type RequestAnalysisResult,
} from '../types/async-sub-agent.js';
import type { ChatFunction } from './types.js';
import { SubAgentRunner, type SubAgentResult } from './sub-agent-runner.js';
import {
  writeAnalysisArtifact,
  writeAsyncSubAgentTask,
} from './analysis-workspace-store.js';
import { buildSubAgentTaskPrompt } from './sub-agent-prompts.js';
import { parseSubAgentOutput } from './sub-agent-output-parser.js';

export type AsyncSubAgentManagerEvent =
  | 'analysis_started'
  | 'analysis_finished';

export interface AsyncSubAgentManagerEventPayload extends AnalysisTimelinePayload {
  task: AsyncSubAgentTask;
  artifact?: AnalysisArtifact;
}

export interface AsyncSubAgentManagerOptions {
  /** Session data directory, not the repository workspace root. */
  sessionDir: string;
  /** Shared read-only tool executor used by SubAgentRunner. */
  toolExecutor: ToolExecutor;
  /** Main harness tool definitions, filtered by SubAgentRunner. */
  toolDefinitions: ToolDefinition[];
  /** Main harness chat function. */
  chatFn: ChatFunction;
  /** Repository workspace root used by read-only tools and cache keys. */
  workspaceRoot?: string;
  /** Test/config override; env fallback is ICE_ASYNC_SUBAGENT_MAX_CONCURRENT. */
  maxConcurrent?: number;
}

export interface AsyncSubAgentTaskStatus {
  taskId: string;
  sessionId: string;
  kind: AsyncSubAgentTask['kind'];
  status: AsyncSubAgentStatus;
  artifactPath?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

const DEFAULT_MAX_CONCURRENT = 5;

function readMaxConcurrentFromEnv(): number {
  const raw = process.env.ICE_ASYNC_SUBAGENT_MAX_CONCURRENT;
  if (!raw?.trim()) return DEFAULT_MAX_CONCURRENT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_CONCURRENT;
}

function generateTaskId(): string {
  return `asa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeKey(input: RequestAnalysisInput): string {
  return [
    input.sessionId,
    input.kind,
    input.scope?.scopeHash
      ?? JSON.stringify({
        prompt: input.prompt,
        context: input.context ?? '',
        paths: [...(input.scope?.paths ?? [])].sort(),
        keywords: [...(input.scope?.keywords ?? [])].sort(),
      }),
  ].join('\n');
}

function taskDedupeKey(task: AsyncSubAgentTask): string {
  return [
    task.sessionId,
    task.kind,
    task.scope?.scopeHash
      ?? JSON.stringify({
        prompt: task.prompt,
        context: task.context ?? '',
        paths: [...(task.scope?.paths ?? [])].sort(),
        keywords: [...(task.scope?.keywords ?? [])].sort(),
      }),
  ].join('\n');
}

function mapResultStatus(result: SubAgentResult): AsyncSubAgentStatus {
  if (result.status === 'timeout') return 'timeout';
  if (result.status === 'error') return 'failed';
  return 'completed';
}

function buildSubAgentContext(input: RequestAnalysisInput): string | undefined {
  const parts = [
    `Sub-agent kind: ${input.kind}`,
    input.context,
    input.scope?.paths?.length ? `Scoped paths: ${input.scope.paths.join(', ')}` : undefined,
    input.scope?.keywords?.length ? `Scoped keywords: ${input.scope.keywords.join(', ')}` : undefined,
  ].filter((part): part is string => !!part?.trim());
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

export class AsyncSubAgentManager {
  private readonly sessionDir: string;
  private readonly toolExecutor: ToolExecutor;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly chatFn: ChatFunction;
  private readonly workspaceRoot?: string;
  private readonly maxConcurrent: number;
  private readonly events = new EventEmitter();
  private readonly tasks = new Map<string, AsyncSubAgentTask>();
  private readonly queue: string[] = [];
  private runningCount = 0;

  constructor(options: AsyncSubAgentManagerOptions) {
    this.sessionDir = options.sessionDir;
    this.toolExecutor = options.toolExecutor;
    this.toolDefinitions = options.toolDefinitions;
    this.chatFn = options.chatFn;
    this.workspaceRoot = options.workspaceRoot;
    this.maxConcurrent = options.maxConcurrent ?? readMaxConcurrentFromEnv();
  }

  on(event: AsyncSubAgentManagerEvent, listener: (payload: AsyncSubAgentManagerEventPayload) => void): this {
    this.events.on(event, listener);
    return this;
  }

  off(event: AsyncSubAgentManagerEvent, listener: (payload: AsyncSubAgentManagerEventPayload) => void): this {
    this.events.off(event, listener);
    return this;
  }

  submit(input: RequestAnalysisInput): RequestAnalysisResult {
    const key = dedupeKey(input);
    for (const existing of this.tasks.values()) {
      if (
        (existing.status === 'pending' || existing.status === 'running')
        && taskDedupeKey(existing) === key
      ) {
        return {
          taskId: existing.taskId,
          submitted: false,
          status: existing.status,
          message: 'Equivalent analysis is already running.',
        };
      }
    }

    const now = input.requestedAt ?? Date.now();
    const taskId = generateTaskId();
    const task: AsyncSubAgentTask = {
      version: ASYNC_SUB_AGENT_SCHEMA_VERSION,
      taskId,
      sessionId: input.sessionId,
      kind: input.kind,
      prompt: input.prompt,
      status: 'pending',
      filesRead: [],
      createdAt: now,
      ...(input.context ? { context: input.context } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    };

    this.tasks.set(taskId, task);
    this.queue.push(taskId);
    void this.persistTask(task);
    this.drainQueue();

    return {
      taskId,
      submitted: true,
      status: task.status,
      message: 'Analysis submitted and will complete in the background.',
    };
  }

  submitBatch(inputs: RequestAnalysisInput[]): RequestAnalysisResult[] {
    return inputs.map(input => this.submit(input));
  }

  getTaskStatus(taskId: string): AsyncSubAgentTaskStatus | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return this.toStatus(task);
  }

  listRunningTasks(sessionId?: string): AsyncSubAgentTaskStatus[] {
    return [...this.tasks.values()]
      .filter(task => task.status === 'running')
      .filter(task => !sessionId || task.sessionId === sessionId)
      .map(task => this.toStatus(task));
  }

  listCompletedSince(sinceTs: number, sessionId?: string): AsyncSubAgentTaskStatus[] {
    return [...this.tasks.values()]
      .filter(task => task.finishedAt != null && task.finishedAt >= sinceTs)
      .filter(task => task.status === 'completed' || task.status === 'failed' || task.status === 'timeout')
      .filter(task => !sessionId || task.sessionId === sessionId)
      .map(task => this.toStatus(task));
  }

  cancel(taskId: string, reason = 'cancelled'): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return false;
    task.status = 'cancelled';
    task.error = reason;
    task.finishedAt = Date.now();
    const idx = this.queue.indexOf(taskId);
    if (idx >= 0) this.queue.splice(idx, 1);
    void this.persistTask(task);
    return true;
  }

  private drainQueue(): void {
    while (this.runningCount < this.maxConcurrent) {
      const taskId = this.queue.shift();
      if (!taskId) return;
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'pending') continue;
      this.runningCount++;
      void this.runTask(task).finally(() => {
        this.runningCount = Math.max(0, this.runningCount - 1);
        this.drainQueue();
      });
    }
  }

  private async runTask(task: AsyncSubAgentTask): Promise<void> {
    const started: AsyncSubAgentTask = {
      ...task,
      status: 'running',
      startedAt: Date.now(),
    };
    this.tasks.set(task.taskId, started);
    await this.persistTask(started);
    this.emit('analysis_started', started);

    try {
      const runner = new SubAgentRunner({
        toolExecutor: this.toolExecutor,
        toolDefinitions: this.toolDefinitions,
        chatFn: this.chatFn,
        ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      });
      const result = await runner.run({
        task: buildSubAgentTaskPrompt({
          kind: task.kind,
          task: task.prompt,
          context: task.context,
          paths: task.scope?.paths,
          keywords: task.scope?.keywords,
        }),
        context: buildSubAgentContext({
          sessionId: task.sessionId,
          kind: task.kind,
          prompt: task.prompt,
          context: task.context,
          scope: task.scope,
        }),
      });

      await this.finishTask(started, result);
    } catch (err) {
      await this.finishTask(started, {
        summary: '',
        filesRead: [],
        toolCallCount: 0,
        roundsUsed: 0,
        tokensUsed: 0,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async finishTask(task: AsyncSubAgentTask, result: SubAgentResult): Promise<void> {
    const finishedAt = Date.now();
    const status = mapResultStatus(result);
    let artifact: AnalysisArtifact | undefined;

    const next: AsyncSubAgentTask = {
      ...task,
      status,
      filesRead: result.filesRead,
      toolCallCount: result.toolCallCount,
      roundsUsed: result.roundsUsed,
      tokensUsed: result.tokensUsed,
      finishedAt,
      ...(result.error ? { error: result.error } : {}),
    };

    artifact = await writeAnalysisArtifact(this.sessionDir, task.sessionId, {
      sessionId: task.sessionId,
      taskId: task.taskId,
      kind: task.kind,
      summary: result.summary,
      filesRead: result.filesRead,
      output: parseSubAgentOutput(task.kind, result.summary),
      status,
      createdAt: finishedAt,
    });

    next.artifactPath = artifact.relativePath;
    this.tasks.set(task.taskId, next);
    await this.persistTask(next);
    this.emit('analysis_finished', next, artifact);
  }

  private async persistTask(task: AsyncSubAgentTask): Promise<void> {
    await writeAsyncSubAgentTask(this.sessionDir, task.sessionId, task).catch(err => {
      console.debug('[async-sub-agent-manager] persist failed:', err instanceof Error ? err.message : err);
    });
  }

  private emit(
    event: AsyncSubAgentManagerEvent,
    task: AsyncSubAgentTask,
    artifact?: AnalysisArtifact,
  ): void {
    const payload: AsyncSubAgentManagerEventPayload = {
      sessionId: task.sessionId,
      taskId: task.taskId,
      kind: task.kind,
      status: task.status,
      task,
      ...(task.artifactPath ? { artifactPath: task.artifactPath } : {}),
      ...(task.filesRead.length ? { filesRead: task.filesRead } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(artifact ? { artifact } : {}),
    };
    this.events.emit(event, payload);
  }

  private toStatus(task: AsyncSubAgentTask): AsyncSubAgentTaskStatus {
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      kind: task.kind,
      status: task.status,
      createdAt: task.createdAt,
      ...(task.artifactPath ? { artifactPath: task.artifactPath } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    };
  }
}
