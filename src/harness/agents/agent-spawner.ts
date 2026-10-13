/**
 * AgentSpawner：主 Agent 调用 `task` 时创建并运行子 Harness。
 *
 * - 每个子 Agent 是一个完整 Harness 实例（长循环、压缩、恢复、权限、验证计划与停手判断）。
 * - 并发上限与每轮总数上限；超出总数时 task 直接报错。
 * - 写租约：并行子 Agent 不能写同一个文件；run_command 的改动只能事后发现：
 *   改到别人租约文件的那次命令按失败返回，冲突写进结果。
 * - 结果汇总只采信系统记录（写工具、命令、清单差异），不采信子 Agent 自述。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ToolCall, UnifiedMessage } from '../../llm/types.js';
import { ToolExecutor } from '../../tools/tool-executor.js';
import type { ToolResult } from '../../tools/types.js';
import { normalizeWorkRelPath } from '../../tools/read-before-edit.js';
import { collectSessionTouchedPaths } from '../intent-checkpoint-store.js';
import { evaluateIncompleteTaskStopHook } from '../incomplete-task-stop-hook.js';
import { classifyRunCommandResult, type RunCommandResultClassification } from '../run-command-result.js';
import type { StopHookManager } from '../stop-hooks.js';
import type {
  AgentToolScope,
  ChatFunction,
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from '../types.js';
import type { ShellMandatoryConfirmRequest } from '../harness-permission-runtime.js';
import { findBlockedSubAgentGitSubcommand, formatSubAgentGitBlockMessage } from './agent-git-policy.js';
import type { AgentEvidenceRecord, AgentTaskOutcome } from './agent-merge.js';
import { buildSubAgentSystemPrompt } from './agent-prompts.js';
import {
  AGENT_REPORT_PREVIEW_CHARS,
  countLineChanges,
  formatAgentResult,
  mapStopReasonToAgentStatus,
  type AgentCommandConflict,
  type AgentCommandRecord,
  type AgentFileChange,
  type AgentLeaseReject,
  type AgentStatus,
  type AgentTerminalStatus,
  type AgentView,
} from './agent-result.js';
import {
  agentMessagesPath,
  agentsDirFor,
  childSessionIdFor,
  saveAgentMessages,
  saveAgentMeta,
  type AgentMetaRecord,
} from './agent-store.js';
import { AgentRecordingToolExecutor, type AgentToolRecorder } from './agent-tool-executors.js';
import { agentConfig, resolveAgentLimits } from './agent-config.js';
import {
  BUILTIN_AGENT_TYPES,
  filterToolsForAgentType,
  type AgentTypeDefinition,
} from './agent-types.js';
import {
  AgentBackgroundHub,
  sessionAgentBackgroundHub,
  type DrainedBackgroundResult,
} from './agent-background-hub.js';
import { parseCheckAgentInput, parseTaskToolInput } from './task-tool.js';
import {
  WriteLeaseRegistry,
  formatCommandLeaseViolationMessage,
  formatLeaseRejectMessage,
  type WriteLeaseHolder,
} from './write-lease.js';

export interface AgentSource {
  agentId: string;
  description: string;
  type: string;
}

export interface AgentLlm {
  chat: ChatFunction;
  stream?: StreamFunction;
}

export interface HarnessLike {
  run(
    userMessage: string,
    chatFn: ChatFunction,
    onStep?: (event: HarnessStepEvent) => void,
    existingMessages?: UnifiedMessage[],
    streamFn?: StreamFunction,
  ): Promise<HarnessResult>;
  getStopHookManager(): StopHookManager;
}

export type AgentHarnessFactory = (config: HarnessConfig, executor: ToolExecutor) => HarnessLike;

export interface AgentSpawnerOptions {
  parentSessionId: string;
  /** 会话根目录；子 Agent 记录在 `{sessionsDir}/{parentSessionId}/agents/` */
  sessionsDir: string;
  /** 本轮用户消息 id（Agent 记录归属，回滚 / 删除据此清理） */
  messageId: string;
  createLlm(ctx: { agentId: string; agentType: string; signal: AbortSignal }): AgentLlm;
  harnessFactory: AgentHarnessFactory;
  /** signal 在子 Agent 停止时触发，实现方应撤掉挂着的确认 */
  onConfirm?(
    source: AgentSource,
    toolName: string,
    args: Record<string, any>,
    signal: AbortSignal,
  ): Promise<boolean>;
  onShellMandatoryConfirm?(
    source: AgentSource,
    request: ShellMandatoryConfirmRequest,
    signal: AbortSignal,
  ): Promise<boolean>;
  maxConcurrent?: number;
  maxPerRun?: number;
  /** 缺省为本 spawner 独有的租约表（会话级，不跨会话共享）。 */
  leaseRegistry?: WriteLeaseRegistry;
  /** 卡片进度推送节流（毫秒） */
  updateThrottleMs?: number;
  /** 是否写 agents 目录（测试可关） */
  persist?: boolean;
  now?: () => number;
  /** 后台子 Agent 跨轮登记处；缺省用进程级默认实例。 */
  backgroundHub?: AgentBackgroundHub;
}

export interface AgentParentContext {
  config: HarnessConfig;
  /** 主会话的原始 ToolExecutor（子 Agent 共用同一套工具实现） */
  toolExecutor: ToolExecutor;
  workspaceRoot: string;
  lockedWorkspaceRoot?: string;
  referenceReads?: string[];
  /** 主 Harness 的截止时间（startTime + timeout） */
  deadline?: number;
  signal?: AbortSignal;
  onStep?: (event: HarnessStepEvent) => void;
}

const FORWARDED_EVENT_TYPES = new Set<HarnessStepEvent['type']>([
  'thinking',
  'tool_call',
  'tool_result',
  'tool_denied',
  'tool_confirm',
  'tool_progress',
  'tool_output',
  'compaction',
  'final',
  'stream_delta',
  'reasoning_stream_delta',
  'stream_retry_discard',
]);

const FILE_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'patch_file', 'batch_edit_file']);
const HARD_TIMEOUT_GRACE_MS = 30_000;
const DEFAULT_UPDATE_THROTTLE_MS = 500;

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(grant);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      };
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve(true);
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    next?.();
  }
}

interface CommandTracking {
  toolCallId: string;
  command: string;
  startedAt: number;
  classification?: RunCommandResultClassification;
  /** 命令结束（含其自身改动）时的全局写序号 */
  writeSeq: number;
  /** 命令开始前其它 Agent 租约文件的内容（null = 不存在） */
  foreignLeases: Array<{ absPath: string; content: string | null }>;
}

interface AgentRun {
  agentId: string;
  type: AgentTypeDefinition;
  prompt: string;
  parentToolCallId: string;
  view: AgentView;
  controller: AbortController;
  abortReason?: 'timeout' | 'cancelled';
  /** 首次写入前的原始内容（null = 原本不存在） */
  originals: Map<string, string | null>;
  /** 本 Agent 写过的相对路径 → 是否由命令发现 */
  touched: Map<string, { viaCommand: boolean }>;
  fileStats: Map<string, { additions: number; deletions: number; created: boolean; deleted: boolean }>;
  commands: Map<string, CommandTracking>;
  leaseRejects: AgentLeaseReject[];
  conflicts: AgentCommandConflict[];
  streamTail: string;
  lastUpdateAt: number;
  updateTimer?: ReturnType<typeof setTimeout>;
  workspaceRoot: string;
  /** run_in_background：不阻塞 task，结果经后台注册表异步交付 */
  background: boolean;
}

interface PendingOutcome {
  agentId: string;
  filesChanged: AgentFileChange[];
  evidence: Array<AgentEvidenceRecord & { writeSeq: number }>;
}

function createAgentId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function shortArg(value: unknown, max = 80): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function describeToolActivity(name: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const detail = shortArg(a.path ?? a.file_path)
    || shortArg(a.command ?? a.cmd)
    || shortArg(a.pattern ?? a.query ?? a.url)
    || shortArg(a.subcommand);
  return detail ? `${name} ${detail}` : name;
}

function lastNonEmptyLine(text: string, max = 160): string {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf-8');
  } catch {
    return null;
  }
}

function isTerminalClassification(c: RunCommandResultClassification | undefined): boolean {
  return c?.kind === 'foreground' || c?.kind === 'background_completed' || c?.kind === 'background_failed';
}

function commandRecordFrom(tracking: CommandTracking): AgentCommandRecord | null {
  const c = tracking.classification;
  if (!c) return null;
  if (c.kind === 'background_start' || c.kind === 'background_running') {
    return { toolCallId: tracking.toolCallId, command: c.command, exitCode: null, success: true, pending: true };
  }
  if (c.kind === 'foreground') {
    return {
      toolCallId: tracking.toolCallId,
      command: c.command,
      exitCode: c.exitCode ?? (c.foregroundSuccess ? 0 : null),
      success: c.foregroundSuccess,
    };
  }
  return {
    toolCallId: tracking.toolCallId,
    command: c.command,
    exitCode: c.exitCode ?? (c.kind === 'background_completed' ? 0 : null),
    success: c.kind === 'background_completed',
  };
}

/** 同一命令先后台启动、后 check 到终态时，只保留终态那条。 */
function collectCommandRecords(run: AgentRun): AgentCommandRecord[] {
  const records = [...run.commands.values()]
    .map(commandRecordFrom)
    .filter((r): r is AgentCommandRecord => !!r);
  const terminalCommands = new Set(records.filter(r => !r.pending).map(r => r.command));
  return records.filter(r => !r.pending || !terminalCommands.has(r.command));
}

export class AgentSpawner {
  readonly agentTypes: readonly AgentTypeDefinition[] = BUILTIN_AGENT_TYPES;
  private readonly semaphore: Semaphore;
  private readonly maxPerRun: number;
  private readonly leases: WriteLeaseRegistry;
  private readonly runs = new Map<string, AgentRun>();
  private readonly agentTerminalWaiters = new Map<string, Array<() => void>>();
  private readonly outcomes = new Map<string, PendingOutcome>();
  private readonly finishedViews = new Map<string, AgentView>();
  private readonly backgroundHub: AgentBackgroundHub;
  private readonly parentAbort = new AbortController();
  private spawnedThisRun = 0;
  private writeSeq = 0;

  constructor(private readonly options: AgentSpawnerOptions) {
    this.semaphore = new Semaphore(Math.max(1, options.maxConcurrent ?? agentConfig.maxConcurrent));
    this.maxPerRun = Math.max(1, options.maxPerRun ?? agentConfig.maxPerRun);
    this.leases = options.leaseRegistry ?? new WriteLeaseRegistry();
    this.backgroundHub = options.backgroundHub ?? sessionAgentBackgroundHub;
  }

  get parentSessionId(): string {
    return this.options.parentSessionId;
  }

  get messageId(): string {
    return this.options.messageId;
  }

  /** 每次主 Harness run 开始时调用：重置本轮派发计数。 */
  beginParentRun(): void {
    this.spawnedThisRun = 0;
  }

  isLive(agentId: string): boolean {
    return this.runs.has(agentId);
  }

  /** 运行中与本轮已结束的 Agent 视图（running-turn 快照用）。 */
  listViews(): AgentView[] {
    const views = [...this.finishedViews.values(), ...[...this.runs.values()].map(r => ({ ...r.view }))];
    return views.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }

  stop(agentId: string): boolean {
    const run = this.runs.get(agentId);
    if (!run) return false;
    this.abortRun(run, 'cancelled');
    return true;
  }

  /**
   * 中止本轮前台子 Agent。后台子 Agent（run_in_background）跨轮存活，不在这里中止。
   */
  stopAll(): void {
    for (const run of this.runs.values()) {
      if (!run.background) this.abortRun(run, 'cancelled');
    }
  }

  /** 是否仍有在跑的后台子 Agent（决定 spawner 是否要跨轮保留）。 */
  hasLiveBackgrounds(): boolean {
    for (const run of this.runs.values()) {
      if (run.background) return true;
    }
    return false;
  }

  /** 是否还有后台相关工作（在跑或结果未注入）——据此决定是否保留 spawner。 */
  hasBackgroundWork(): boolean {
    return this.hasLiveBackgrounds() || this.hasPendingBackgroundResults();
  }

  /** 会话被删除 / 服务关停：中止全部子 Agent 并丢弃登记。 */
  dispose(): void {
    for (const run of this.runs.values()) this.abortRun(run, 'cancelled');
    this.parentAbort.abort();
    this.backgroundHub.clearSession(this.options.parentSessionId);
  }

  /** 已结束、尚未注入主 Agent 的后台子 Agent 报告（取走即清空）。 */
  drainBackgroundResults(): DrainedBackgroundResult[] {
    return this.backgroundHub.drainOutputs(this.options.parentSessionId);
  }

  /** 是否有已完成、尚未注入的后台子 Agent 报告（用于空闲时唤醒主 Agent）。 */
  hasPendingBackgroundResults(): boolean {
    return this.backgroundHub.hasPendingOutputs(this.options.parentSessionId);
  }

  /** 后台子 Agent 视图（用于「后台 Agent：N 运行中」状态条）。 */
  listBackgroundViews(): AgentView[] {
    return this.listViews().filter(v => v.background === true);
  }

  /**
   * `check_agent`：查询（并可有界等待）一个后台子 Agent。
   * 缺 agentId 时列出本会话所有子 Agent。
   */
  async runCheckAgent(toolCall: ToolCall): Promise<ToolResult> {
    const parsed = parseCheckAgentInput(toolCall.arguments);
    if (!parsed.ok) return { success: false, output: '', error: parsed.error };
    const { agentId, waitMs } = parsed.input;

    if (!agentId) {
      const views = this.listViews();
      if (views.length === 0) {
        return { success: true, output: 'No sub-agents have been started in this session.' };
      }
      const lines = views.map(v => `- ${v.agentId} [${v.type}] ${v.description} — ${v.status}`);
      return { success: true, output: `Sub-agents in this session:\n${lines.join('\n')}` };
    }

    if (waitMs > 0 && this.runs.has(agentId)) {
      await this.waitForAgentTerminal(agentId, waitMs);
    }

    const run = this.runs.get(agentId);
    const view = run ? { ...run.view } : this.finishedViews.get(agentId);
    if (!view) {
      return {
        success: false,
        output: '',
        error: `Unknown agentId "${agentId}". Use check_agent without agentId to list agents.`,
      };
    }
    if (run) {
      return {
        success: true,
        output: `[Agent ${agentId}] still ${view.status}${view.currentActivity ? ` — ${view.currentActivity}` : ''}. `
          + `${view.rounds} rounds, ${view.toolCalls} tool calls so far. Check again later or keep working.`,
      };
    }
    // 已结束：优先给终态报告全文（若已生成且尚未被自动注入取走）。
    const full = this.backgroundHub.takeOutput(agentId);
    return {
      success: true,
      output: full ?? this.finishedOutput(agentId, view),
    };
  }

  private waitForAgentTerminal(agentId: string, waitMs: number): Promise<void> {
    if (!this.runs.has(agentId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const current = this.agentTerminalWaiters.get(agentId);
        if (current) {
          const index = current.indexOf(finish);
          if (index >= 0) current.splice(index, 1);
          if (current.length === 0) this.agentTerminalWaiters.delete(agentId);
        }
        resolve();
      };
      const waiters = this.agentTerminalWaiters.get(agentId) ?? [];
      waiters.push(finish);
      this.agentTerminalWaiters.set(agentId, waiters);
      const timer = setTimeout(finish, waitMs);
      if (!this.runs.has(agentId)) finish();
    });
  }

  private notifyAgentTerminal(agentId: string): void {
    const waiters = this.agentTerminalWaiters.get(agentId);
    if (!waiters?.length) return;
    this.agentTerminalWaiters.delete(agentId);
    for (const wake of [...waiters]) wake();
  }

  private finishedOutput(agentId: string, view: AgentView): string {
    return `[Agent ${agentId}] finished with status=${view.status}.`
      + (view.reportPreview ? `\n--- report preview ---\n${view.reportPreview}` : '');
  }

  /**
   * 父 Harness 在 task 所在工具轮结束后取走合并数据（取一次即清除）。
   * 验证证据只保留「命令之后任何子 Agent 都没再写过工作区」的那些。
   */
  takeOutcome(parentToolCallId: string): AgentTaskOutcome | undefined {
    const pending = this.outcomes.get(parentToolCallId);
    if (!pending) return undefined;
    this.outcomes.delete(parentToolCallId);
    return {
      agentId: pending.agentId,
      filesChanged: pending.filesChanged,
      freshEvidence: pending.evidence
        .filter(e => e.writeSeq === this.writeSeq)
        .map(({ toolCallId, classification }) => ({ toolCallId, classification })),
    };
  }

  async runTask(toolCall: ToolCall, parent: AgentParentContext): Promise<ToolResult> {
    const parsed = parseTaskToolInput(toolCall.arguments);
    if (!parsed.ok) return { success: false, output: '', error: parsed.error };
    const type = parsed.input.subagentType;
    if (this.spawnedThisRun >= this.maxPerRun) {
      return {
        success: false,
        output: '',
        error: `Sub-agent limit reached: at most ${this.maxPerRun} sub-agents per user turn. `
          + 'Do the remaining work yourself.',
      };
    }
    this.spawnedThisRun++;

    const now = this.now();
    const agentId = createAgentId();
    const run: AgentRun = {
      agentId,
      type,
      prompt: parsed.input.prompt,
      parentToolCallId: toolCall.id,
      view: {
        agentId,
        parentToolCallId: toolCall.id,
        messageId: this.options.messageId,
        type: type.name,
        description: parsed.input.description,
        status: 'queued',
        startedAt: now,
        rounds: 0,
        toolCalls: 0,
        tokens: 0,
        filesChanged: [],
        commands: [],
        leaseRejects: 0,
      },
      controller: new AbortController(),
      originals: new Map(),
      touched: new Map(),
      fileStats: new Map(),
      commands: new Map(),
      leaseRejects: [],
      conflicts: [],
      streamTail: '',
      lastUpdateAt: 0,
      workspaceRoot: parent.workspaceRoot,
      background: parsed.input.runInBackground,
    };
    this.runs.set(agentId, run);
    run.view.background = run.background;

    // 前台子 Agent 随父回合中止；后台子 Agent 跨轮存活，只在 spawner 生命周期结束时中止。
    const lifetimeAbort = new AbortController();
    const onLifetimeAbort = () => this.abortRun(run, 'cancelled');
    this.parentAbort.signal.addEventListener('abort', onLifetimeAbort, { once: true });
    const stopSignal = run.background
      ? AbortSignal.any([lifetimeAbort.signal])
      : AbortSignal.any([lifetimeAbort.signal, ...(parent.signal ? [parent.signal] : [])]);
    const onStop = () => this.abortRun(run, 'cancelled');
    if (stopSignal.aborted) onStop();
    else stopSignal.addEventListener('abort', onStop, { once: true });

    this.emitUpdate(run, parent, true);
    void this.persistMeta(run);

    if (run.background) {
      this.backgroundHub.register({
        agentId,
        sessionId: this.options.parentSessionId,
        toolCallId: toolCall.id,
        type: type.name,
        description: run.view.description,
        startedAt: now,
      });
    }

    // 后台子 Agent 不受父回合 deadline 约束（主 Agent 可能已开始新一轮）。
    const taskParent: AgentParentContext = run.background
      ? { ...parent, deadline: undefined }
      : parent;

    const settle = async (): Promise<ToolResult> => {
      let acquired = false;
      try {
        acquired = await this.semaphore.acquire(run.controller.signal);
        if (!acquired) {
          return this.finish(run, taskParent, {
            status: 'cancelled',
            report: '',
            rounds: 0,
            toolCalls: 0,
            tokens: 0,
            messages: [],
          });
        }
        return await this.execute(run, taskParent);
      } finally {
        if (acquired) this.semaphore.release();
        stopSignal.removeEventListener('abort', onStop);
        this.parentAbort.signal.removeEventListener('abort', onLifetimeAbort);
        this.leases.releaseAgent(agentId);
        if (run.updateTimer) clearTimeout(run.updateTimer);
        this.runs.delete(agentId);
        this.notifyAgentTerminal(agentId);
      }
    };

    if (!run.background) return settle();

    // 后台：立即返回，允许主 Agent 继续；结果稍后进注册表。
    void settle().then(
      (result) => {
        this.backgroundHub.finish(agentId, this.runStatus(agentId), result.output);
      },
      () => {
        this.backgroundHub.finish(agentId, 'failed', '');
      },
    );
    return {
      success: true,
      output: `[Agent ${agentId}] started in background as ${type.name}. `
        + 'You can keep working; use check_agent to fetch its report, or it will be given to you automatically once it finishes.',
    };
  }

  private runStatus(agentId: string): AgentStatus {
    return this.finishedViews.get(agentId)?.status ?? 'failed';
  }

  // ─── 执行 ───

  private async execute(run: AgentRun, parent: AgentParentContext): Promise<ToolResult> {
    const startedAt = this.now();
    run.view.status = 'running';
    run.view.startedAt = startedAt;
    this.emitUpdate(run, parent, true);
    void this.persistMeta(run);

    const limits = resolveAgentLimits(run.type, { parentDeadline: parent.deadline, now: startedAt });
    const childConfig = this.buildChildConfig(run, parent, limits);
    const executor = new AgentRecordingToolExecutor(parent.toolExecutor, this.createRecorder(run));
    const harness = this.options.harnessFactory(childConfig, executor);
    harness.getStopHookManager().register(async (messages, lastContent) =>
      evaluateIncompleteTaskStopHook(messages, lastContent),
    );
    const llm = this.options.createLlm({
      agentId: run.agentId,
      agentType: run.type.name,
      signal: run.controller.signal,
    });

    const hardTimer = setTimeout(
      () => this.abortRun(run, 'timeout'),
      limits.timeoutMs + HARD_TIMEOUT_GRACE_MS,
    );
    try {
      const result = await harness.run(
        run.prompt,
        llm.chat,
        (event) => this.onChildStep(run, parent, event),
        undefined,
        llm.stream,
      );
      const loopState = result.loopState;
      const mapped = mapStopReasonToAgentStatus(loopState.stopReason, run.abortReason);
      return await this.finish(run, parent, {
        status: mapped.status,
        statusReason: mapped.reason,
        report: result.content ?? '',
        rounds: loopState.currentRound,
        toolCalls: loopState.totalToolCalls,
        tokens: loopState.totalInputTokens + loopState.totalOutputTokens,
        messages: result.messages,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status: AgentTerminalStatus = run.abortReason === 'timeout'
        ? 'timeout'
        : run.abortReason === 'cancelled' ? 'cancelled' : 'failed';
      return await this.finish(run, parent, {
        status,
        statusReason: status === 'failed' ? 'exception' : undefined,
        error: status === 'failed' ? message : undefined,
        report: run.streamTail,
        rounds: run.view.rounds,
        toolCalls: run.view.toolCalls,
        tokens: run.view.tokens,
        messages: [],
      });
    } finally {
      clearTimeout(hardTimer);
    }
  }

  private buildChildConfig(
    run: AgentRun,
    parent: AgentParentContext,
    limits: ReturnType<typeof resolveAgentLimits>,
  ): HarnessConfig {
    const pc = parent.config;
    const tools = filterToolsForAgentType(run.type, pc.context.tools);
    const source = this.sourceOf(run);
    const signal = run.controller.signal;
    // 父确认回调可选接收 signal 以撤掉挂着的确认；忽略 signal 的实现由 raceAbort 兜底
    const parentConfirm: AbortableConfirm<[string, Record<string, any>]> | undefined = pc.onConfirm;
    const parentShellConfirm: AbortableConfirm<[ShellMandatoryConfirmRequest]> | undefined =
      pc.onShellMandatoryConfirm;
    const onConfirm = this.options.onConfirm
      ? (toolName: string, args: Record<string, any>) =>
          raceAbort(() => this.options.onConfirm!(source, toolName, args, signal), signal)
      : parentConfirm
        ? (toolName: string, args: Record<string, any>) =>
            raceAbort(() => parentConfirm(toolName, args, signal), signal)
        : undefined;
    const onShellMandatoryConfirm = this.options.onShellMandatoryConfirm
      ? (req: ShellMandatoryConfirmRequest) =>
          raceAbort(() => this.options.onShellMandatoryConfirm!(source, req, signal), signal)
      : parentShellConfirm
        ? (req: ShellMandatoryConfirmRequest) => raceAbort(() => parentShellConfirm(req, signal), signal)
        : undefined;

    return {
      context: {
        systemPrompt: buildSubAgentSystemPrompt(run.type, tools.map(t => t.name)),
        tools,
        ...(pc.context.language ? { language: pc.context.language } : {}),
        ...(pc.context.environment ? { environment: pc.context.environment } : {}),
        ...(pc.context.userContext ? { userContext: pc.context.userContext } : {}),
        ...(pc.context.systemContext ? { systemContext: pc.context.systemContext } : {}),
      },
      loop: {
        maxRounds: limits.maxRounds,
        tokenBudget: limits.tokenBudget,
        timeout: limits.timeoutMs,
        signal,
        ...(pc.loop.maxOutputTokens ? { maxOutputTokens: pc.loop.maxOutputTokens } : {}),
      },
      permissions: pc.permissions,
      skipPermissionChecks: pc.skipPermissionChecks,
      compactionThreshold: pc.compactionThreshold,
      compactionTokenThreshold: pc.compactionTokenThreshold,
      compactionKeepRecent: pc.compactionKeepRecent,
      compactionEnableLLMSummary: pc.compactionEnableLLMSummary,
      compactionMaxReinjectFiles: pc.compactionMaxReinjectFiles,
      onConfirm,
      onShellMandatoryConfirm,
      sessionDir: agentsDirFor(this.options.sessionsDir, this.options.parentSessionId),
      sessionId: childSessionIdFor(run.agentId),
      workspaceRoot: parent.workspaceRoot,
      verificationExemptDirs: pc.verificationExemptDirs,
      memoryDisabled: true,
      checkpointOwner: {
        sessionDir: pc.checkpointOwner?.sessionDir ?? pc.sessionDir ?? this.options.sessionsDir,
        sessionId: pc.checkpointOwner?.sessionId ?? pc.sessionId ?? this.options.parentSessionId,
      },
      agentScope: this.createScope(run),
      workspaceLock: {
        ...(parent.lockedWorkspaceRoot ? { lockedRoot: parent.lockedWorkspaceRoot } : {}),
        referenceReads: [...(parent.referenceReads ?? [])],
      },
    };
  }

  // ─── 写租约 / 只读 / git 限制 ───

  private writeTargets(run: AgentRun, toolCall: ToolCall): string[] {
    if (!FILE_WRITE_TOOLS.has(toolCall.name) && toolCall.name !== 'fs_operation') return [];
    return collectSessionTouchedPaths(toolCall.name, toolCall.arguments)
      .map(p => normalizeWorkRelPath(run.workspaceRoot, p));
  }

  private createScope(run: AgentRun): AgentToolScope {
    return {
      agentId: run.agentId,
      checkBeforeTool: (toolCall) => {
        const gitSub = findBlockedSubAgentGitSubcommand(toolCall);
        if (gitSub) {
          return { reason: 'sub_agent_git_blocked', message: formatSubAgentGitBlockMessage(gitSub) };
        }
        if (run.type.readOnly && toolCall.name === 'fs_operation') {
          const op = String(toolCall.arguments?.operation ?? '').toLowerCase();
          if (op !== 'list') {
            return {
              reason: 'sub_agent_read_only',
              message: `[Harness / Sub-Agent] This is a read-only ${run.type.name} agent; fs_operation "${op}" is not allowed.`,
            };
          }
        }
        const targets = this.writeTargets(run, toolCall);
        if (targets.length === 0) return null;
        const now = this.now();
        const taken: string[] = [];
        for (const target of targets) {
          const acquired = this.leases.acquire(run.workspaceRoot, target, {
            agentId: run.agentId,
            description: run.view.description,
          }, now);
          if (acquired.ok) {
            if (!acquired.refreshed) taken.push(target);
            continue;
          }
          for (const path of taken) this.leases.release(run.workspaceRoot, path, run.agentId);
          run.leaseRejects.push({
            path: target,
            toolName: toolCall.name,
            holderAgentId: acquired.holder.agentId,
            holderDescription: acquired.holder.description,
            at: now,
          });
          run.view.leaseRejects = run.leaseRejects.length;
          return { reason: 'agent_write_lease', message: formatLeaseRejectMessage(target, acquired.holder) };
        }
        return null;
      },
      onCommandWorkspaceChange: (toolCall, diff) => this.onCommandWorkspaceChange(run, toolCall, diff),
    };
  }

  private onCommandWorkspaceChange(
    run: AgentRun,
    toolCall: ToolCall,
    diff: { created: string[]; changed: string[]; deleted: string[] },
  ): void {
    const tracking = run.commands.get(toolCall.id);
    const startedAt = tracking?.startedAt ?? this.now();
    const command = tracking?.command ?? String(toolCall.arguments?.command ?? toolCall.name);
    let ownMutation = false;
    const all = [
      ...diff.created.map(p => ({ p, kind: 'created' as const })),
      ...diff.changed.map(p => ({ p, kind: 'changed' as const })),
      ...diff.deleted.map(p => ({ p, kind: 'deleted' as const })),
    ];
    for (const { p, kind } of all) {
      const rel = normalizeWorkRelPath(run.workspaceRoot, p);
      const holder = this.leases.holderOf(run.workspaceRoot, rel);
      if (holder && holder.agentId !== run.agentId) {
        // 持有者在命令开始前就写过：命令改了别人正在改的文件。
        // 持有者在命令运行期间写入：那是对方自己的改动，不算本命令的。
        if (holder.lastWriteAt < startedAt) {
          const conflict = { path: rel, command, otherAgentId: holder.agentId, otherDescription: holder.description };
          run.conflicts.push(conflict);
          const other = this.runs.get(holder.agentId);
          other?.conflicts.push({
            path: rel,
            command,
            otherAgentId: run.agentId,
            otherDescription: run.view.description,
          });
        }
        continue;
      }
      ownMutation = true;
      if (kind === 'changed') continue;
      if (!run.touched.has(rel)) run.touched.set(rel, { viaCommand: true });
      if (!run.originals.has(rel) && kind === 'created') run.originals.set(rel, null);
      if (kind === 'deleted' && !run.fileStats.has(rel)) {
        run.fileStats.set(rel, { additions: 0, deletions: 0, created: false, deleted: true });
      }
      if (kind === 'created') void this.refreshFileStat(run, rel);
    }
    if (ownMutation) {
      this.writeSeq++;
      if (tracking) tracking.writeSeq = this.writeSeq;
    }
  }

  // ─── 工具记录 ───

  private createRecorder(run: AgentRun): AgentToolRecorder {
    return {
      beforeTool: async (toolCall) => {
        if (toolCall.name === 'run_command' || toolCall.name === 'shell_exec') {
          const args = toolCall.arguments ?? {};
          const foreignLeases = await Promise.all(
            this.leases.leasesHeldByOthers(run.agentId).map(async ({ absPath }) => ({
              absPath,
              content: await readFileOrNull(absPath),
            })),
          );
          run.commands.set(toolCall.id, {
            toolCallId: toolCall.id,
            command: String(args.command ?? args.cmd ?? args.action ?? ''),
            startedAt: this.now(),
            writeSeq: this.writeSeq,
            foreignLeases,
          });
        }
        for (const rel of this.writeTargets(run, toolCall)) {
          if (!run.originals.has(rel)) {
            run.originals.set(rel, await readFileOrNull(path.resolve(run.workspaceRoot, rel)));
          }
        }
      },
      afterTool: async (toolCall, result) => {
        if (toolCall.name === 'run_command' || toolCall.name === 'shell_exec') {
          const tracking = run.commands.get(toolCall.id);
          const violations = tracking ? await this.commandLeaseViolations(run, tracking) : [];
          if (toolCall.name === 'run_command') {
            const output = result.success ? result.output : `${result.error ?? ''}\n${result.output}`;
            const classification = classifyRunCommandResult(toolCall.arguments, output, result.success);
            if (tracking && classification) {
              tracking.classification = classification;
              tracking.writeSeq = this.writeSeq;
            } else if (tracking) {
              run.commands.delete(toolCall.id);
            }
            run.view.commands = collectCommandRecords(run).map(c => ({ command: c.command, exitCode: c.exitCode }));
          }
          if (violations.length === 0) return;
          const message = formatCommandLeaseViolationMessage(violations);
          return { ...result, success: false, error: result.error ? `${message}\n${result.error}` : message };
        }
        if (!result.success) return;
        const targets = this.writeTargets(run, toolCall);
        if (targets.length === 0) return;
        const now = this.now();
        this.writeSeq++;
        for (const rel of targets) {
          if (!run.touched.has(rel)) run.touched.set(rel, { viaCommand: false });
          this.leases.acquire(run.workspaceRoot, rel, { agentId: run.agentId, description: run.view.description }, now);
          void this.refreshFileStat(run, rel);
        }
      },
    };
  }

  /** 命令改动了其它 Agent 在命令开始前就已写过的租约文件。 */
  private async commandLeaseViolations(
    run: AgentRun,
    tracking: CommandTracking,
  ): Promise<Array<{ path: string; holder: WriteLeaseHolder }>> {
    const out: Array<{ path: string; holder: WriteLeaseHolder }> = [];
    for (const snap of tracking.foreignLeases) {
      const holder = this.leases.holderOf(run.workspaceRoot, snap.absPath);
      // 租约已释放，或持有者在命令运行期间自己写入：不算本命令的改动
      if (!holder || holder.agentId === run.agentId || holder.lastWriteAt >= tracking.startedAt) continue;
      if (await readFileOrNull(snap.absPath) === snap.content) continue;
      out.push({ path: normalizeWorkRelPath(run.workspaceRoot, snap.absPath), holder });
    }
    return out;
  }

  private async refreshFileStat(run: AgentRun, rel: string): Promise<void> {
    const original = run.originals.get(rel) ?? null;
    const current = await readFileOrNull(path.resolve(run.workspaceRoot, rel));
    const { additions, deletions } = countLineChanges(original, current);
    run.fileStats.set(rel, {
      additions,
      deletions,
      created: original === null && current !== null,
      deleted: original !== null && current === null,
    });
    run.view.filesChanged = this.liveFileList(run);
  }

  private liveFileList(run: AgentRun): AgentView['filesChanged'] {
    return [...run.fileStats.entries()]
      .filter(([rel, s]) => run.touched.has(rel) && (s.additions > 0 || s.deletions > 0 || s.created || s.deleted))
      .map(([rel, s]) => ({ path: rel, additions: s.additions, deletions: s.deletions }));
  }

  private async finalFileChanges(run: AgentRun): Promise<AgentFileChange[]> {
    const out: AgentFileChange[] = [];
    for (const [rel, meta] of run.touched) {
      const original = run.originals.has(rel) ? run.originals.get(rel)! : undefined;
      const current = await readFileOrNull(path.resolve(run.workspaceRoot, rel));
      if (original === undefined) {
        // 命令删掉的已有文件：没有原始内容，只知道被删了
        if (current === null) {
          out.push({ path: rel, additions: 0, deletions: 0, deleted: true, ...(meta.viaCommand ? { viaCommand: true } : {}) });
        }
        continue;
      }
      if (original === current) continue;
      const { additions, deletions } = countLineChanges(original, current);
      out.push({
        path: rel,
        additions,
        deletions,
        ...(original === null && current !== null ? { created: true } : {}),
        ...(original !== null && current === null ? { deleted: true } : {}),
        ...(meta.viaCommand ? { viaCommand: true } : {}),
      });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ─── 事件 ───

  private onChildStep(run: AgentRun, parent: AgentParentContext, event: HarnessStepEvent): void {
    if (event.iteration !== undefined && event.iteration > run.view.rounds) run.view.rounds = event.iteration;
    switch (event.type) {
      case 'thinking':
        if (event.tokenUsage) {
          run.view.tokens += (event.tokenUsage.inputTokens || 0) + (event.tokenUsage.outputTokens || 0);
        }
        run.streamTail = '';
        break;
      case 'tool_call':
        run.view.currentActivity = describeToolActivity(event.toolName ?? 'tool', event.toolArgs);
        run.streamTail = '';
        break;
      case 'tool_result':
        run.view.toolCalls++;
        break;
      case 'stream_delta':
        if (event.delta) {
          run.streamTail = (run.streamTail + event.delta).slice(-2000);
          const line = lastNonEmptyLine(run.streamTail);
          if (line) run.view.currentActivity = line;
        }
        break;
      default:
        break;
    }

    if (FORWARDED_EVENT_TYPES.has(event.type)) {
      parent.onStep?.({
        ...event,
        agentId: run.agentId,
        parentToolCallId: run.parentToolCallId,
        ...(event.toolCallId ? { toolCallId: `${run.agentId}:${event.toolCallId}` } : {}),
      });
    }
    this.emitUpdate(run, parent, false);
  }

  private emitUpdate(run: AgentRun, parent: AgentParentContext, immediate: boolean): void {
    const throttle = this.options.updateThrottleMs ?? DEFAULT_UPDATE_THROTTLE_MS;
    const send = () => {
      run.lastUpdateAt = this.now();
      run.updateTimer = undefined;
      parent.onStep?.({
        type: 'agent_update',
        agentId: run.agentId,
        parentToolCallId: run.parentToolCallId,
        agent: { ...run.view },
      });
    };
    if (immediate || throttle <= 0) {
      if (run.updateTimer) clearTimeout(run.updateTimer);
      send();
      return;
    }
    if (run.updateTimer) return;
    const wait = Math.max(0, throttle - (this.now() - run.lastUpdateAt));
    if (wait === 0) send();
    else run.updateTimer = setTimeout(send, wait);
  }

  // ─── 收尾 ───

  private async finish(
    run: AgentRun,
    parent: AgentParentContext,
    data: {
      status: AgentTerminalStatus;
      statusReason?: string;
      error?: string;
      report: string;
      rounds: number;
      toolCalls: number;
      tokens: number;
      messages: UnifiedMessage[];
    },
  ): Promise<ToolResult> {
    const finishedAt = this.now();
    const filesChanged = await this.finalFileChanges(run);
    const commands = collectCommandRecords(run);
    const report = data.report.trim();

    run.view = {
      ...run.view,
      status: data.status as AgentStatus,
      finishedAt,
      rounds: Math.max(run.view.rounds, data.rounds),
      toolCalls: Math.max(run.view.toolCalls, data.toolCalls),
      tokens: Math.max(run.view.tokens, data.tokens),
      filesChanged: filesChanged.map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
      commands: commands.map(c => ({ command: c.command, exitCode: c.exitCode })),
      leaseRejects: run.leaseRejects.length,
      reportPreview: report.slice(0, AGENT_REPORT_PREVIEW_CHARS),
      ...(data.error ? { error: data.error } : {}),
    };
    delete run.view.currentActivity;

    this.outcomes.set(run.parentToolCallId, {
      agentId: run.agentId,
      filesChanged,
      evidence: [...run.commands.values()]
        .filter(c => isTerminalClassification(c.classification))
        .map(c => ({ toolCallId: c.toolCallId, classification: c.classification!, writeSeq: c.writeSeq })),
    });

    const persist = this.options.persist !== false;
    const transcriptPath = persist
      ? agentMessagesPath(this.options.sessionsDir, this.options.parentSessionId, run.agentId)
      : undefined;
    if (persist) {
      await Promise.all([
        data.messages.length > 0
          ? saveAgentMessages(this.options.sessionsDir, this.options.parentSessionId, run.agentId, data.messages)
            .catch(() => undefined)
          : Promise.resolve(),
        this.persistMeta(run, {
          report,
          statusReason: data.statusReason,
          fileChangeDetails: filesChanged,
          commandRecords: commands,
        }),
      ]);
    }

    this.finishedViews.set(run.agentId, { ...run.view });
    this.emitUpdate(run, parent, true);

    const output = formatAgentResult({
      agentId: run.agentId,
      type: run.type.name,
      status: data.status,
      statusReason: data.statusReason,
      durationMs: finishedAt - (run.view.startedAt ?? finishedAt),
      rounds: run.view.rounds,
      toolCalls: run.view.toolCalls,
      tokens: run.view.tokens,
      filesChanged,
      commands,
      leaseRejects: run.leaseRejects,
      commandConflicts: run.conflicts,
      report,
      error: data.error,
      transcriptPath,
    });
    return { success: true, output };
  }

  private async persistMeta(run: AgentRun, extra: Partial<AgentMetaRecord> = {}): Promise<void> {
    if (this.options.persist === false) return;
    const meta: AgentMetaRecord = {
      ...run.view,
      parentSessionId: this.options.parentSessionId,
      childSessionId: childSessionIdFor(run.agentId),
      prompt: run.prompt,
      leaseRejectRecords: run.leaseRejects,
      commandConflicts: run.conflicts,
      updatedAt: this.now(),
      ...extra,
    };
    await saveAgentMeta(this.options.sessionsDir, meta).catch(() => undefined);
  }

  private abortRun(run: AgentRun, reason: 'timeout' | 'cancelled'): void {
    if (run.controller.signal.aborted) return;
    run.abortReason = reason;
    run.controller.abort();
  }

  private sourceOf(run: AgentRun): AgentSource {
    return { agentId: run.agentId, description: run.view.description, type: run.type.name };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

type AbortableConfirm<A extends unknown[]> = (...args: [...A, AbortSignal?]) => Promise<boolean>;

/** 已停止时不再发起确认；未响应 signal 的确认在停止后按拒绝处理。 */
function raceAbort(confirm: () => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    confirm().then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      () => { signal.removeEventListener('abort', onAbort); resolve(false); },
    );
  });
}
