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
import { estimateStringTokens } from '../llm/token-estimator.js';
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
import { ContextCompactor } from './context-compactor.js';
import { HarnessLogger } from './logger.js';
import { StopHookManager } from './stop-hooks.js';
import { TokenBudgetTracker } from './token-budget.js';
import { StreamingToolExecutor } from './streaming-tool-executor.js';
import { getToolMetadata, isDestructiveOperation, isDestructiveCommand } from '../tools/tool-metadata.js';
import { HarnessMemoryIntegration } from './harness-memory.js';
import { TaskState } from './task-state.js';
import { RepoContext } from './repo-context.js';
import { TaskCheckpointManager, type TaskCheckpointStatus } from './checkpoint.js';
import { buildToolPlan, formatToolPlan } from './tool-planner.js';
import { RuntimeTelemetry } from './runtime-telemetry.js';

// ─── 工具输出截断上限 ───
const MAX_TOOL_OUTPUT = 30000;

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

// ─── 工具结果预算裁剪 ───
const TOOL_RESULT_KEEP_RECENT = 6;
const TOOL_RESULT_BUDGET_PER_MESSAGE = 3000;

// ─── 任务切换检测 ───
const TASK_SWITCH_JACCARD_THRESHOLD = 0.15;

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

function isSystemInjectedUserContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('<system-context>')
    || trimmed.startsWith('<system-reminder>')
    || trimmed.startsWith('<session-notes>')
    || trimmed.startsWith('<context-summary>')
    || trimmed.startsWith('[System Runtime State]')
    || trimmed.startsWith('[System')
    || trimmed.startsWith('Please provide a final summary answer based on the tool call results above.')
    || trimmed.startsWith('Continue directly');
}

function getLatestRealUserText(messages: UnifiedMessage[], fallback = ''): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (isSystemInjectedUserContent(msg.content)) continue;
    return msg.content;
  }
  return fallback;
}

function hasAssistantToolCallAttempt(messages: UnifiedMessage[]): boolean {
  return messages.some(m => m.role === 'assistant' && !!m.toolCalls?.length);
}

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

function isActionableToolRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;

  const isActionable = /修(复|好|改)|修改|改一下|解决|处理|排查|看看为什么|优化|重构|实现|落地|执行|运行|测试|检查|读取|搜索|创建|新增|删除|提交|创建.*pr/i.test(t)
    || /\b(fix|debug|investigate|implement|modify|edit|update|refactor|search|read|create|delete|commit|check)\b/i.test(t)
    || /\b(run|execute)\s+\S+/i.test(t)
    || /\b(test|verify)\s+\S+|\S+\s+(tests?|verification)\b/i.test(t);
  if (!isActionable) return false;

  const questionOnly = /^(为什么|如何|怎么|解释|说明|what|why|how)\b/i.test(t)
    && !/(修|改|解决|处理|运行|测试|fix|modify|run|test|implement)/i.test(t);
  return !questionOnly;
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
}

/**
 * Harness 是 Agent 循环的核心引擎。
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
  private runtimeTelemetry?: RuntimeTelemetry;

  constructor(
    config: HarnessConfig,
    toolExecutor: ToolExecutor,
  ) {
    this.contextAssembler = new ContextAssembler(config.context);
    this.loopController = new LoopController(config.loop);
    this.contextCompactor = new ContextCompactor({
      threshold: config.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
      tokenThreshold: config.compactionTokenThreshold,
      keepRecent: config.compactionKeepRecent ?? DEFAULT_COMPACTION_KEEP_RECENT,
      enableLLMSummary: config.compactionEnableLLMSummary,
    });
    this.toolExecutor = toolExecutor;
    this.stopHookManager = new StopHookManager();
    this.permissionRules = config.permissions ?? [];
    this.onConfirm = config.onConfirm;
    this.abortSignal = config.loop.signal;
    this.checkpointManager = config.sessionDir
      ? new TaskCheckpointManager(config.sessionDir, config.sessionId)
      : undefined;
    this.runtimeTelemetry = new RuntimeTelemetry(config.sessionDir, config.sessionId);

    // 记忆集成层
    this.memoryIntegration = new HarnessMemoryIntegration({
      memoryDir: config.memoryDir,
      fileMemoryManager: config.fileMemoryManager,
    });

    // 如果配置了 token 预算，创建追踪器
    if (config.loop.tokenBudget) {
      this.tokenBudgetTracker = new TokenBudgetTracker({
        totalBudget: config.loop.tokenBudget,
      });
    }
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
    };

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

      // 消息规范化：合并连续 user 消息、去重 tool_use ID、清理空消息
      // 工具结果预算裁剪在副本上执行，不修改原始消息（保持前缀缓存一致性）
      const normalizedMsgs = normalizeMessages(msgs);
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
          }
        }
      }

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
        logger.llmResponseFinal(tokenUsage);

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
          state.transition = 'stop_hook_continue';
          continue;
        }

        // 模型正常完成，重置 stop hook 计数
        state.stopHookContinuationCount = 0;

        // ── 5d. 正常完成 → return ──
        this.loopController.stop('model_done');
        const finalState = this.loopController.getState();
        logger.loopStop('model_done', finalState.currentRound, finalState.totalToolCalls);
        await this.saveTaskCheckpoint('completed', userMessage, msgs, state, 'model_done');
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
      logger.llmResponseToolCalls(response.toolCalls!.length, tokenUsage);

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
      const toolStats = await this.executeToolCallsStreaming(
        response.toolCalls!, msgs, logger, onStep, this.abortSignal, state.taskState, state.repoContext,
      );

      const repeatedFailures = this.collectRepeatedFailures(response.toolCalls!, toolStats.failedSignatures, state.failedToolCallSignatures);
      if (repeatedFailures.length > 0) {
        msgs.push({
          role: 'user',
          content: `[System] Repeated failed tool call detected: ${repeatedFailures.join(', ')}. Do not retry the same tool with the same arguments. Change the path, parameters, command, or use a different tool; if blocked, explain the exact blocker and evidence.`,
        });
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

      await this.saveTaskCheckpoint('running', userMessage, msgs, state);

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
      await this.memoryIntegration.injectMemoryContext(msgs);

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
      // 记忆合并：fire-and-forget，不阻塞主循环返回
      // 提取/Dream/会话记忆更新在后台异步完成，
      // 进程退出时由 drainExtractions 确保完成。
      this.memoryIntegration.onLoopEnd(
        state.messages,
        state.turnCount,
        this.loopController.getState().totalInputTokens,
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

  // ─── 记忆集成由 HarnessMemoryIntegration 处理 ───

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

    // 第一遍：权限检查 + 提交到流式执行器
    const submittedIds = new Set<string>();
    for (const tc of toolCalls) {
      // 检查用户中断
      if (this.loopController.isAborted()) {
        this.yieldMissingToolResults(toolCalls, submittedIds, messages);
        break;
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
      streamingExecutor.submit(tc);
      submittedIds.add(tc.id);
    }

    // 第二遍：等待所有已提交的工具完成，收集结果
    const results = await streamingExecutor.flush();
    const processedIds = new Set<string>();
    let failedCount = 0;
    const failedSignatures: string[] = [];

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
      const maxOutput = toolMeta.maxResultSizeChars === Infinity ? MAX_TOOL_OUTPUT : Math.min(toolMeta.maxResultSizeChars, MAX_TOOL_OUTPUT);
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

      processedIds.add(tc.id);
      this.loopController.recordToolCalls(1);
    }

    // 如果中断发生，为未处理的工具补齐 tool_result
    if (this.loopController.isAborted()) {
      this.yieldMissingToolResults(toolCalls, processedIds, messages);
    }

    return { failedCount, totalCount: results.length, failedSignatures };
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

    try {
      const failedToolCalls = [...runtimeState.failedToolCallSignatures.entries()]
        .filter(([, count]) => count > 0)
        .map(([signature, count]) => `${signature} (x${count})`);

      await this.checkpointManager.save({
        status,
        userGoal,
        taskState: runtimeState.taskState.snapshot(),
        repoContext: runtimeState.repoContext.snapshot(),
        loopState: this.loopController.getState(),
        messages,
        failedToolCalls,
        stopReason,
      });
    } catch (err) {
      console.debug('[harness] checkpoint save failed:', err instanceof Error ? err.message : err);
    }
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
    },
  ): Promise<HarnessResult> {
    this.loopController.stop(reason);
    const state = this.loopController.getState();
    logger.loopStop(reason, state.currentRound, state.totalToolCalls);
    await this.saveTaskCheckpoint(
      reason === 'user_abort' ? 'aborted' : reason === 'error' ? 'failed' : 'paused',
      getLatestRealUserText(messages, '') || '',
      messages,
      runtimeState,
      reason,
    );
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
        '请继续发送“继续”或提高/关闭 ICE_HARNESS_TOKEN_BUDGET 后重试。',
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
        logger.llmResponseFinal({
          input: finalResponse.usage?.inputTokens ?? 0,
          output: finalResponse.usage?.outputTokens ?? 0,
        });
      } else {
        const finalResponse = await chatFn(messages, { tools: [] });
        finalContent = finalResponse.content;
        logger.llmResponseFinal({
          input: finalResponse.usage?.inputTokens ?? 0,
          output: finalResponse.usage?.outputTokens ?? 0,
        });
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
    // ── 第一道防线：轻量微压缩（65% 阈值，纯本地，零 LLM 成本）──
    if (this.contextCompactor.needsMicroCompaction(messages) && !this.contextCompactor.needsCompaction(messages)) {
      const before = messages.length;
      const compacted = this.contextCompactor.doLightCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
      console.log(`[harness] 微压缩: ${before} → ${messages.length} 条消息 (纯本地，零 LLM 成本)`);
      logger.compaction(before, messages.length);
      onStep?.({ type: 'compaction', content: `micro: ${before} → ${messages.length}` });
      return; // 微压缩不注入恢复提示，对 LLM 透明
    }

    // ── 第二道防线：硬压缩 ──
    if (!this.contextCompactor.needsCompaction(messages)) return;

    const before = messages.length;
    const beforeTokens = this.contextCompactor.getEstimatedTokens(messages);

    // 压缩前备份任务目标到会话笔记（异步，不阻塞压缩）
    const taskDesc = this.contextCompactor.getTaskDescription(messages);
    if (taskDesc) {
      this.memoryIntegration.maybeUpdateSessionMemory(
        messages,
        0, // force update regardless of token count
        true,
      ).catch(err => {
        console.debug('[harness] task backup before compaction failed:', err instanceof Error ? err.message : err);
      });
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

    logger.compaction(before, messages.length);
    this.runtimeTelemetry?.recordCompaction({
      beforeMessages: before,
      afterMessages: messages.length,
      beforeTokens,
      afterTokens: this.contextCompactor.getEstimatedTokens(messages),
    });
    onStep?.({ type: 'compaction', content: `${before} → ${messages.length}` });
  }

  /**
   * 获取循环状态。
   */
  getLoopState() {
    return this.loopController.getState();
  }

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
   * 等待后台记忆任务完成并清理资源。
   *
   * 在进程退出前调用，确保：
   * - 进行中的 LLM 提取完成（不丢失记忆）
   * - 进行中的 Dream 整合完成（不损坏记忆文件）
   * - 会话记忆更新完成
   *
   * @param timeoutMs - 最大等待时间（默认 10 秒）
   */
  /**
   * 判断工具调用是否需要用户确认。
   * 对于 fs_operation 和 run_command，运行时分析具体参数来决定破坏性。
   * 其他工具由元数据的 isDestructive 字段决定。
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

  private matchesPermissionPattern(pattern: string, toolName: string): boolean {
    if (pattern === '*' || pattern === toolName) return true;
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(toolName);
  }

  private toolCallSignature(tc: ToolCall): string {
    return `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`;
  }

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

  async drainMemory(timeoutMs: number = 10_000): Promise<void> {
    await this.memoryIntegration.drain(timeoutMs);
    this.memoryIntegration.dispose();
  }
}