/**
 * Harness — 核心循环引擎（状态机模式）。
 *
 * 使用 while(true) + 可变 State 对象的迭代模式，
 * 避免深度递归导致的栈溢出。
 *
 * 每轮迭代：
 * 1. 消息预处理（工具结果预算裁剪 → 上下文压缩）
 * 2. 调用 LLM
 * 3. 处理响应
 * 4. 决定 continue / stop
 *
 * state.transition 记录每次 continue 的原因，方便调试和测试。
 */

import type { UnifiedMessage, ToolDefinition, ToolCall } from '../llm/types.js';
import { estimateMessagesTokens, estimateStringTokens } from '../llm/token-estimator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type {
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  ChatFunction,
  StreamFunction,
  StopReason,
  ToolPermissionRule,
} from './types.js';
import { ContextAssembler, normalizeMessages } from './context-assembler.js';
import { LoopController } from './loop-controller.js';
import { ContextCompactor, type CompactionConfig } from './context-compactor.js';
import { HarnessLogger, type LlmRoundLogMeta, type LlmRoundTokenUsage } from './logger.js';
import { StopHookManager } from './stop-hooks.js';
import { TokenBudgetTracker } from './token-budget.js';
import { StreamingToolExecutor } from './streaming-tool-executor.js';
import { getToolMetadata, isDestructiveOperation, isDestructiveCommand } from '../tools/tool-metadata.js';
import { HarnessMemoryIntegration } from './harness-memory.js';
import { inferIntent, TaskState } from './task-state.js';
import { RepoContext } from './repo-context.js';
import { TaskCheckpointManager, type TaskCheckpointStatus, type TaskCheckpointUpdate } from './checkpoint.js';
import { buildToolPlan, formatToolPlan } from './tool-planner.js';
import { RuntimeTelemetry } from './runtime-telemetry.js';
// Execution plan layer removed (Phase 11) — replaced by TaskGraph
import { shouldUseTaskGraph } from './task-graph-config.js';
import { BranchBudgetTracker } from './branch-budget.js';
import { CheckpointEngine, isResilienceV2Enabled } from './checkpoint-engine.js';
import { reviewStep, type StepReviewResult } from './step-review.js';
import { GraphExecutor } from './task-graph-executor.js';
import type { CheckpointSaveTrigger } from '../types/runtime-checkpoint.js';
import { getMaxToolOutputChars } from '../tools/tool-output-limits.js';
import {
  ensureDelegateToSubagentTool,
  formatSubAgentResult,
  SubAgentRunner,
} from './sub-agent-runner.js';

// ─── max-output-tokens 恢复最大次数 ───
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

// ─── 连续工具失败提示干预阈值 ───
// 第3轮开始注入强提示A，第6轮开始注入强提示B，第10轮触发熔断
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
const CIRCUIT_BREAKER_THRESHOLD = 10;

// ─── LLM 空响应重试最大次数 ───
const MAX_EMPTY_RESPONSE_RETRIES = 2;

// ─── stop_hook 连续干预上限 ───
const MAX_STOP_HOOK_CONTINUATIONS = 3;

// ─── LLM 调用重试配置（Harness 层仅做 1 次快速重试，主要重试由 LLMAdapter 负责） ───
const LLM_MAX_RETRIES = 1;
const LLM_RETRY_BASE_DELAY = 2000;
const LLM_RETRY_MAX_DELAY = 2000;

/** 工具调用阶段发往 UI 的一步提示文案（缓解长时间无 SSE 体感）。 */
function toolExecutionUserHint(toolName: string): string {
  const hints: Record<string, string> = {
    read_file: '正在读取文件（大文件将自动截断）…',
    edit_file: '正在编辑文件, 请稍后...',
    search_codebase: '正在搜索代码库，可能需要几秒…',
    parse_document: '正在解析文档，较大文件可能较慢…',
    run_command: '正在执行命令…',
    fs_operation: '正在操作文件或目录…',
    fetch_url: '正在请求 URL…',
    web_search: '正在联网搜索…',
    git: '正在执行 git…',
    browse_directory: '正在浏览目录…',
    list_drives: '正在列出磁盘…',
    parse_pptx_deep: '正在深度解析 PPTX…',
    parse_xmind_deep: '正在解析 XMind…',
    image_read: '正在读取图片…',
  };
  return hints[toolName] ?? `正在执行「${toolName}」…`;
}

// ─── 工具结果预算裁剪 ───
const TOOL_RESULT_KEEP_RECENT = 6;
const TOOL_RESULT_BUDGET_PER_MESSAGE = 3000;
const SUBAGENT_RESULT_KEEP_RECENT = 6;
const OLD_SUBAGENT_SUMMARY_CHARS = 300;

// ─── 任务切换检测 ───
const TASK_SWITCH_JACCARD_THRESHOLD = 0.15;

/** 硬压缩前等待会话笔记 LLM 更新的上限（毫秒）。超时则用磁盘已有内容继续。固定为 2 分钟。 */
const PRE_COMPACT_SESSION_MEMORY_WAIT_MS = 120_000;
const PRE_COMPACT_SESSION_TIMEOUT_MSG = 'pre_compact_session_memory_timeout';

/** 构造 LLM 轮次日志字段（provider usage 分项 + 本地上下文估算）。 */
function buildLlmRoundLogFields(
  messages: UnifiedMessage[],
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheMissTokens?: number;
  },
): { usage: LlmRoundTokenUsage; meta: LlmRoundLogMeta } {
  return {
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheMissTokens: usage?.cacheMissTokens,
    },
    meta: {
      messageCount: messages.length,
      estContextTokens: estimateMessagesTokens(messages),
    },
  };
}

/**
 * 基于字符 bigram 的 Jaccard 相似度（零外部依赖，纯 CPU 计算）。
 * 用于检测用户新消息与上一轮 assistant 回复之间的主题关联度。
 */
function bigramJaccard(a: string, b: string): number {
  if (!a || !b) return 0;
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.substring(i, i + 2));
    }
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 从消息列表中提取最近一条 assistant 的纯文本回复。
 */
function getLastAssistantText(messages: UnifiedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return '';
}

/**
 * 识别「非真人用户」的 user 前缀（运行时状态、会话笔记摘要、工具规划等）。
 * {@link getLatestRealUserText} 会跳过此类消息。
 */
function isSystemInjectedUserContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('<system-context>')
    || trimmed.startsWith('<system-reminder>')
    || trimmed.startsWith('<session-notes>')
    || trimmed.startsWith('<context-summary>')
    || trimmed.startsWith('[System Runtime State]')
    || trimmed.startsWith('[System')
    || trimmed.startsWith('[Runtime Tool Planner]')
    || trimmed.startsWith('Please provide a final summary answer based on the tool call results above.')
    || trimmed.startsWith('Continue directly');
}

/** 倒序查找第一条未被 {@link isSystemInjectedUserContent} 排除的 user 文本。 */
function getLatestRealUserText(messages: UnifiedMessage[], fallback = ''): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (isSystemInjectedUserContent(msg.content)) continue;
    return msg.content;
  }
  return fallback;
}

/** 是否已有 assistant 带 `toolCalls` 的轮次（任意位置）。 */
function hasAssistantToolCallAttempt(messages: UnifiedMessage[]): boolean {
  return messages.some(m => m.role === 'assistant' && !!m.toolCalls?.length);
}

/**
 * 自最近一条真实 user 起，后方是否出现过 assistant `toolCalls`。
 * 用于判别「本条用户输入之后模型是否尝试过工具」。
 */
function hasAssistantToolCallAfterLatestRealUser(messages: UnifiedMessage[]): boolean {
  let latestRealUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (isSystemInjectedUserContent(msg.content)) continue;
    latestRealUserIndex = i;
    break;
  }
  if (latestRealUserIndex < 0) return hasAssistantToolCallAttempt(messages);

  return messages
    .slice(latestRealUserIndex + 1)
    .some(m => m.role === 'assistant' && !!m.toolCalls?.length);
}

/**
 * 是否适合首轮注入 Runtime Tool Planner，并可能与执行计划同开。
 *
 * - 第一层：中英文子串判断是否像「要动工具的工程诉求」；
 * - 第二层：若以纯疑问措辞开头且无实现侧关键词，视为不可执行。
 */
function isActionableToolRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  const rawTrim = text.trim();
  if (!t) return false;

  const isActionable = /修(复|好|改)|改一下|解决|处理|排查|看看为什么|优化|重构|实现|落地|执行|运行|测试|检查|读取|搜索|创建|新增|删除|生成|添加|提交|创建.*pr/i.test(t)
    || /\b(fix|debug|investigate|implement|modify|edit|update|refactor|search|read|create|delete|commit|check)\b/i.test(t)
    || /\b(run|execute)\s+\S+/i.test(t)
    || /\b(test|verify)\s+\S+|\S+\s+(tests?|verification)\b/i.test(t);
  if (!isActionable) return false;

  // 「分析一下…」等与英文 \b：JS 的词边界夹在汉字之间常为 false，需单独前缀或分隔符判别
  const questionOnlyCn = rawTrim.startsWith('分析一下')
    || rawTrim.startsWith('说明一下')
    || rawTrim.startsWith('解释一下')
    || rawTrim.startsWith('为什么')
    || rawTrim.startsWith('如何')
    || rawTrim.startsWith('怎么')
    || /^解释([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^说明([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^分析([\s\u3000，。、！？]|$)/.test(rawTrim);
  const questionOnly = (questionOnlyCn || /^(what|why|how)\b/i.test(t))
    && !/(修|改|解决|处理|运行|测试|fix|modify|run|test|implement)/i.test(t);
  return !questionOnly;
}

/** 子代理回灌的 tool 消息格式，供历史裁剪识别。 */
function isSubAgentToolResult(msg: UnifiedMessage): msg is UnifiedMessage & { content: string } {
  return msg.role === 'tool'
    && typeof msg.content === 'string'
    && msg.content.startsWith('[SubAgent Result]');
}

/**
 * 压缩过旧子代理 tool 结果正文；保留 `summary:\\n` 前头部，对摘要段单独限长。
 */
function truncateOldSubAgentResult(content: string): string {
  const marker = '\nsummary:\n';
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) {
    return content.length > OLD_SUBAGENT_SUMMARY_CHARS
      ? `${content.slice(0, OLD_SUBAGENT_SUMMARY_CHARS)}\n...[旧子代理结果已裁剪，原始长度 ${content.length} 字符]`
      : content;
  }

  const header = content.slice(0, markerIndex + marker.length);
  const summary = content.slice(markerIndex + marker.length);
  if (summary.length <= OLD_SUBAGENT_SUMMARY_CHARS) return content;
  return `${header}${summary.slice(0, OLD_SUBAGENT_SUMMARY_CHARS)}\n...[旧子代理摘要已裁剪，原始长度 ${summary.length} 字符]`;
}

// ─── 默认压缩配置 ───
const DEFAULT_COMPACTION_THRESHOLD = 40;
const DEFAULT_COMPACTION_KEEP_RECENT = 15;

/** 判断错误是否可重试（网络超时、限流、服务端错误） */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // 网络错误
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused')
      || msg.includes('fetch failed') || msg.includes('network')) return true;
    // 限流
    if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests')) return true;
    // 服务端错误
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('overloaded')) return true;
  }
  return false;
}

/**
 * 循环 continue 的原因（用于调试和测试）。
 */
type Transition =
  | 'initial'
  | 'tool_calls'
  | 'no_tool_execution_recovery'
  | 'max_output_tokens_recovery'
  | 'stop_hook_continue'
  | 'llm_error_retry'
  | 'compaction_retry';

/**
 * 迭代间携带的可变状态。
 */
interface LoopState {
  /** 当前对话消息列表 */
  messages: UnifiedMessage[];
  /** 可用工具定义 */
  tools: ToolDefinition[];
  /** 当前轮次 */
  turnCount: number;
  /** max-output-tokens 恢复计数 */
  maxOutputTokensRecoveryCount: number;
  /** LLM 调用连续重试计数 */
  llmRetryCount: number;
  /** LLM 空响应重试计数 */
  emptyResponseRetryCount: number;
  /** 连续工具失败轮次计数（一轮中所有工具都失败才算 1 次） */
  consecutiveToolFailures: number;
  /** 连续只读轮次计数（无 write/edit 工具调用的轮次） */
  consecutiveReadOnlyRounds: number;
  /** 执行型任务但模型未调用工具时的自动恢复次数 */
  noToolExecutionRecoveryCount: number;
  /** 本轮是否已注入任务切换提示（防止重复注入） */
  taskSwitchInjected: boolean;
  /** stop_hook 连续干预计数 */
  stopHookContinuationCount: number;
  /** 上一次 continue 的原因 */
  transition: Transition;
  /** 本轮是否刚刚完成上下文压缩 */
  justCompacted: boolean;
  /** 压缩后失忆恢复次数（每次压缩后最多 1 次） */
  amnesiaRecoveryCount: number;
  /** 当前任务状态账本 */
  taskState: TaskState;
  /** 当前仓库上下文账本 */
  repoContext: RepoContext;
  /** 上次注入 runtime state 的内容 hash */
  runtimeStateHash: string;
  /** 连续失败的工具调用签名计数 */
  failedToolCallSignatures: Map<string, number>;
  /** Resilience v2：分支预算 tracker */
  branchBudget?: BranchBudgetTracker;
  /** Resilience v2：本轮是否已注入过 branch-budget warning（避免重复） */
  branchBudgetWarnedThisRound: boolean;
  /** Resilience v2：本轮是否已做过 step review（避免重复） */
  stepReviewedThisRound: boolean;
  /** Resilience v2：最近一次 step review 结果（供启发式参考） */
  lastStepReview?: StepReviewResult;
}

/**
 * Harness 是带工具调用的 LLM 迭代循环引擎。
 *
 * 用户 prompt 决定"做什么"，Harness 决定"怎么做"。
 * 只有在安全边界上，Harness 才会硬性覆盖用户意图。
 */
export class Harness {
  private contextAssembler: ContextAssembler;
  private loopController: LoopController;
  private contextCompactor: ContextCompactor;
  private toolExecutor: ToolExecutor;
  private stopHookManager: StopHookManager;
  private tokenBudgetTracker?: TokenBudgetTracker;
  private permissionRules: ToolPermissionRule[];
  private onConfirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  /** 记忆集成层（解耦的记忆系统交互） */
  private memoryIntegration: HarnessMemoryIntegration;
  /** 用户中断信号（传递给工具执行器，实现跨层超时中断） */
  private abortSignal?: AbortSignal;
  private checkpointManager?: TaskCheckpointManager;
  /** 同一 checkpoint JSON 路径上串联 TaskCheckpointManager 与 CheckpointEngine 的磁盘写，消除交叉 rename 间歇读失效。 */
  private checkpointPersistTail = Promise.resolve();
  /** TaskGraph 执行器（Phase 11 始终开启） */
  private graphExecutor: GraphExecutor;
  private runtimeTelemetry?: RuntimeTelemetry;
  private workspaceRoot: string;

  /** Runtime Resilience v2（始终开启，与 isResilienceV2Enabled 一致） */
  private resilienceV2Enabled: boolean;
  /** Resilience v2：增强 checkpoint 引擎（无 sessionDir 时未创建） */
  private checkpointEngine?: CheckpointEngine;


  constructor(
    config: HarnessConfig,
    toolExecutor: ToolExecutor,
  ) {
    const context = {
      ...config.context,
      tools: ensureDelegateToSubagentTool(config.context.tools),
    };
    this.contextAssembler = new ContextAssembler(context);
    this.loopController = new LoopController(config.loop);
    const compactionPartial: Partial<CompactionConfig> = {
      threshold: config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
      tokenThreshold: config.compactionTokenThreshold,
      keepRecent: config.compactionKeepRecent ?? DEFAULT_COMPACTION_KEEP_RECENT,
      enableLLMSummary: config.compactionEnableLLMSummary,
    };
    if (config.compactionMaxReinjectFiles != null) {
      compactionPartial.maxReinjectFiles = config.compactionMaxReinjectFiles;
    }
    this.contextCompactor = new ContextCompactor(compactionPartial);
    this.toolExecutor = toolExecutor;
    this.stopHookManager = new StopHookManager();
    this.permissionRules = config.permissions ?? [];
    this.onConfirm = config.onConfirm;
    this.abortSignal = config.loop.signal;
    this.workspaceRoot = config.workspaceRoot ?? process.cwd();
    this.checkpointManager = config.sessionDir
      ? new TaskCheckpointManager(config.sessionDir, config.sessionId)
      : undefined;
    this.runtimeTelemetry = new RuntimeTelemetry(config.sessionDir, config.sessionId);


    // Resilience v2：无 sessionDir 时不创建 CheckpointEngine（v2 磁盘合并）；其余子逻辑仍开启
    this.resilienceV2Enabled = isResilienceV2Enabled();
    if (this.resilienceV2Enabled && config.sessionDir) {
      this.checkpointEngine = new CheckpointEngine(config.sessionDir, config.sessionId);
    }

    // TaskGraph 始终开启 (Phase 11)
    this.graphExecutor = new GraphExecutor();

    // 记忆集成层
    this.memoryIntegration = new HarnessMemoryIntegration({
      memoryDir: config.memoryDir,
      fileMemoryManager: config.fileMemoryManager,
      sessionDir: config.sessionDir,
      workspaceRoot: config.workspaceRoot,
    });

    // 如果配置了 token 预算，创建追踪器
    if (config.loop.tokenBudget) {
      this.tokenBudgetTracker = new TokenBudgetTracker({
        totalBudget: config.loop.tokenBudget,
      });
    }
  }

  /** 将 checkpoint/v2 磁盘更新串行化（仅在有持久化路径时生效）。 */
  private enqueueCheckpointPersist<T>(task: () => Promise<T>): Promise<T> {
    if (!this.checkpointManager && !this.checkpointEngine) {
      return task();
    }
    const run = () => task();
    const p = this.checkpointPersistTail.then(run, run);
    this.checkpointPersistTail = p.then(
      (): void => {},
      (): void => {},
    );
    return p;
  }

  /**
   * 执行核心循环（状态机模式）。
   *
   * while(true) + State 对象，每轮迭代 = 预处理 → LLM 调用 → 响应处理 → 决定继续/停止。
   *
   * @param userMessage - 用户输入
   * @param chatFn - LLM 调用函数（非流式，用于工具调用轮次的回退）
   * @param onStep - 每一步的回调（用于 SSE 实时推送）
   * @param existingMessages - 已有的对话消息历史
   * @param streamFn - LLM 流式调用函数（可选，启用后文本回复逐 chunk 推送）
   * @returns Harness 执行结果（包含结构化日志）
   */
  async run(
    userMessage: string,
    chatFn: ChatFunction,
    onStep?: (event: HarnessStepEvent) => void,
    existingMessages?: UnifiedMessage[],
    streamFn?: StreamFunction,
    /** 多模态用户消息内容（图片等），如果提供则替代纯文本 userMessage 作为消息内容 */
    userContentBlocks?: import('../llm/types.js').ContentBlock[],
  ): Promise<HarnessResult> {
    const logger = new HarnessLogger();

    // ── 初始化（循环外，只执行一次）──
    // 如果有已有消息历史，直接追加用户消息；否则从零构建
    let messages: UnifiedMessage[];
    const messageContent = userContentBlocks ?? userMessage;
    if (existingMessages && existingMessages.length > 0) {
      messages = existingMessages;
      messages.push({ role: 'user', content: messageContent });
    } else {
      messages = this.contextAssembler.assembleInitialMessages(userMessage);
      // 如果有多模态内容，替换最后一条 user 消息的 content
      if (userContentBlocks) {
        const lastUserIdx = messages.length - 1;
        if (messages[lastUserIdx]?.role === 'user') {
          messages[lastUserIdx] = { ...messages[lastUserIdx], content: userContentBlocks };
        }
      }
    }
    const activeCheckpoint = await this.checkpointManager?.loadActive();
    if (activeCheckpoint) {
      messages.push(this.checkpointManager!.buildResumeMessage(activeCheckpoint));
    }
    const tools = this.contextAssembler.getTools();
    logger.loopStart(tools.length, messages.length);


    // 保存用户消息用于记忆相关性检索
    this.memoryIntegration.onLoopStart(
      userMessage,
      {
        chat: async (msgs, opts) => chatFn(msgs, { tools: [], ...opts }),
        stream: async () => { throw new Error('Stream not supported for memory sideQuery'); },
        countTokens: async (text) => estimateStringTokens(text),
      },
    );

    // 初始化可变状态
    const state: LoopState = {
      messages,
      tools,
      turnCount: 0,
      maxOutputTokensRecoveryCount: 0,
      llmRetryCount: 0,
      emptyResponseRetryCount: 0,
      consecutiveToolFailures: 0,
      consecutiveReadOnlyRounds: 0,
      noToolExecutionRecoveryCount: 0,
      taskSwitchInjected: false,
      stopHookContinuationCount: 0,
      transition: 'initial',
      justCompacted: false,
      amnesiaRecoveryCount: 0,
      taskState: new TaskState(userMessage),
      repoContext: new RepoContext(),
      runtimeStateHash: '',
      failedToolCallSignatures: new Map(),
      branchBudget: this.resilienceV2Enabled ? new BranchBudgetTracker() : undefined,
      branchBudgetWarnedThisRound: false,
      stepReviewedThisRound: false,
    };

    if (this.resilienceV2Enabled && this.checkpointEngine) {
      try {
        const v2 = await this.checkpointEngine.loadV2();
        if (v2) {
          state.branchBudget?.applySnapshot(v2.branchBudget);
          const pending = this.checkpointEngine.pendingRecoverySignals();
          if (pending.length > 0) {
            for (const sig of pending) {
              messages.push({ role: 'user', content: sig.message });
            }
            this.checkpointEngine.markRecoverySignalsConsumed(s => !s.consumed);
          }
        }
      } catch (err) {
        console.debug(
          '[harness] resilience v2 load failed:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (existingMessages && existingMessages.length > 0) {
      try {
        const hydrated = await this.memoryIntegration.hydrateRuntimeFromSessionNotes(
          state.taskState,
          state.repoContext,
        );
        if (hydrated) {
          onStep?.({
            type: 'memory_event',
            memoryKind: 'session_hydrate',
            memoryDetail: '已从会话笔记恢复任务与仓库状态',
          });
        }
      } catch (err) {
        console.debug(
          '[harness] session-notes 运行时恢复失败:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // checkpoint plan resume removed (Phase 11 — TaskGraph handles context)

    // ── 核心循环（while(true) 迭代模式）──
    // try/finally 确保无论哪条路径退出，记忆合并都会执行一次
    try {
    while (true) {
      // 1. 解构当前状态
      const { messages: msgs, tools: currentTools } = state;

      // 2. 消息预处理管线（微压缩 → 硬压缩，不修改已有消息内容）
      await this.maybeCompact(msgs, chatFn, logger, onStep, state);

      // 3. 推进轮次，检查循环控制
      this.loopController.advanceRound();
      state.turnCount++;
      const round = this.loopController.getState().currentRound;
      logger.roundStart(round, msgs.length);
      this.runtimeTelemetry?.recordRound({
        round,
        task: state.taskState.snapshot(),
        repo: state.repoContext.snapshot(),
      });

      const loopStop = this.loopController.shouldContinue();
      if (loopStop) {
        return this.handleStop(loopStop, msgs, chatFn, currentTools, logger, onStep, streamFn, state);
      }

      // 4. 调用 LLM（带错误恢复）
      logger.llmCall();

      this.upsertRuntimeContextMessage(msgs, state);

      // TaskGraph: init graph on first round — gated by TaskDomainGate
      if (state.turnCount === 1 && this.graphExecutor) {
        const taskSnapshot = state.taskState.snapshot();
        if (shouldUseTaskGraph(taskSnapshot.intent)) {
          this.graphExecutor.initGraph({
            goal: taskSnapshot.goal || userMessage,
            intent: taskSnapshot.intent,
          });
          onStep?.({ type: 'task_graph_init', graphGoal: taskSnapshot.goal || userMessage, graphIntent: taskSnapshot.intent });
        }
      }

      // TaskGraph: inject node context before LLM call
      if (this.graphExecutor?.hasGraph()) {
        const ctx = this.graphExecutor.getCurrentNodeContext();
        if (ctx) {
          msgs.push({ role: 'user', content: ctx });
        }
        const snap = this.graphExecutor.toSnapshot();
        if (snap?.cursor) {
          onStep?.({ type: 'task_graph_node', nodeId: snap.cursor.nodeId, nodeIndex: snap.cursor.nodeIndex, graphStatus: snap.status });
        }
      }

      await this.memoryIntegration.injectMemoryContext(msgs, { mode: 'coarse_pre_llm', onStep });

      if (
        state.turnCount === 1
        && currentTools.length > 0
        && isActionableToolRequest(getLatestRealUserText(msgs, userMessage))
      ) {
        msgs.push({
          role: 'user',
          content: formatToolPlan(
            buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot()),
          ),
        });

        // 首轮可执行：若检测到下面对话块会判定「与上一轮 assistant 无关」则延后初始化计划，
        // 避免任务切换分支重复推送 plan 事件。
        const preLatest = getLatestRealUserText(msgs, userMessage);
        const preAssistant = getLastAssistantText(msgs);
        const pendingUnrelatedAssistant = !!(
          preLatest
          && preAssistant
          && bigramJaccard(preLatest, preAssistant) < TASK_SWITCH_JACCARD_THRESHOLD
        );
        // maybeInitExecutionPlan removed (Phase 11 — TaskGraph handles init)
      }

      // 消息规范化：合并连续 user 消息、去重 tool_use ID、清理空消息
      // 工具结果预算裁剪在副本上执行，不修改原始消息（保持前缀缓存一致性）
      const normalizedMsgs = normalizeMessages(msgs);
      this.applySubAgentResultRetention(normalizedMsgs);
      this.applyToolResultBudget(normalizedMsgs);

      // ── 任务切换检测（bigram Jaccard）──
      // 比较最新用户消息与上一轮 assistant 回复的主题关联度
      if (!state.taskSwitchInjected) {
        const latestUserContent = getLatestRealUserText(msgs, userMessage);
        const lastAssistantText = getLastAssistantText(msgs);
        if (latestUserContent && lastAssistantText) {
          const similarity = bigramJaccard(latestUserContent, lastAssistantText);
          if (similarity < TASK_SWITCH_JACCARD_THRESHOLD) {
            msgs.push({
              role: 'user',
              content: '[System: You have received a new task request that appears unrelated to the current pending work. Completely pause any previous task and focus only on the new instruction. Do not resume previous actions unless explicitly asked.]',
            });
            state.taskSwitchInjected = true;
            // Execution plan task-switch reset removed (Phase 11)
          }
        }
      }

      // maybeRefreshExecutionPlanForContinuedWork removed (Phase 11)

      // 检查用户中断
      if (this.loopController.isAborted()) {
        return this.handleStop('user_abort', msgs, chatFn, currentTools, logger, onStep, streamFn, state);
      }

      let response;
      try {
        // ── 选择流式或非流式调用 ──
        if (streamFn) {
          try {
            response = await streamFn(normalizedMsgs, (chunk, done) => {
              // 用户中断后不再推送流式增量
              if (this.loopController.isAborted()) return;
              if (!done && chunk) {
                onStep?.({ type: 'stream_delta', iteration: round, delta: chunk });
              }
            }, { tools: currentTools });
          } catch (streamError) {
            // 流式调用失败（如 DeepSeek thinking 模式的 reasoning_content 兼容问题）
            // 自动回退到非流式调用
            const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
            if (errMsg.includes('reasoning_content') || errMsg.includes('Failed to deserialize')) {
              console.log('[harness] 流式调用失败，回退到非流式: ' + errMsg.substring(0, 100));
              response = await chatFn(normalizedMsgs, { tools: currentTools });
            } else {
              throw streamError;
            }
          }
          // 流式调用完成后检查中断（流式期间可能收到 abort）
          if (this.loopController.isAborted()) {
            return this.handleStop('user_abort', msgs, chatFn, currentTools, logger, onStep, streamFn, state);
          }
        } else {
          response = await chatFn(normalizedMsgs, { tools: currentTools });
        }
        state.llmRetryCount = 0; // 成功后重置重试计数
      } catch (error) {
        // ── LLM 调用错误恢复（仅 1 次快速重试，主要重试由 LLMAdapter 负责） ──
        if (isRetryableError(error) && state.llmRetryCount < LLM_MAX_RETRIES && !this.loopController.isAborted()) {
          state.llmRetryCount++;
          const delay = Math.min(
            LLM_RETRY_BASE_DELAY * Math.pow(2, state.llmRetryCount - 1),
            LLM_RETRY_MAX_DELAY,
          );
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`LLM 调用失败 (${state.llmRetryCount}/${LLM_MAX_RETRIES}): ${errorMsg}，${delay}ms 后重试`);
          // 支持中断的等待
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            const checkAbort = () => { clearTimeout(timer); resolve(); };
            if (this.loopController.isAborted()) { checkAbort(); return; }
            // 每 500ms 检查一次中断状态
            const interval = setInterval(() => {
              if (this.loopController.isAborted()) { clearInterval(interval); checkAbort(); }
            }, 500);
            const origResolve = resolve;
            resolve = () => { clearInterval(interval); origResolve(); };
          });
          state.transition = 'llm_error_retry';
          // 回退轮次计数（重试不算新轮次）
          this.loopController.rewindRound();
          state.turnCount--;
          continue;
        }

        // 不可重试或重试次数用完 → 返回错误
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`LLM 调用失败且无法恢复: ${errorMsg}`);
        this.loopController.stop('error');
        const finalState = this.loopController.getState();
        logger.loopStop('error', finalState.currentRound, finalState.totalToolCalls);

        onStep?.({
          type: 'final',
          iteration: finalState.currentRound,
          totalToolCalls: finalState.totalToolCalls,
          content: `LLM 调用错误: ${errorMsg}`,
          stopReason: 'error',
        });

        return {
          content: `LLM 调用错误: ${errorMsg}`,
          loopState: finalState,
          messages: [...msgs],
          log: logger.getEntries(),
        };
      }

      const tokenUsage = {
        input: response.usage?.inputTokens ?? 0,
        output: response.usage?.outputTokens ?? 0,
      };
      const llmRoundLog = buildLlmRoundLogFields(normalizedMsgs, response.usage);
      this.loopController.recordTokenUsage(tokenUsage.input, tokenUsage.output);
      this.runtimeTelemetry?.recordRound({
        round,
        task: state.taskState.snapshot(),
        repo: state.repoContext.snapshot(),
        tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
      });

      // 记录 token 预算
      if (this.tokenBudgetTracker) {
        this.tokenBudgetTracker.recordUsage(tokenUsage.input, tokenUsage.output);
      }

      // 5. 处理响应：无工具调用 → 进入退出/恢复逻辑
      const hasToolCalls = !!response.toolCalls?.length;

      if (!hasToolCalls) {
        logger.llmResponseFinal(llmRoundLog.usage, llmRoundLog.meta);

        // ── 5a. 压缩后失忆检测与自动补救 ──
        if (state.justCompacted && state.amnesiaRecoveryCount < 1) {
          const responseText = response.content || '';
          const amnesiaPatterns = [
            /无法确定.*任务/, /不确定.*任务/, /忘记/, /请重复/, /请描述/,
            /unsure what task/i, /don'?t know what task/i, /what (was|is) the task/i,
            /can'?t remember/i, /forgot/i, /what would you like/i,
          ];
          const isAmnesia = amnesiaPatterns.some(p => p.test(responseText));
          if (isAmnesia) {
            state.amnesiaRecoveryCount++;
            console.log('[harness] 检测到压缩后失忆，自动注入任务上下文...');
            // 注入 assistant 回复（即使它可能是询问）
            if (response.content) {
              msgs.push({ role: 'assistant', content: response.content });
            }
            // 尝试从会话笔记读取任务描述
            try {
              const sessionNotes = await this.memoryIntegration.getSessionMemoryForCompact();
              if (sessionNotes) {
                msgs.push({
                  role: 'user',
                  content: `<system-reminder>\n## Task Recovery\nContext was just compressed. Your session notes contain the current task:\n\n${sessionNotes.substring(0, 1500)}\n\nContinue executing the task described above. Do NOT ask the user to repeat the task.\n</system-reminder>`,
                });
              } else {
                msgs.push({
                  role: 'user',
                  content: '[System: Context was just compressed. Continue with the most recent task. Check the conversation history above for the task description. Do not ask the user to repeat the task.]',
                });
              }
            } catch {
              msgs.push({
                role: 'user',
                content: '[System: Context was just compressed. Continue with the most recent task. If you cannot determine the task, check the files you were working on.]',
              });
            }
            state.justCompacted = false;
            continue;
          }
          // 没有失忆迹象 → 正常完成，清除标记
          state.justCompacted = false;
        }

        // ── 5b. max-output-tokens 恢复 ──
        // finishReason === 'length' 时注入"请继续"，最多重试 3 次
        if (
          response.finishReason === 'length'
          && state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
        ) {
          state.maxOutputTokensRecoveryCount++;
          console.log(
            `[harness] max-output-tokens 恢复 (${state.maxOutputTokensRecoveryCount}/${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT})`,
          );

          // 将模型的部分回复加入对话
          if (response.content) {
            msgs.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
          }
          // 精确措辞防止模型浪费 token 重复之前的内容
          msgs.push({
            role: 'user',
            content: 'Continue directly — do not apologize, do not restate previous content. If the last response was cut off mid-way, continue from where it left off. Split remaining work into smaller steps.',
          });
          state.transition = 'max_output_tokens_recovery';
          continue;
        }

        // 如果 max-output-tokens 恢复次数用完，报告停止原因
        if (
          response.finishReason === 'length'
          && state.maxOutputTokensRecoveryCount >= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
        ) {
          this.loopController.stop('max_output_tokens');
          const finalState = this.loopController.getState();
          logger.loopStop('max_output_tokens', finalState.currentRound, finalState.totalToolCalls);

          onStep?.({
            type: 'final',
            iteration: finalState.currentRound,
            totalToolCalls: finalState.totalToolCalls,
            content: response.content,
            stopReason: 'max_output_tokens',
            tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
            totalTokenUsage: {
              inputTokens: finalState.lastInputTokens,
              outputTokens: finalState.lastOutputTokens,
            },
          });

          return {
            content: response.content,
            loopState: finalState,
            messages: [...msgs],
            log: logger.getEntries(),
          };
        }

        // ── 5b. LLM 空响应恢复 ──
        // 空内容 + 无工具调用 + 非 length 截断 → 可能是 API 偶发异常
        if (
          (!response.content || !response.content.trim())
          && state.emptyResponseRetryCount < MAX_EMPTY_RESPONSE_RETRIES
        ) {
          state.emptyResponseRetryCount++;
          console.log(
            `[harness] LLM 空响应重试 (${state.emptyResponseRetryCount}/${MAX_EMPTY_RESPONSE_RETRIES})`,
          );
          msgs.push({ role: 'user', content: 'Please continue.' });
          state.transition = 'max_output_tokens_recovery';
          continue;
        }

        // 空响应重试用完 → 走 error 路径
        if (!response.content || !response.content.trim()) {
          this.loopController.stop('error');
          const finalState = this.loopController.getState();
          logger.loopStop('error', finalState.currentRound, finalState.totalToolCalls);

          onStep?.({
            type: 'final',
            iteration: finalState.currentRound,
            totalToolCalls: finalState.totalToolCalls,
            content: 'LLM returned empty response',
            stopReason: 'error',
          });

          return {
            content: 'LLM returned empty response, please retry.',
            loopState: finalState,
            messages: [...msgs],
            log: logger.getEntries(),
          };
        }

        // 空响应重试成功（有内容了），重置计数
        state.emptyResponseRetryCount = 0;

        // ── 5c. 停止钩子（兜底） ──
        if (this.stopHookManager.count > 0) {
          const hookResult = await this.stopHookManager.execute(msgs, response.content);
          if (hookResult.shouldContinue && hookResult.message) {
            // 连续干预上限检查，防止钩子无限振荡
            state.stopHookContinuationCount++;
            if (state.stopHookContinuationCount > MAX_STOP_HOOK_CONTINUATIONS) {
              console.log(`[harness] 停止钩子连续干预 ${state.stopHookContinuationCount} 次，强制停止`);
              this.loopController.stop('stop_hook');
              const finalState = this.loopController.getState();
              logger.loopStop('stop_hook', finalState.currentRound, finalState.totalToolCalls);

              onStep?.({
                type: 'final',
                iteration: finalState.currentRound,
                totalToolCalls: finalState.totalToolCalls,
                content: response.content,
                stopReason: 'stop_hook',
              });

              return {
                content: response.content,
                loopState: finalState,
                messages: [...msgs],
                log: logger.getEntries(),
              };
            }

            console.log(`[harness] 停止钩子 "${hookResult.hookName}" 要求继续 (${state.stopHookContinuationCount}/${MAX_STOP_HOOK_CONTINUATIONS})`);
            msgs.push({ role: 'user', content: hookResult.message });
            state.transition = 'stop_hook_continue';
            continue;
          }
        }

        if (
          currentTools.length > 0
          && !hasAssistantToolCallAfterLatestRealUser(msgs)
          && state.noToolExecutionRecoveryCount < 1
          && state.stopHookContinuationCount === 0
          && isActionableToolRequest(getLatestRealUserText(msgs, userMessage))
        ) {
          state.noToolExecutionRecoveryCount++;
          if (response.content) {
            msgs.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
          }
          msgs.push({
            role: 'user',
            content: [
              '[System] The user asked for an executable software-engineering action, but you did not call any tools. Continue now by calling the appropriate tool(s) to inspect, modify, run, test, or verify as needed. Do not answer with a plan or promise unless the task is impossible.',
              '',
              formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot())),
            ].join('\n'),
          });
          state.transition = 'no_tool_execution_recovery';
          continue;
        }

        const canRunVerification = currentTools.some(t => t.name === 'run_command');
        if (canRunVerification && state.taskState.shouldBlockFinalForVerification()) {
          if (response.content) {
            msgs.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
          }
          msgs.push({
            role: 'user',
            content: [
              state.taskState.buildVerificationPrompt(),
              '',
              formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot())),
            ].join('\n'),
          });
          // currentPlanTracker.onVerificationRequired removed (Phase 11)
          await this.resilienceSaveCheckpoint('verification_started', state);
          state.transition = 'stop_hook_continue';
          continue;
        }

        // 模型正常完成，重置 stop hook 计数
        state.stopHookContinuationCount = 0;

        // ── 5d. 正常完成 → return ──
        // TaskGraph: advance cursor before stop
        if (this.graphExecutor?.hasGraph()) {
          const ar = this.graphExecutor.advanceOrComplete();
          if (ar.graphDone) {
            onStep?.({ type: 'task_graph_done' });
          }
        }

        this.loopController.stop('model_done');
        const finalState = this.loopController.getState();
        logger.loopStop('model_done', finalState.currentRound, finalState.totalToolCalls);
        // currentPlanTracker.onFinal removed (Phase 11)
        await this.saveTaskCheckpoint('completed', userMessage, msgs, state, 'model_done');
        await this.resilienceSaveCheckpoint('final_draft', state, 'model_done');
        this.recordTelemetrySummary('model_done', state);

        onStep?.({
          type: 'final',
          iteration: finalState.currentRound,
          totalToolCalls: finalState.totalToolCalls,
          content: response.content,
          stopReason: 'model_done',
          tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
          totalTokenUsage: {
            inputTokens: finalState.lastInputTokens,
            outputTokens: finalState.lastOutputTokens,
          },
        });

        return {
          content: response.content,
          loopState: finalState,
          messages: [...msgs],
          log: logger.getEntries(),
        };
      }

      // 6. 有工具调用 → 执行工具（正常恢复，清除压缩标记）
      if (state.justCompacted) state.justCompacted = false;
      logger.llmResponseToolCalls(response.toolCalls!.length, llmRoundLog.usage, llmRoundLog.meta);

      // 推送思考内容（如果有）
      onStep?.({
        type: 'thinking',
        iteration: round,
        content: response.content || undefined,
        tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
        totalTokenUsage: {
          inputTokens: this.loopController.getState().lastInputTokens,
          outputTokens: this.loopController.getState().lastOutputTokens,
        },
      });

      // 将 assistant 的 tool_calls 消息加入对话
      msgs.push({
        role: 'assistant',
        content: response.content || '',
        toolCalls: response.toolCalls,
        reasoningContent: response.reasoningContent,
      });

      // 6a. 执行工具调用（StreamingToolExecutor 并行 + 权限检查 + 中断检查 + 记忆记录）
      state.branchBudgetWarnedThisRound = false;
      state.stepReviewedThisRound = false;

      // TaskGraph: check tool calls before execution
      if (this.graphExecutor?.hasGraph() && response.toolCalls) {
        for (const tc of response.toolCalls) {
          const check = this.graphExecutor.checkToolCall(tc.name);
          if (check.action === 'block' && check.message) {
            msgs.push({ role: 'user', content: check.message });
          } else if (check.action === 'warn' && check.message) {
            msgs.push({ role: 'user', content: check.message });
          }
        }
      }

      const toolStats = await this.executeToolCallsStreaming(
        response.toolCalls!, msgs, logger, onStep, this.abortSignal, state.taskState, state.repoContext, chatFn, currentTools,
      );

      // 6a-resilience-v2. 把这一轮工具调用录入 branchBudget（仅 flag 启用时执行）
      await this.resilienceRecordToolCalls(
        response.toolCalls!,
        new Set(toolStats.failedSignatures),
        state,
      );

      const repeatedFailures = this.collectRepeatedFailures(response.toolCalls!, toolStats.failedSignatures, state.failedToolCallSignatures);
      if (repeatedFailures.length > 0) {
        msgs.push({
          role: 'user',
          content: `[System] Repeated failed tool call detected: ${repeatedFailures.join(', ')}. Do not retry the same tool with the same arguments. Change the path, parameters, command, or use a different tool; if blocked, explain the exact blocker and evidence.`,
        });
      }

      // 6a-resilience-v2. 分支预算超限 → 注入 recovery warning
      this.resilienceMaybeBranchRecover(state, msgs);

      // 6a-resilience-v2. 工具失败 → 触发 step review（启发式 + 可选 LLM）
      if (toolStats.failedCount > 0) {
        await this.resilienceMaybeReviewStep(state, 'tool_failure', chatFn);
      }

      // 6a-resilience-v2. 验证失败 → 单独 hook（与 tool_failure 区分，便于 checkpoint trigger 归类）
      if (state.taskState.snapshot().verificationStatus === 'failed') {
        await this.resilienceSaveCheckpoint('verification_failed', state);
        if (!state.stepReviewedThisRound) {
          await this.resilienceMaybeReviewStep(state, 'verification_failure', chatFn);
        }
      }

      // 6a-abort. 工具执行后立即检查中断
      if (this.loopController.isAborted()) {
        return this.handleStop('user_abort', msgs, chatFn, currentTools, logger, onStep, streamFn, state);
      }

      // 6a-fuse. 连续工具失败处理（渐进式提示干预 + 最终熔断）
      if (toolStats.totalCount > 0 && toolStats.failedCount === toolStats.totalCount) {
        state.consecutiveToolFailures++;
        const failureCount = state.consecutiveToolFailures;

        if (failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
          // 第10轮：触发熔断，停止循环
          console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，触发熔断`);
          this.loopController.stop('circuit_breaker');
          const finalState = this.loopController.getState();
          logger.loopStop('circuit_breaker', finalState.currentRound, finalState.totalToolCalls);
          // currentPlanTracker.onFinal removed (Phase 11)
          await this.saveTaskCheckpoint('failed', userMessage, msgs, state, 'circuit_breaker');
          this.recordTelemetrySummary('circuit_breaker', state);

          onStep?.({
            type: 'final',
            iteration: finalState.currentRound,
            totalToolCalls: finalState.totalToolCalls,
            content: `${failureCount} consecutive rounds of tool calls failed, circuit breaker triggered.`,
            stopReason: 'circuit_breaker',
          });

          return {
            content: `${failureCount} consecutive rounds of tool calls failed, circuit breaker triggered. The last errors have been logged; please check tool configuration or environment and retry.`,
            loopState: finalState,
            messages: [...msgs],
            log: logger.getEntries(),
          };
        }

        if (failureCount >= 6) {
          // 第6-9轮：注入更强提示，禁止重复同一失败调用，但允许换策略继续用工具
          msgs.push({
            role: 'user',
            content: `[System] Warning: ${failureCount} consecutive rounds of tool calls have all failed. Multiple attempts have not succeeded.\n\nYou must:\n1. Stop retrying the same failed tool calls, commands, paths, or parameters\n2. Switch strategy: use a different tool, inspect paths/configuration, simplify the command, or ask for missing input\n3. If blocked, explain the exact blocker and evidence to the user\n\nYou may still use tools, but only with a changed strategy. Do not repeat an identical failed operation.`,
          });
          console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入换策略提示`);
        } else if (failureCount >= MAX_CONSECUTIVE_TOOL_FAILURES) {
          // 第3-5轮：注入强提示A，要求分析失败原因并换方法
          const lastErrors = msgs
            .slice(-6)
            .filter(m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('Tool execution error:'))
            .map(m => (m.content as string).substring(0, 200));

          const errorSummary = lastErrors.length > 0
            ? `Recent errors:\n${lastErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
            : '';

          msgs.push({
            role: 'user',
            content: `[System] Note: ${failureCount} consecutive rounds of tool calls have all failed.${errorSummary ? '\n' + errorSummary : ''}\n\nPlease analyze the failure reasons and adopt a completely different approach to complete the task. Possible adjustment directions:\n- Check if file paths are correct (use list_directory to confirm)\n- Check if command syntax is correct\n- Try using alternative tools\n- If execution is truly impossible, directly explain the reason to the user and do not continue trying the same operation.`,
          });
          console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入策略调整提示`);
        } else if (failureCount === 2) {
          // 第2轮：轻提示，提醒上一轮失败了
          msgs.push({
            role: 'user',
            content: '[System] All tool calls in the previous round failed. Please check if parameters are correct and try adjusting your approach.',
          });
        }
        // 第1轮：不干预，让模型自己处理错误信息
      } else {
        // 有成功执行的工具，重置计数
        state.consecutiveToolFailures = 0;
      }

      // TaskGraph: record tool results and evaluate round
      if (this.graphExecutor?.hasGraph() && response.toolCalls) {
        for (const tc of response.toolCalls) {
          const sig = this.toolCallSignature(tc);
          const success = !toolStats.failedSignatures.includes(sig);
          this.graphExecutor.recordToolResult(tc.name, success);
        }
        const evalResult = this.graphExecutor.evaluateRound(response.toolCalls.length);
        if (evalResult.action === 'force_switch') {
          onStep?.({ type: 'task_graph_branch', reason: 'fallback_activated', message: evalResult.message });
          if (evalResult.message) {
            msgs.push({ role: 'user', content: evalResult.message });
          }
        } else if (evalResult.message) {
          msgs.push({ role: 'user', content: evalResult.message });
        }
      }

      await this.saveTaskCheckpoint('running', userMessage, msgs, state);
      await this.resilienceSaveCheckpoint('step_completed', state);

      // 6a-readonly. 连续只读轮次跟踪（分析瘫痪检测）
      const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'patch_file', 'run_command']);
      const hadWriteTool = response.toolCalls?.some(tc => WRITE_TOOLS.has(tc.name)) ?? false;
      if (hadWriteTool) {
        state.consecutiveReadOnlyRounds = 0;
      } else if (response.toolCalls?.length) {
        state.consecutiveReadOnlyRounds++;
        if (state.consecutiveReadOnlyRounds === 5) {
          msgs.push({
            role: 'user',
            content: '[System] You have been reading/analyzing for 5 rounds without making any edits. If you have enough context, start implementing changes now using write/edit tools. Do not read more files unless absolutely necessary.',
          });
        }
      }

      // 6b. 注入记忆上下文（文件记忆 + 结构化记忆检索）
      // 放在所有 tool 结果之后、下一轮 LLM 调用之前
      await this.memoryIntegration.injectMemoryContext(msgs, { onStep });

      // 6c. maxTurns 检查（由 loopController 处理）
      const nextStop = this.loopController.shouldContinue();
      if (nextStop) {
        return this.handleStop(nextStop, msgs, chatFn, currentTools, logger, onStep, streamFn, state);
      }

      // 6d. 构造下一轮状态 → continue
      // 重置恢复计数（工具调用成功意味着模型在正常工作）
      state.maxOutputTokensRecoveryCount = 0;
      state.llmRetryCount = 0;
      state.emptyResponseRetryCount = 0;
      state.transition = 'tool_calls';
      // messages 和 tools 已就地更新，直接 continue
    }
    } finally {
      // ETL persist & reset removed (Phase 11 — TaskGraph handles persistence)

      // 记忆合并：fire-and-forget，不阻塞主循环返回
      // 提取/Dream/会话记忆更新在后台异步完成，
      // 进程退出时由 drainExtractions 确保完成。
      this.memoryIntegration.onLoopEnd(
        state.messages,
        state.turnCount,
        this.loopController.getState().totalInputTokens,
        { task: state.taskState.snapshot(), repo: state.repoContext.snapshot() },
      ).catch(err => {
        console.debug('[harness] memory onLoopEnd failed:', err instanceof Error ? err.message : err);
      });
      // 注意：不调用 dispose()，因为后台任务仍在使用 memoryIntegration。
      // dispose 由外部调用方（chat.ts 的 shutdown cleanup）负责。
    }
  }


  /**
   * 工具结果预算裁剪。
   *
   * 对旧的工具结果做大小预算裁剪，防止上下文爆炸。
   * 越早的工具结果裁剪越激进，最近的保持完整。
   */
  private applyToolResultBudget(messages: UnifiedMessage[]): void {
    // 保留最近 6 条 tool 消息不裁剪，对更早的做渐进式截断
    const KEEP_RECENT = TOOL_RESULT_KEEP_RECENT;
    const BUDGET_PER_MESSAGE = TOOL_RESULT_BUDGET_PER_MESSAGE;

    let toolMsgCount = 0;
    // 从后往前数 tool 消息
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'tool') toolMsgCount++;
    }

    if (toolMsgCount <= KEEP_RECENT) return;

    // 从前往后裁剪旧的 tool 消息
    let seen = 0;
    const cutoff = toolMsgCount - KEEP_RECENT;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
      seen++;
      if (seen > cutoff) break;

      if (msg.content.length > BUDGET_PER_MESSAGE) {
        messages[i] = {
          ...msg,
          content: msg.content.substring(0, BUDGET_PER_MESSAGE)
            + `\n...[工具结果已裁剪，原始长度 ${msg.content.length} 字符]`,
        };
      }
    }
  }

  /**
   * 子代理结果本身已经是摘要；长对话里只保留最近几条完整摘要，旧摘要再次压缩。
   */
  private applySubAgentResultRetention(messages: UnifiedMessage[]): void {
    let subAgentResultCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!isSubAgentToolResult(msg)) continue;

      subAgentResultCount++;
      if (subAgentResultCount <= SUBAGENT_RESULT_KEEP_RECENT) continue;

      messages[i] = {
        ...msg,
        content: truncateOldSubAgentResult(msg.content),
      };
    }
  }

  // ─── 记忆集成由 HarnessMemoryIntegration 处理 ───

  /**
   * LLM 调用前注入 `[System Runtime State]`：TaskState + RepoContext 快照。
   * 无读/写/命令且无需验证时不注入；内容未变（hash）则去重旧块后覆盖。
   */
  private upsertRuntimeContextMessage(messages: UnifiedMessage[], state: LoopState): void {
    const repoSnapshot = state.repoContext.snapshot();
    const taskSnapshot = state.taskState.snapshot();
    const shouldInject = repoSnapshot.filesRead.length > 0
      || repoSnapshot.filesChanged.length > 0
      || repoSnapshot.commandsRun.length > 0
      || taskSnapshot.verificationRequired;
    if (!shouldInject) return;

    const content = [
      '[System Runtime State]',
      '# Runtime State',
      JSON.stringify(taskSnapshot, null, 2),
      '',
      '# Repo Context',
      JSON.stringify(repoSnapshot, null, 2),
      '[/System Runtime State]',
    ].join('\n');

    if (content === state.runtimeStateHash) return;
    state.runtimeStateHash = content;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('[System Runtime State]')) {
        messages.splice(i, 1);
      }
    }
    messages.push({ role: 'user', content });
  }

  /**
   * 使用 StreamingToolExecutor 执行工具调用。
   *
   * 并行安全的工具（isConcurrencySafe）并行执行，
   * 非并行安全的工具串行执行。
   * 每个工具执行前检查权限和用户中断。
   * 中断时为未完成的 tool_use 补齐错误 tool_result。
   *
   * @returns 工具执行统计（用于连续失败熔断判断）
   */
  private async executeToolCallsStreaming(
    toolCalls: ToolCall[],
    messages: UnifiedMessage[],
    logger: HarnessLogger,
    onStep?: (event: HarnessStepEvent) => void,
    harnessAbortSignal?: AbortSignal,
    taskState?: TaskState,
    repoContext?: RepoContext,
    chatFn?: ChatFunction,
    currentTools?: ToolDefinition[],
  ): Promise<{ failedCount: number; totalCount: number; failedSignatures: string[] }> {
    const streamingExecutor = new StreamingToolExecutor(
      this.toolExecutor,
      onStep ? (toolCallId, toolName, chunk) => {
        onStep({
          type: 'tool_output',
          toolName,
          content: chunk,
        });
      } : undefined,
      harnessAbortSignal,
    );
    const iteration = this.loopController.getState().currentRound;
    let directFailedCount = 0;
    let directTotalCount = 0;
    const directFailedSignatures: string[] = [];

    // 第一遍：权限检查 + 提交到流式执行器
    const submittedIds = new Set<string>();
    for (const tc of toolCalls) {
      // 检查用户中断
      if (this.loopController.isAborted()) {
        this.yieldMissingToolResults(toolCalls, submittedIds, messages);
        break;
      }

      if (tc.name === 'delegate_to_subagent') {
        logger.toolCall(tc.name, tc.arguments);
        onStep?.({ type: 'tool_call', iteration, toolName: tc.name, toolArgs: tc.arguments });
        onStep?.({
          type: 'tool_progress',
          iteration,
          phase: 'running',
          toolName: tc.name,
          content: '正在委派只读子代理探索代码库…',
        });

        let output: string;
        let success = true;
        let error: string | undefined;
        try {
          if (!chatFn || !currentTools) {
            throw new Error('delegate_to_subagent requires Harness chat function and tool definitions');
          }
          const runner = new SubAgentRunner({
            toolExecutor: this.toolExecutor,
            toolDefinitions: currentTools,
            chatFn,
            workspaceRoot: this.workspaceRoot,
          });
          const result = await runner.run({
            task: String(tc.arguments.task ?? ''),
            context: typeof tc.arguments.context === 'string' ? tc.arguments.context : undefined,
          });
          output = formatSubAgentResult(result);
          success = result.status !== 'error';
          error = result.error;
        } catch (err) {
          success = false;
          error = err instanceof Error ? err.message : String(err);
          output = `工具执行错误: ${error}`;
        }

        directTotalCount++;
        if (!success) {
          directFailedCount++;
          directFailedSignatures.push(this.toolCallSignature(tc));
        }
        logger.toolResult(tc.name, success, output.length, error);
        this.runtimeTelemetry?.recordTool({
          round: iteration,
          toolName: tc.name,
          success,
          outputLength: output.length,
        });
        onStep?.({
          type: 'tool_result',
          iteration,
          toolName: tc.name,
          toolSuccess: success,
          toolOutput: output.substring(0, 500),
          toolError: success ? undefined : error,
        });
        messages.push({
          role: 'tool',
          content: output,
          toolCallId: tc.id,
        });
        taskState?.recordToolResult(tc, { success, output, error });
        repoContext?.recordToolResult(tc, { success, output, error });
        if (taskState && repoContext) {
          // currentPlanTracker.onToolResult removed (Phase 11)
        }
        this.loopController.recordToolCalls(1);
        submittedIds.add(tc.id);
        continue;
      }

      // ── 权限检查：显式规则优先，破坏性工具兜底确认 ──
      const permission = this.resolveToolPermission(tc);
      if (permission.permission === 'deny') {
        logger.toolResult(tc.name, false, 0, permission.reason ?? 'Tool denied by policy');
        onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
        messages.push({
          role: 'tool',
          content: `Tool ${tc.name} denied by policy${permission.reason ? `: ${permission.reason}` : ''}. Please use a different approach or ask the user.`,
          toolCallId: tc.id,
        });
        submittedIds.add(tc.id);
        continue;
      }

      if (permission.permission === 'confirm' && !this.onConfirm) {
        const reason = permission.reason ?? 'Confirmation required but no confirmation handler is configured';
        logger.toolResult(tc.name, false, 0, reason);
        onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
        messages.push({
          role: 'tool',
          content: `Tool ${tc.name} requires confirmation but no confirmation handler is configured${permission.reason ? `: ${permission.reason}` : ''}. Please use a different approach or ask the user.`,
          toolCallId: tc.id,
        });
        submittedIds.add(tc.id);
        continue;
      }

      if (permission.permission === 'confirm' && this.onConfirm) {
        const confirmToolName = this.formatConfirmToolName(tc);
        onStep?.({ type: 'tool_confirm', iteration, toolName: confirmToolName, toolArgs: tc.arguments });
        const allowed = await this.onConfirm(confirmToolName, tc.arguments);
        if (!allowed) {
          logger.toolResult(tc.name, false, 0, 'User denied execution');
          onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
          messages.push({
            role: 'tool',
            content: `User denied tool ${tc.name}. Please try a different approach to complete the task, or ask the user.`,
            toolCallId: tc.id,
          });
          submittedIds.add(tc.id);
          continue;
        }
      }

      // ── 提交到流式执行器 ──
      logger.toolCall(tc.name, tc.arguments);
      onStep?.({ type: 'tool_call', iteration, toolName: tc.name, toolArgs: tc.arguments });
      onStep?.({
        type: 'tool_progress',
        iteration,
        phase: 'running',
        toolName: tc.name,
        content: toolExecutionUserHint(tc.name),
      });
      streamingExecutor.submit(tc);
      submittedIds.add(tc.id);
    }

    // 第二遍：等待所有已提交的工具完成，收集结果
    const results = await streamingExecutor.flush();
    const processedIds = new Set<string>();
    let failedCount = directFailedCount;
    const failedSignatures: string[] = [...directFailedSignatures];

    for (const sr of results) {
      // 中断后跳过剩余结果处理
      if (this.loopController.isAborted()) break;

      const { toolCall: tc, result } = sr;
      const output = result.success ? result.output : `工具执行错误: ${result.error}`;

      if (!result.success) {
        failedCount++;
        failedSignatures.push(this.toolCallSignature(tc));
      }

      logger.toolResult(tc.name, result.success, output.length, result.error);
      this.runtimeTelemetry?.recordTool({
        round: iteration,
        toolName: tc.name,
        success: result.success,
        outputLength: output.length,
      });
      onStep?.({
        type: 'tool_result',
        iteration,
        toolName: tc.name,
        toolSuccess: result.success,
        toolOutput: output.substring(0, 500),
        toolError: result.success ? undefined : result.error,
      });

      const toolMeta = getToolMetadata(tc.name);
      const maxCap = getMaxToolOutputChars();
      const maxOutput = toolMeta.maxResultSizeChars === Infinity ? maxCap : Math.min(toolMeta.maxResultSizeChars, maxCap);
      const truncatedOutput = output.length > maxOutput
        ? output.substring(0, maxOutput) + `\n\n[输出已截断，原始长度: ${output.length} 字符]`
        : output;

      messages.push({
        role: 'tool',
        content: truncatedOutput,
        toolCallId: tc.id,
      });

      taskState?.recordToolResult(tc, result);
      repoContext?.recordToolResult(tc, result);
      if (taskState && repoContext) {
        // currentPlanTracker.onToolResult removed (Phase 11)
      }

      processedIds.add(tc.id);
      this.loopController.recordToolCalls(1);
    }

    // 如果中断发生，为未处理的工具补齐 tool_result
    if (this.loopController.isAborted()) {
      this.yieldMissingToolResults(toolCalls, processedIds, messages);
    }

    return { failedCount, totalCount: results.length + directTotalCount, failedSignatures };
  }

  /**
   * 为未完成的 tool_use 补齐错误 tool_result。
   *
   * 中断或错误时，API 要求每个 tool_use 都有对应的 tool_result，
   * 否则下一轮调用会报错。
   */
  private yieldMissingToolResults(
    toolCalls: ToolCall[],
    completedIds: Set<string>,
    messages: UnifiedMessage[],
  ): void {
    for (const tc of toolCalls) {
      if (completedIds.has(tc.id)) continue;
      // 检查消息中是否已有此 tool_result（权限拒绝等情况）
      const hasResult = messages.some(m => m.role === 'tool' && m.toolCallId === tc.id);
      if (hasResult) continue;

      messages.push({
        role: 'tool',
        content: 'Tool execution was interrupted.',
        toolCallId: tc.id,
      });
    }
  }



  // attachExecutionPlan + maybeInitExecutionPlan removed (Phase 11 — TaskGraph handles context)

  // maybeRefreshExecutionPlanForContinuedWork removed (Phase 11 — TaskGraph replaces it)

  private async saveTaskCheckpoint(
    status: TaskCheckpointStatus,
    userGoal: string,
    messages: UnifiedMessage[],
    runtimeState: {
      taskState: TaskState;
      repoContext: RepoContext;
      failedToolCallSignatures: Map<string, number>;
    } | undefined,
    stopReason?: StopReason,
  ): Promise<void> {
    if (!this.checkpointManager || !runtimeState) return;

    await this.enqueueCheckpointPersist(async () => {
      try {
        const failedToolCalls = [...runtimeState.failedToolCallSignatures.entries()]
          .filter(([, count]) => count > 0)
          .map(([signature, count]) => `${signature} (x${count})`);

        const checkpointSave: TaskCheckpointUpdate = {
          status,
          userGoal,
          taskState: runtimeState.taskState.snapshot(),
          repoContext: runtimeState.repoContext.snapshot(),
          loopState: this.loopController.getState(),
          messages,
          failedToolCalls,
          stopReason,
        };
        await this.checkpointManager!.save(checkpointSave);
      } catch (err) {
        console.debug('[harness] checkpoint save failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  private recordTelemetrySummary(
    stopReason: StopReason,
    runtimeState: {
      taskState: TaskState;
      repoContext: RepoContext;
    },
  ): void {
    const loopState = this.loopController.getState();
    const task = runtimeState.taskState.snapshot();
    this.runtimeTelemetry?.recordSummary({
      stopReason,
      task,
      repo: runtimeState.repoContext.snapshot(),
      rounds: loopState.currentRound,
      toolCalls: loopState.totalToolCalls,
      verificationRate: task.verificationStatus === 'passed' ? 1 : 0,
      noToolFinal: loopState.totalToolCalls === 0,
      tokensPerSuccessfulTask: stopReason === 'model_done'
        ? loopState.totalInputTokens + loopState.totalOutputTokens
        : undefined,
    });
  }

  /**
   * 处理循环停止：请求 LLM 给出最终总结。
   */
  private async handleStop(
    reason: StopReason,
    messages: UnifiedMessage[],
    chatFn: ChatFunction,
    _tools: ToolDefinition[],
    logger: HarnessLogger,
    onStep?: (event: HarnessStepEvent) => void,
    streamFn?: StreamFunction,
    runtimeState?: {
      taskState: TaskState;
      repoContext: RepoContext;
      failedToolCallSignatures: Map<string, number>;
      branchBudget?: BranchBudgetTracker;
    },
  ): Promise<HarnessResult> {
    this.loopController.stop(reason);
    const state = this.loopController.getState();
    logger.loopStop(reason, state.currentRound, state.totalToolCalls);
    // currentPlanTracker.onFinal removed (Phase 11)
    await this.saveTaskCheckpoint(
      reason === 'user_abort' ? 'aborted' : reason === 'error' ? 'failed' : 'paused',
      getLatestRealUserText(messages, '') || '',
      messages,
      runtimeState,
      reason,
    );
    await this.resilienceSaveCheckpoint('final_draft', runtimeState, reason);
    if (runtimeState) this.recordTelemetrySummary(reason, runtimeState);

    // 如果是用户中断，直接返回
    if (reason === 'user_abort') {
      onStep?.({ type: 'final', stopReason: reason, totalToolCalls: state.totalToolCalls });
      return {
        content: '',
        loopState: state,
        messages: [...messages],
        log: logger.getEntries(),
      };
    }

    if (reason === 'token_budget') {
      const finalContent = [
        '任务因 token 预算耗尽而暂停，尚未确认完成。',
        `已执行 ${state.currentRound} 轮、${state.totalToolCalls} 次工具调用。`,
        '请拆分任务或发起新会话后重试。',
      ].join('\n');

      onStep?.({
        type: 'final',
        totalToolCalls: state.totalToolCalls,
        content: finalContent,
        stopReason: reason,
      });

      return {
        content: finalContent,
        loopState: state,
        messages: [...messages],
        log: logger.getEntries(),
      };
    }

    // 其他原因：请求 LLM 总结
    logger.llmCall();
    messages.push({
      role: 'user',
      content: 'Please provide a final summary answer based on the tool call results above.',
    });

    let finalContent = '';
    try {
      // 优先使用流式调用，让前端实时看到总结内容
      if (streamFn) {
        const finalResponse = await streamFn(messages, (chunk, done) => {
          if (!done && chunk) {
            onStep?.({ type: 'stream_delta', iteration: state.currentRound, delta: chunk });
          }
        }, { tools: [] });
        finalContent = finalResponse.content;
        const sumLog = buildLlmRoundLogFields(messages, finalResponse.usage);
        logger.llmResponseFinal(sumLog.usage, sumLog.meta);
      } else {
        const finalResponse = await chatFn(messages, { tools: [] });
        finalContent = finalResponse.content;
        const sumLog = buildLlmRoundLogFields(messages, finalResponse.usage);
        logger.llmResponseFinal(sumLog.usage, sumLog.meta);
      }
    } catch (err) {
      // 最终总结调用失败，用最后一条 assistant 消息作为回复
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
      finalContent = typeof lastAssistant?.content === 'string'
        ? lastAssistant.content
        : `任务因 ${reason} 停止，最终总结生成失败。`;
      logger.error(`最终总结 LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    onStep?.({
      type: 'final',
      totalToolCalls: state.totalToolCalls,
      content: finalContent,
      stopReason: reason,
    });

    return {
      content: finalContent,
      loopState: state,
      messages: [...messages],
      log: logger.getEntries(),
    };
  }

  /**
   * 如果需要，执行上下文压缩（参考 claude-code 的压缩策略）。
   *
   * 两条路径：
   * 1. 会话记忆可用 → compactWithSessionMemory（0 LLM 成本）
   * 2. 会话记忆不可用 → compact（1 次 LLM 调用）
   *
   * 压缩后统一恢复：
   * - 重新注入最近读过的文件内容
   * - 保留最近注入的记忆消息
   * - 注入恢复指引
   */
  private async maybeCompact(
    messages: UnifiedMessage[],
    chatFn: ChatFunction,
    logger: HarnessLogger,
    onStep?: (event: HarnessStepEvent) => void,
    state?: LoopState,
  ): Promise<void> {
    // ── 第一道防线：轻量微压缩（约 72% 阈值，纯本地，零 LLM 成本）──
    if (this.contextCompactor.needsMicroCompaction(messages) && !this.contextCompactor.needsCompaction(messages)) {
      const before = messages.length;
      const beforeTok = this.contextCompactor.getEstimatedTokens(messages);
      const compacted = this.contextCompactor.doLightCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
      const afterTok = this.contextCompactor.getEstimatedTokens(messages);
      console.log(`[harness] 微压缩: ${before} → ${messages.length} 条消息 (纯本地，零 LLM 成本)`);
      logger.compaction(before, messages.length, beforeTok, afterTok);
      onStep?.({ type: 'compaction', content: `micro: ${before} → ${messages.length}` });
      return; // 微压缩不注入恢复提示，对 LLM 透明
    }

    // ── 第二道防线：硬压缩 ──
    if (!this.contextCompactor.needsCompaction(messages)) return;

    const before = messages.length;
    const beforeTokens = this.contextCompactor.getEstimatedTokens(messages);

    // 压缩前备份任务目标到会话笔记：等待完成后再读盘，避免与硬压缩读到旧笔记竞态（带超时降级）
    const taskDesc = this.contextCompactor.getTaskDescription(messages);
    if (taskDesc) {
      const waitMs = PRE_COMPACT_SESSION_MEMORY_WAIT_MS;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(PRE_COMPACT_SESSION_TIMEOUT_MSG)), waitMs);
      });
      try {
        await Promise.race([
          this.memoryIntegration.maybeUpdateSessionMemory(
            messages,
            0,
            true,
            state
              ? { task: state.taskState.snapshot(), repo: state.repoContext.snapshot() }
              : undefined,
          ),
          timeoutPromise,
        ]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === PRE_COMPACT_SESSION_TIMEOUT_MSG) {
          console.log(
            `[harness] 压缩前会话笔记更新超时（>${waitMs}ms），使用磁盘上现有内容继续压缩`,
          );
        } else {
          console.debug('[harness] 压缩前等待会话笔记更新失败:', msg);
        }
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }

    // 压缩前获取会话笔记
    const sessionNotes = await this.memoryIntegration.getSessionMemoryForCompact();

    // 压缩前保存最近注入的记忆消息
    const recentMemoryMessages: UnifiedMessage[] = [];
    for (let i = messages.length - 1; i >= 0 && recentMemoryMessages.length < 3; i--) {
      const rawContent = messages[i].content;
      const content: string = typeof rawContent === 'string' ? rawContent : '';
      if (content.startsWith('<system-reminder>') && content.includes('Recalled Memories')) {
        recentMemoryMessages.unshift(messages[i]);
        break;
      }
    }

    // 压缩前提取最近文件内容（压缩后会丢失）
    const recentFileContents = this.contextCompactor.extractRecentFileContents(messages);
    const runtimeRecoveryContext = state
      ? this.contextCompactor.buildRuntimeRecoveryContext(
        state.taskState.snapshot(),
        state.repoContext.snapshot(),
      )
      : null;

    // ── 压缩 ──
    if (sessionNotes) {
      const compacted = this.contextCompactor.compactWithSessionMemory(messages, sessionNotes);
      messages.length = 0;
      messages.push(...compacted);
    } else {
      const compacted = await this.contextCompactor.compact(messages, chatFn);
      messages.length = 0;
      messages.push(...compacted);
    }

    // ── 压缩后统一恢复 ──

    // 1. 重新注入最近记忆消息（如果被压缩掉了）
    if (recentMemoryMessages.length > 0) {
      const hasMemoryInCompacted = messages.some(m => {
        const c = typeof m.content === 'string' ? m.content : '';
        return c.startsWith('<system-reminder>') && c.includes('Recalled Memories');
      });
      if (!hasMemoryInCompacted) {
        messages.splice(
          messages.length - Math.min(this.contextCompactor.getConfig().keepRecent, messages.length),
          0,
          ...recentMemoryMessages,
        );
      }
    }

    // 2. 重新注入 Runtime State + Repo Context（压缩恢复优先上下文）
    if (runtimeRecoveryContext) {
      messages.push(runtimeRecoveryContext);
    }

    // 3. 重新注入最近文件内容
    if (recentFileContents.length > 0) {
      messages.push(...recentFileContents);
    }

    // 4. 注入恢复指引（使用新的多重恢复提示）
    const recentUserMsgs: string[] = [];
    for (let i = messages.length - 1; i >= 0 && recentUserMsgs.length < 3; i--) {
      const msg = messages[i];
      if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.length > 50) {
        recentUserMsgs.unshift(msg.content);
      }
    }
    messages.push(this.contextCompactor.buildRecoveryPrompt(recentUserMsgs, !!sessionNotes));

    // 5. 设置压缩标记（用于后续失忆检测）
    if (state) {
      state.justCompacted = true;
      state.amnesiaRecoveryCount = 0;
    }

    const afterTokCompact = this.contextCompactor.getEstimatedTokens(messages);
    logger.compaction(before, messages.length, beforeTokens, afterTokCompact);
    this.runtimeTelemetry?.recordCompaction({
      beforeMessages: before,
      afterMessages: messages.length,
      beforeTokens,
      afterTokens: afterTokCompact,
    });
    onStep?.({ type: 'compaction', content: `${before} → ${messages.length}` });
    await this.resilienceSaveCheckpoint('compaction', state);
  }

  /**
   * 获取循环状态。
   */
  getLoopState() {
    return this.loopController.getState();
  }

  // getExecutionPlan removed (Phase 11 — execution plan layer deleted)

  /**
   * 获取停止钩子管理器（用于注册自定义钩子）。
   */
  getStopHookManager(): StopHookManager {
    return this.stopHookManager;
  }

  /**
   * 获取并清空记忆提取的被动确认通知。
   * 调用方在返回最终回复时附加这些通知给用户。
   */
  flushExtractionNotices(): string[] {
    return this.memoryIntegration.flushExtractionNotices();
  }

  /**
   * 判断工具调用是否具有破坏性。
   *
   * `fs_operation` / `run_command` 在运行时解析参数；其余工具使用元数据 `isDestructive`。
   */
  private isDestructiveToolCall(tc: ToolCall): boolean {
    if (tc.name === 'fs_operation') {
      const op = (tc.arguments as Record<string, any>)?.operation as string | undefined;
      return op ? isDestructiveOperation(op) : false;
    }
    if (tc.name === 'run_command') {
      const cmd = (tc.arguments as Record<string, any>)?.command as string | undefined;
      return cmd ? isDestructiveCommand(cmd) : false;
    }
    return getToolMetadata(tc.name).isDestructive;
  }

  /**
   * 配置的 pattern 命中则直接采用规则权限；否则破坏性工具默认为 `confirm`。
   */
  private resolveToolPermission(tc: ToolCall): { permission: 'allow' | 'confirm' | 'deny'; reason?: string } {
    for (const rule of this.permissionRules) {
      if (this.matchesPermissionPattern(rule.pattern, tc.name)) {
        return { permission: rule.permission, reason: rule.reason };
      }
    }

    return {
      permission: this.isDestructiveToolCall(tc) ? 'confirm' : 'allow',
      reason: this.isDestructiveToolCall(tc) ? 'Destructive operation requires confirmation' : undefined,
    };
  }

  /** Glob 风格：`*`、精确工具名或 `*` 展开的 `^escaped$` 正则。 */
  private matchesPermissionPattern(pattern: string, toolName: string): boolean {
    if (pattern === '*' || pattern === toolName) return true;
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(toolName);
  }

  /** 连续失败统计用的稳定键（工具名 + 序列化参数）。 */
  private toolCallSignature(tc: ToolCall): string {
    return `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`;
  }

  /**
   * 累加失败签名计数，返回本轮起已连续失败 ≥2 次的签名（供熔断/强提示）。
   */
  private collectRepeatedFailures(
    _toolCalls: ToolCall[],
    failedSignatures: string[],
    counts: Map<string, number>,
  ): string[] {
    const repeated: string[] = [];
    for (const sig of failedSignatures) {
      const next = (counts.get(sig) ?? 0) + 1;
      counts.set(sig, next);
      if (next >= 2) repeated.push(sig);
    }
    return repeated;
  }

  /**
   * 格式化确认时的工具名称，附加具体的操作信息。
   * 例如：`fs_operation (delete)`、`run_command (rm -rf node_modules)`。
   */
  private formatConfirmToolName(tc: ToolCall): string {
    if (tc.name === 'fs_operation') {
      const op = (tc.arguments as Record<string, any>)?.operation as string | undefined;
      return op ? `fs_operation (${op})` : tc.name;
    }
    if (tc.name === 'run_command') {
      const cmd = (tc.arguments as Record<string, any>)?.command as string | undefined;
      if (cmd) {
        const short = cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
        return `run_command (${short})`;
      }
    }
    return tc.name;
  }

  /**
   * 等待后台记忆任务完成并释放资源，供进程退出前调用。
   *
   * @param timeoutMs - 最大等待毫秒数（默认 10s）
   */
  async drainMemory(timeoutMs: number = 10_000): Promise<void> {
    await this.memoryIntegration.drain(timeoutMs);
    this.memoryIntegration.dispose();
  }

  // ─── Resilience v2 集成（无 sessionDir 时 checkpointEngine 为 undefined，持久化相关为 no-op） ───

  /**
   * 记录一轮工具调用到 branchBudget 和 checkpointEngine。
   * 关 flag 时 no-op。
   *
   * 磁盘写入必须经 enqueueCheckpointPersist，与 TaskCheckpointManager 串行，避免绕过队列与 v1 save 交叉 rename。
   */
  private async resilienceRecordToolCalls(
    toolCalls: ToolCall[],
    failedSignatures: Set<string>,
    state: LoopState,
  ): Promise<void> {
    if (!this.resilienceV2Enabled || !state.branchBudget || !this.checkpointEngine) return;

    const engine = this.checkpointEngine;

    for (const tc of toolCalls) {
      const sig = this.toolCallSignature(tc);
      const failed = failedSignatures.has(sig);

      const path = typeof tc.arguments?.path === 'string'
        ? tc.arguments.path
        : (typeof tc.arguments?.file_path === 'string' ? tc.arguments.file_path : undefined);
      if (path && /^(edit_file|write_file|append_file|batch_edit_file|patch_file)$/.test(tc.name)) {
        state.branchBudget.recordFileEdit(path);
      }

      if (tc.name === 'run_command' && failed) {
        const cmd = typeof tc.arguments?.command === 'string' ? tc.arguments.command : '';
        if (cmd) state.branchBudget.recordFailedCommandAttempt(cmd);
      }

      if (failed) {
        state.branchBudget.recordError(sig);
        await this.enqueueCheckpointPersist(async () => {
          try {
            await engine.save({
              trigger: 'tool_failed',
              branchBudget: state.branchBudget,
              appendFailure: {
                signature: sig,
                count: 1,
                at: Date.now(),
              },
            });
          } catch (err) {
            console.debug(
              '[harness] resilience v2 save (tool_failed) failed:',
              err instanceof Error ? err.message : err,
            );
          }
        });
      }

      await this.enqueueCheckpointPersist(async () => {
        try {
          await engine.save({
            trigger: failed ? 'tool_failed' : 'step_completed',
            branchBudget: state.branchBudget,
            appendTool: {
              toolName: tc.name,
              success: !failed,
              signature: sig,
              at: Date.now(),
            },
          });
        } catch (err) {
          console.debug(
            '[harness] resilience v2 save (tool) failed:',
            err instanceof Error ? err.message : err,
          );
        }
      });
    }
  }

  /**
   * 检查分支预算是否触发，需要则注入 recovery warning 到对话。
   * 每轮最多注入 1 次，避免与已有的 consecutiveToolFailures 提示叠加。
   */
  private resilienceMaybeBranchRecover(state: LoopState, msgs: UnifiedMessage[]): void {
    if (!this.resilienceV2Enabled || !state.branchBudget || !this.checkpointEngine) return;
    if (state.branchBudgetWarnedThisRound) return;

    const decision = state.branchBudget.shouldBranchRecover();
    if (!decision.triggered) return;

    const signal = state.branchBudget.buildRecoverySignal(decision);
    if (!signal) return;

    msgs.push({ role: 'user', content: signal.message });
    state.branchBudget.markRecoveryTriggered();
    state.branchBudgetWarnedThisRound = true;

    const engine = this.checkpointEngine;
    void this.enqueueCheckpointPersist(async () => {
      try {
        await engine.save({
          trigger: 'tool_failed',
          branchBudget: state.branchBudget,
          appendRecoverySignal: signal,
        });
      } catch (err) {
        console.debug(
          '[harness] resilience v2 save (recovery signal) failed:',
          err instanceof Error ? err.message : err,
        );
      }
    });
  }

  /**
   * 在工具失败 / 验证失败时做一次 step review。
   * 每轮最多 1 次；启发式给出明确结论时不触发 LLM。
   */
  private async resilienceMaybeReviewStep(
    state: LoopState,
    trigger: 'tool_failure' | 'verification_failure' | 'step_transition',
    chatFn: ChatFunction,
  ): Promise<void> {
    if (!this.resilienceV2Enabled) return;
    if (state.stepReviewedThisRound) return;
    state.stepReviewedThisRound = true;

    try {
      const recentTools = collectRecentToolTraces(state.messages, 5);
      const lastErrors = collectRecentErrors(state.messages, 3);
      // planActive/activeStep removed (Phase 11 — currentPlanTracker deleted)

      const result = await reviewStep({
        goal: state.taskState.snapshot().goal,
        currentStep: undefined, // activeStep removed (Phase 11)
        recentTools,
        lastErrors,
        trigger,
        taskSnapshot: state.taskState.snapshot(),
        previousReview: state.lastStepReview,
      }, chatFn);

      state.lastStepReview = result;

      // 仅当 step-review 给出"重复 + 建议 fallback"且 branchBudget 这轮没触发时，
      // 才发出一条独立、温和的提示；否则交给现有 consecutiveToolFailures / branchBudget 流程。
      if (
        result.repeatedPattern
        && result.fallbackSuggested
        && !state.branchBudgetWarnedThisRound
      ) {
        state.messages.push({
          role: 'user',
          content: `[Runtime Self-Review] ${result.reason} 请切换策略或拆解为更小子任务，不要原样重试。`,
        });
        state.branchBudgetWarnedThisRound = true;
      }
    } catch (err) {
      console.debug(
        '[harness] resilience v2 step-review failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * v2 checkpoint 合并保存。在以下 hook 点调用：
   *   step_completed / tool_failed / verification_started / verification_failed
   *   compaction / final_draft
   */
  private async resilienceSaveCheckpoint(
    trigger: CheckpointSaveTrigger,
    state: { taskState: TaskState; branchBudget?: BranchBudgetTracker } | undefined,
    stopReason?: StopReason,
  ): Promise<void> {
    if (!this.resilienceV2Enabled || !this.checkpointEngine) return;
    if (!state) return;

    const engine = this.checkpointEngine;

    await this.enqueueCheckpointPersist(async () => {
      try {
        await engine.save({
          trigger,
          branchBudget: state.branchBudget,
          verificationPending: state.taskState.shouldBlockFinalForVerification(),
          lastStopReason: stopReason,
        });
      } catch (err) {
        console.debug(
          `[harness] resilience v2 save (${trigger}) failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
  }
}

// ─── Resilience v2 内部辅助：从消息历史抽取 step-review 所需的最小上下文 ───

/**
 * 自尾部向前收集最近 `max` 条 tool 结果，并反向匹配对应 assistant `toolCalls` 得到名称与签名。
 */
function collectRecentToolTraces(
  messages: UnifiedMessage[],
  max: number,
): Array<{ toolName: string; signature: string; success: boolean; error?: string }> {
  const traces: Array<{ toolName: string; signature: string; success: boolean; error?: string }> = [];
  // 倒序遍历，找最近 N 条 tool result
  for (let i = messages.length - 1; i >= 0 && traces.length < max; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    const content = msg.content;
    const failed = content.includes('Tool execution error:') || content.includes('工具执行错误');
    const errorMatch = content.match(/(?:Tool execution error|工具执行错误)[:：]\s*([^\n]{1,200})/);
    // 反向查找最近的 assistant tool_calls 以拿到 toolName 与 args
    let toolName = 'unknown';
    let signature = '';
    for (let j = i - 1; j >= 0; j--) {
      const m = messages[j];
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
      const matchTC = m.toolCalls.find(tc => tc.id === msg.toolCallId);
      if (matchTC) {
        toolName = matchTC.name;
        signature = `${matchTC.name}:${JSON.stringify(matchTC.arguments ?? {})}`;
      }
      break;
    }
    traces.unshift({
      toolName,
      signature: signature || toolName,
      success: !failed,
      error: failed ? (errorMatch?.[1] ?? content.slice(0, 200)) : undefined,
    });
  }
  return traces;
}

/** 收集最近若干条 tool 错误摘要（中英错误前缀）。 */
function collectRecentErrors(messages: UnifiedMessage[], max: number): string[] {
  const errors: string[] = [];
  for (let i = messages.length - 1; i >= 0 && errors.length < max; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    const content = msg.content;
    if (content.includes('Tool execution error:') || content.includes('工具执行错误')) {
      errors.unshift(content.slice(0, 240));
    }
  }
  return errors;
}