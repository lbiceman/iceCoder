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
} from './types.js';
import { ContextAssembler, normalizeMessages } from './context-assembler.js';
import { LoopController } from './loop-controller.js';
import { ContextCompactor } from './context-compactor.js';
import { HarnessLogger } from './logger.js';
import { StopHookManager } from './stop-hooks.js';
import { TokenBudgetTracker } from './token-budget.js';
import { StreamingToolExecutor } from './streaming-tool-executor.js';
import { getToolMetadata } from '../tools/tool-metadata.js';
import { HarnessMemoryIntegration } from './harness-memory.js';

// ─── 工具输出截断上限 ───
const MAX_TOOL_OUTPUT = 30000;

// ─── max-output-tokens 恢复最大次数 ───
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

// ─── LLM 调用重试配置 ───
const LLM_MAX_RETRIES = 3;
const LLM_RETRY_BASE_DELAY = 1000;
const LLM_RETRY_MAX_DELAY = 15000;

// ─── 工具结果预算裁剪 ───
const TOOL_RESULT_KEEP_RECENT = 6;
const TOOL_RESULT_BUDGET_PER_MESSAGE = 3000;

// ─── 默认压缩配置 ───
const DEFAULT_COMPACTION_THRESHOLD = 40;
const DEFAULT_COMPACTION_KEEP_RECENT = 10;

// ─── 任务状态标记解析 ───
type TaskStatus = 'complete' | 'incomplete' | 'unknown';

/** 从模型回复中提取 <status>complete|incomplete</status> 标记 */
function parseTaskStatus(content: string | undefined): TaskStatus {
  if (!content) return 'unknown';
  const match = content.match(/<status>\s*(complete|incomplete)\s*<\/status>/i);
  if (!match) return 'unknown';
  return match[1].toLowerCase() as TaskStatus;
}

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
  | 'max_output_tokens_recovery'
  | 'stop_hook_continue'
  | 'status_incomplete_continue'
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
  /** 上一次 continue 的原因 */
  transition: Transition;
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
  private onConfirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  /** 记忆集成层（解耦的记忆系统交互） */
  private memoryIntegration: HarnessMemoryIntegration;

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
    this.onConfirm = config.onConfirm;

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
      transition: 'initial',
    };

    // ── 核心循环（while(true) 迭代模式）──
    // try/finally 确保无论哪条路径退出，记忆合并都会执行一次
    try {
    while (true) {
      // 1. 解构当前状态
      const { messages: msgs, tools: currentTools } = state;

      // 2. 消息预处理管线（上下文压缩，不修改已有消息内容）
      await this.maybeCompact(msgs, chatFn, logger, onStep);

      // 3. 推进轮次，检查循环控制
      this.loopController.advanceRound();
      state.turnCount++;
      const round = this.loopController.getState().currentRound;
      logger.roundStart(round, msgs.length);

      const loopStop = this.loopController.shouldContinue();
      if (loopStop) {
        return this.handleStop(loopStop, msgs, chatFn, currentTools, logger, onStep);
      }

      // 4. 调用 LLM（带错误恢复）
      logger.llmCall();

      // 消息规范化：合并连续 user 消息、去重 tool_use ID、清理空消息
      // 工具结果预算裁剪在副本上执行，不修改原始消息（保持前缀缓存一致性）
      const normalizedMsgs = normalizeMessages(msgs);
      this.applyToolResultBudget(normalizedMsgs);

      // 检查用户中断
      if (this.loopController.isAborted()) {
        return this.handleStop('user_abort', msgs, chatFn, currentTools, logger, onStep);
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
            return this.handleStop('user_abort', msgs, chatFn, currentTools, logger, onStep);
          }
        } else {
          response = await chatFn(normalizedMsgs, { tools: currentTools });
        }
        state.llmRetryCount = 0; // 成功后重置重试计数
      } catch (error) {
        // ── LLM 调用错误恢复 ──
        if (isRetryableError(error) && state.llmRetryCount < LLM_MAX_RETRIES) {
          state.llmRetryCount++;
          const delay = Math.min(
            LLM_RETRY_BASE_DELAY * Math.pow(2, state.llmRetryCount - 1),
            LLM_RETRY_MAX_DELAY,
          );
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`LLM 调用失败 (${state.llmRetryCount}/${LLM_MAX_RETRIES}): ${errorMsg}，${delay}ms 后重试`);
          await new Promise(resolve => setTimeout(resolve, delay));
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

      // 记录 token 预算
      if (this.tokenBudgetTracker) {
        this.tokenBudgetTracker.recordUsage(tokenUsage.input, tokenUsage.output);
      }

      // 5. 处理响应：无工具调用 → 进入退出/恢复逻辑
      const hasToolCalls = response.finishReason === 'tool_calls'
        && response.toolCalls
        && response.toolCalls.length > 0;

      if (!hasToolCalls) {
        logger.llmResponseFinal(tokenUsage);

        // ── 5a. max-output-tokens 恢复 ──
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
            content: '直接继续 — 不要道歉，不要重述之前的内容。如果上次回复在中途被截断，从截断处继续。将剩余工作拆分为更小的步骤。',
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

        // ── 5b. 基于 <status> 标记的继续判断 ──
        // 模型在回复末尾声明任务状态：complete / incomplete / unknown
        const taskStatus = parseTaskStatus(response.content);

        if (taskStatus === 'incomplete') {
          // 模型明确说任务未完成 → 检查预算是否允许继续
          const budgetOk = !this.tokenBudgetTracker || this.tokenBudgetTracker.shouldContinue();
          if (budgetOk) {
            console.log(`[harness] 模型声明 incomplete，继续执行`);
            // 将模型的部分回复加入对话
            if (response.content) {
              msgs.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
            }
            msgs.push({
              role: 'user',
              content: '继续执行未完成的任务。不要重复已完成的内容。',
            });
            if (this.tokenBudgetTracker) {
              this.tokenBudgetTracker.recordContinuation();
            }
            state.transition = 'status_incomplete_continue';
            continue;
          }
          console.log(`[harness] 模型声明 incomplete 但预算不足，停止`);
        }

        // ── 5c. 停止钩子（兜底） ──
        // 仅在 status 标记缺失时作为回退
        if (taskStatus === 'unknown' && this.stopHookManager.count > 0) {
          const hookResult = await this.stopHookManager.execute(msgs, response.content);
          if (hookResult.shouldContinue && hookResult.message) {
            console.log(`[harness] 停止钩子 "${hookResult.hookName}" 要求继续`);
            msgs.push({ role: 'user', content: hookResult.message });
            state.transition = 'stop_hook_continue';
            continue;
          }
        }

        // ── 5d. 正常完成 → return ──
        this.loopController.stop('model_done');
        const finalState = this.loopController.getState();
        logger.loopStop('model_done', finalState.currentRound, finalState.totalToolCalls);

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

      // 6. 有工具调用 → 执行工具
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
      await this.executeToolCallsStreaming(response.toolCalls!, msgs, logger, onStep);

      // 6a-abort. 工具执行后立即检查中断
      if (this.loopController.isAborted()) {
        return this.handleStop('user_abort', msgs, chatFn, currentTools, logger, onStep);
      }

      // 6b. 注入记忆上下文（文件记忆 + 结构化记忆检索）
      // 放在所有 tool 结果之后、下一轮 LLM 调用之前
      await this.memoryIntegration.injectMemoryContext(msgs);

      // 6c. maxTurns 检查（由 loopController 处理）
      const nextStop = this.loopController.shouldContinue();
      if (nextStop) {
        return this.handleStop(nextStop, msgs, chatFn, currentTools, logger, onStep);
      }

      // 6d. 构造下一轮状态 → continue
      // 重置恢复计数（工具调用成功意味着模型在正常工作）
      state.maxOutputTokensRecoveryCount = 0;
      state.llmRetryCount = 0;
      state.transition = 'tool_calls';
      // messages 和 tools 已就地更新，直接 continue
    }
    } finally {
      // 统一记忆合并：无论哪条路径退出循环，都执行一次
      await this.memoryIntegration.onLoopEnd(
        state.messages,
        state.turnCount,
        this.loopController.getState().totalInputTokens,
      );
      this.memoryIntegration.dispose();
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

  /**
   * 使用 StreamingToolExecutor 执行工具调用。
   *
   * 并行安全的工具（isConcurrencySafe）并行执行，
   * 非并行安全的工具串行执行。
   * 每个工具执行前检查权限和用户中断。
   * 中断时为未完成的 tool_use 补齐错误 tool_result。
   */
  private async executeToolCallsStreaming(
    toolCalls: ToolCall[],
    messages: UnifiedMessage[],
    logger: HarnessLogger,
    onStep?: (event: HarnessStepEvent) => void,
  ): Promise<void> {
    const streamingExecutor = new StreamingToolExecutor(
      this.toolExecutor,
      // 实时工具输出回调：推送到 onStep
      onStep ? (toolCallId, toolName, chunk) => {
        onStep({
          type: 'tool_output',
          toolName,
          content: chunk,
        });
      } : undefined,
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

      // ── 权限检查：破坏性工具需要用户确认 ──
      const meta = getToolMetadata(tc.name);
      if (meta.isDestructive && this.onConfirm) {
        onStep?.({ type: 'tool_confirm', iteration, toolName: tc.name, toolArgs: tc.arguments });
        const allowed = await this.onConfirm(tc.name, tc.arguments);
        if (!allowed) {
          logger.toolResult(tc.name, false, 0, '用户拒绝执行');
          onStep?.({ type: 'tool_denied', iteration, toolName: tc.name });
          messages.push({
            role: 'tool',
            content: `用户拒绝执行工具 ${tc.name}。请换一种方式完成任务，或询问用户。`,
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

    for (const sr of results) {
      // 中断后跳过剩余结果处理
      if (this.loopController.isAborted()) break;

      const { toolCall: tc, result } = sr;
      const output = result.success ? result.output : `工具执行错误: ${result.error}`;

      logger.toolResult(tc.name, result.success, output.length, result.error);
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

      processedIds.add(tc.id);
      this.loopController.recordToolCalls(1);
    }

    // 如果中断发生，为未处理的工具补齐 tool_result
    if (this.loopController.isAborted()) {
      this.yieldMissingToolResults(toolCalls, processedIds, messages);
    }
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
        content: '工具执行被中断。',
        toolCallId: tc.id,
      });
    }
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
  ): Promise<HarnessResult> {
    this.loopController.stop(reason);
    const state = this.loopController.getState();
    logger.loopStop(reason, state.currentRound, state.totalToolCalls);

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

    // 其他原因：请求 LLM 总结
    logger.llmCall();
    messages.push({
      role: 'user',
      content: '请根据以上工具调用结果，给出最终的总结回答。',
    });

    let finalContent = '';
    try {
      const finalResponse = await chatFn(messages, { tools: [] });
      finalContent = finalResponse.content;
      logger.llmResponseFinal({
        input: finalResponse.usage?.inputTokens ?? 0,
        output: finalResponse.usage?.outputTokens ?? 0,
      });
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
   * 如果需要，执行上下文压缩。
   */
  private async maybeCompact(
    messages: UnifiedMessage[],
    chatFn: ChatFunction,
    logger: HarnessLogger,
    onStep?: (event: HarnessStepEvent) => void,
  ): Promise<void> {
    if (this.contextCompactor.needsCompaction(messages)) {
      const before = messages.length;

      // 压缩前获取会话笔记（保持连续性）
      const sessionNotes = await this.memoryIntegration.getSessionMemoryForCompact();

      const compacted = await this.contextCompactor.compact(messages, chatFn);

      messages.length = 0;
      messages.push(...compacted);

      // 压缩后注入会话笔记（帮助模型恢复上下文）
      if (sessionNotes) {
        messages.push({
          role: 'user',
          content: `<session-notes>\n以下是本次会话的结构化笔记，帮助你恢复上下文：\n\n${sessionNotes}\n</session-notes>`,
        });
      }

      logger.compaction(before, messages.length);
      onStep?.({ type: 'compaction', content: `${before} → ${messages.length}` });
    }
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
}