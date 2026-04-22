/**
 * Harness — 核心循环引擎（状态机模式）。
 *
 * 参考 Claude Code 的 query.ts 架构：
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
import type { ToolExecutor } from '../tools/tool-executor.js';
import type {
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  ChatFunction,
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
import { scanMemoryFiles, memoryFreshnessNote } from '../memory/file-memory/index.js';
import type { FileMemoryManager } from '../memory/file-memory/file-memory-manager.js';
import type { ConversationMessage } from '../memory/file-memory/memory-extractor.js';
import type { MemoryManager } from '../memory/memory-manager.js';
import { MemoryType } from '../memory/types.js';

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

// ─── 记忆注入 ───
const MEMORY_MAX_FILE_MEMORIES = 10;
const MEMORY_MAX_RELEVANT_MEMORIES = 10;

// ─── 默认压缩配置 ───
const DEFAULT_COMPACTION_THRESHOLD = 40;
const DEFAULT_COMPACTION_KEEP_RECENT = 10;

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
 * 参考 Claude Code 的 state.transition。
 */
type Transition =
  | 'initial'
  | 'tool_calls'
  | 'max_output_tokens_recovery'
  | 'stop_hook_continue'
  | 'token_budget_continuation'
  | 'llm_error_retry'
  | 'compaction_retry';

/**
 * 迭代间携带的可变状态。
 * 参考 Claude Code 的 State 类型。
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
  private memoryDir?: string;
  private fileMemoryManager?: FileMemoryManager;
  private memoryManager?: MemoryManager;
  private memoryRetrieveLimit: number;
  /** 当前用户消息，用于记忆相关性检索 */
  private currentUserMessage: string = '';

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

    // 记忆目录：用于文件记忆持久化（向后兼容）
    this.memoryDir = config.memoryDir;

    // 文件记忆管理器：多级加载+异步预取+自动提取（优先于 memoryDir）
    this.fileMemoryManager = config.fileMemoryManager;

    // 结构化记忆管理器：用于运行时工作记忆
    this.memoryManager = config.memoryManager;
    this.memoryRetrieveLimit = config.memoryRetrieveLimit ?? 5;

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
   * 参考 Claude Code 的 queryLoop()：
   * while(true) + State 对象，每轮迭代 = 预处理 → LLM 调用 → 响应处理 → 决定继续/停止。
   *
   * @param userMessage - 用户输入
   * @param chatFn - LLM 调用函数
   * @param onStep - 每一步的回调（用于 SSE 实时推送）
   * @param existingMessages - 已有的对话消息历史（参考 claude-code 的 params.messages）
   * @returns Harness 执行结果（包含结构化日志）
   */
  async run(
    userMessage: string,
    chatFn: ChatFunction,
    onStep?: (event: HarnessStepEvent) => void,
    existingMessages?: UnifiedMessage[],
  ): Promise<HarnessResult> {
    const logger = new HarnessLogger();

    // ── 初始化（循环外，只执行一次）──
    // 参考 claude-code：如果有已有消息历史，直接追加用户消息；否则从零构建
    let messages: UnifiedMessage[];
    if (existingMessages && existingMessages.length > 0) {
      messages = existingMessages;
      messages.push({ role: 'user', content: userMessage });
    } else {
      messages = this.contextAssembler.assembleInitialMessages(userMessage);
    }
    const tools = this.contextAssembler.getTools();
    logger.loopStart(tools.length, messages.length);

    // 保存用户消息用于记忆相关性检索
    this.currentUserMessage = userMessage;
    this.memoryInjected = false;

    // 将用户输入存入短期记忆（如果有 MemoryManager）
    await this.storeToMemory(userMessage, 'user_input');

    // 启动异步记忆预取（不阻塞，后续 injectMemoryContext 时消费结果）
    this.startMemoryPrefetch(userMessage);

    // 初始化可变状态
    const state: LoopState = {
      messages,
      tools,
      turnCount: 0,
      maxOutputTokensRecoveryCount: 0,
      llmRetryCount: 0,
      transition: 'initial',
    };

    // ── 核心循环（参考 Claude Code 的 while(true) 迭代模式）──
    while (true) {
      // 1. 解构当前状态
      const { messages: msgs, tools: currentTools } = state;

      // 2. 消息预处理管线（工具结果预算裁剪 → 上下文压缩）
      this.applyToolResultBudget(msgs);
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
      const normalizedMsgs = normalizeMessages(msgs);

      // 检查用户中断
      if (this.loopController.isAborted()) {
        return this.handleStop('user_abort', msgs, chatFn, currentTools, logger, onStep);
      }

      let response;
      try {
        response = await chatFn(normalizedMsgs, { tools: currentTools });
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
          // 不推进轮次，回退 advanceRound
          continue;
        }

        // 不可重试或重试次数用完 → 返回错误
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`LLM 调用失败且无法恢复: ${errorMsg}`);
        this.loopController.stop('error');
        const finalState = this.loopController.getState();
        logger.loopStop('error', finalState.currentRound, finalState.totalToolCalls);
        await this.consolidateMemory();

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
        // 参考 Claude Code：finishReason === 'length' 时注入"请继续"，最多重试 3 次
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
            msgs.push({ role: 'assistant', content: response.content });
          }
          // 参考 Claude Code：精确措辞防止模型浪费 token 重复之前的内容
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

          // 循环结束时触发记忆合并
          await this.consolidateMemory();

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

        // ── 5b. 停止钩子 ──
        // 参考 Claude Code 的 stop hooks：如果钩子要求继续，注入消息后 continue
        if (this.stopHookManager.count > 0) {
          const hookResult = await this.stopHookManager.execute(msgs, response.content);
          if (hookResult.shouldContinue && hookResult.message) {
            console.log(`[harness] 停止钩子 "${hookResult.hookName}" 要求继续`);
            msgs.push({ role: 'user', content: hookResult.message });
            state.transition = 'stop_hook_continue';
            continue;
          }
        }

        // ── 5c. Token 预算继续 ──
        // 参考 Claude Code 的 token budget：预算充足时注入 nudge 消息
        if (this.tokenBudgetTracker && this.tokenBudgetTracker.shouldContinue()) {
          const nudge = this.tokenBudgetTracker.getContinuationMessage();
          console.log(`[harness] token 预算继续: ${this.tokenBudgetTracker.getSummary()}`);
          msgs.push({ role: 'user', content: nudge });
          state.transition = 'token_budget_continuation';
          continue;
        }

        // ── 5d. 正常完成 → return ──
        this.loopController.stop('model_done');
        const finalState = this.loopController.getState();
        logger.loopStop('model_done', finalState.currentRound, finalState.totalToolCalls);

        // 循环结束时触发记忆合并
        await this.consolidateMemory();

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
      });

      // 6a. 执行工具调用（StreamingToolExecutor 并行 + 权限检查 + 中断检查 + 记忆记录）
      await this.executeToolCallsStreaming(response.toolCalls!, msgs, logger, onStep);

      // 6b. 注入记忆上下文（文件记忆 + 结构化记忆检索）
      // 放在所有 tool 结果之后、下一轮 LLM 调用之前
      await this.injectMemoryContext(msgs);

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
  }


  /**
   * 工具结果预算裁剪。
   *
   * 参考 Claude Code 的 applyToolResultBudget()：
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
   * 注入记忆上下文（整合文件记忆 + 结构化记忆）。
   *
   * 两个来源合并为一条 <system-reminder>，避免多条 user 消息堆积：
   * 1. 文件记忆：扫描 memoryDir，按修改时间取最新的，附带新鲜度提醒
   * 2. 结构化记忆：用当前用户消息做相关性检索，返回高重要性记忆
   *
   * 只在第一轮工具调用后注入一次，后续轮次跳过（避免重复堆积）。
   */
  private memoryInjected = false;

  private async injectMemoryContext(messages: UnifiedMessage[]): Promise<void> {
    if (this.memoryInjected) return;
    if (!this.memoryDir && !this.fileMemoryManager && !this.memoryManager) return;

    const sections: string[] = [];

    // ── 文件记忆（优先使用 FileMemoryManager，回退到旧的 scanMemoryFiles）──
    if (this.fileMemoryManager) {
      try {
        // 使用相关性检索（消费异步预取结果或同步检索）
        const relevantMemories = await this.fileMemoryManager.getRelevantMemories(
          this.currentUserMessage,
          MEMORY_MAX_RELEVANT_MEMORIES,
        );
        if (relevantMemories.length > 0) {
          const { memoryFreshnessNote } = await import('../memory/file-memory/memory-age.js');
          const parts: string[] = [];
          for (const mem of relevantMemories) {
            const freshness = memoryFreshnessNote(mem.mtimeMs);
            const desc = mem.description ? `: ${mem.description}` : '';
            parts.push(`${freshness}- ${mem.filename}${desc}`);
          }
          sections.push(`文件记忆（按相关性排序）：\n${parts.join('\n')}`);
        }
      } catch {
        // FileMemoryManager 失败不阻塞
      }
    } else if (this.memoryDir) {
      // 向后兼容：旧的 scanMemoryFiles 路径
      try {
        const fileMemories = await scanMemoryFiles(this.memoryDir, 50);
        if (fileMemories.length > 0) {
          const parts: string[] = [];
          for (const mem of fileMemories.slice(0, MEMORY_MAX_FILE_MEMORIES)) {
            const freshness = memoryFreshnessNote(mem.mtimeMs);
            const desc = mem.description ? `: ${mem.description}` : '';
            parts.push(`${freshness}- ${mem.filename}${desc}`);
          }
          sections.push(`文件记忆：\n${parts.join('\n')}`);
        }
      } catch {
        // 文件记忆扫描失败不阻塞
      }
    }

    // ── 结构化记忆检索 ──
    if (this.memoryManager && this.currentUserMessage) {
      try {
        const retrieved = await this.memoryManager.retrieve(
          this.currentUserMessage,
          undefined,
          this.memoryRetrieveLimit,
        );
        if (retrieved.length > 0) {
          const parts = retrieved.map(m => {
            const age = Math.floor((Date.now() - m.lastAccessedAt.getTime()) / 86_400_000);
            const ageStr = age === 0 ? '今天' : age === 1 ? '昨天' : `${age}天前`;
            const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
            return `- (${m.type}, ${ageStr}, 重要性:${m.importanceScore.toFixed(2)})${tags} ${m.content.substring(0, 200)}`;
          });
          sections.push(`相关记忆：\n${parts.join('\n')}`);

          for (const m of retrieved) {
            try { await this.memoryManager.boostImportanceScore(m.id); } catch { /* */ }
          }
        }
      } catch {
        // 结构化记忆检索失败不阻塞
      }
    }

    if (sections.length > 0) {
      const reminder = `<system-reminder>\n${sections.join('\n\n')}\n</system-reminder>`;
      messages.push({ role: 'user', content: reminder });
    }

    this.memoryInjected = true;
  }

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
    const streamingExecutor = new StreamingToolExecutor(this.toolExecutor);
    const iteration = this.loopController.getState().currentRound;

    // 第一遍：权限检查 + 提交到流式执行器
    const submittedIds = new Set<string>();
    for (const tc of toolCalls) {
      // 检查用户中断
      if (this.loopController.isAborted()) {
        // 为剩余未执行的 tool_use 补齐错误 tool_result
        this.yieldMissingToolResults(toolCalls, submittedIds, messages);
        break;
      }

      // ── 提交到流式执行器 ──
      logger.toolCall(tc.name, tc.arguments);
      onStep?.({ type: 'tool_call', iteration, toolName: tc.name, toolArgs: tc.arguments });
      streamingExecutor.submit(tc);
      submittedIds.add(tc.id);
    }

    // 第二遍：等待所有已提交的工具完成，收集结果
    const results = await streamingExecutor.flush();

    for (const sr of results) {
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

      await this.storeToolInteraction(tc.name, tc.arguments, result.success, output);
      this.loopController.recordToolCalls(1);
    }

    // 如果中断发生在 flush 期间，为未完成的补齐
    if (this.loopController.isAborted()) {
      this.yieldMissingToolResults(toolCalls, new Set(results.map(r => r.toolCall.id)), messages);
    }
  }

  /**
   * 为未完成的 tool_use 补齐错误 tool_result。
   *
   * 参考 Claude Code 的 yieldMissingToolResultBlocks()：
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

    // 循环结束时触发记忆合并（短期 → 长期）
    await this.consolidateMemory();

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

    const finalResponse = await chatFn(messages, { tools: [] });
    logger.llmResponseFinal({
      input: finalResponse.usage?.inputTokens ?? 0,
      output: finalResponse.usage?.outputTokens ?? 0,
    });

    onStep?.({
      type: 'final',
      totalToolCalls: state.totalToolCalls,
      content: finalResponse.content,
      stopReason: reason,
    });

    return {
      content: finalResponse.content,
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
      const compacted = await this.contextCompactor.compact(messages, chatFn);

      messages.length = 0;
      messages.push(...compacted);

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

  /**
   * 获取记忆管理器（用于外部直接操作记忆）。
   */
  getMemoryManager(): MemoryManager | undefined {
    return this.memoryManager;
  }

  // ─── 记忆集成私有方法 ───

  /**
   * 将内容存入短期记忆。
   * 失败不阻塞主流程。
   */
  private async storeToMemory(
    content: string,
    interactionType: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    if (!this.memoryManager) return;
    try {
      await this.memoryManager.store(content, MemoryType.SHORT_TERM, {
        interactionType,
        sourceAgent: 'harness',
        ...metadata,
      });
    } catch {
      // 记忆存储失败不阻塞主流程
    }
  }

  /**
   * 将工具交互记录到情景记忆。
   * 只记录摘要（工具名 + 成功/失败 + 输出前 200 字符），不记录完整输出。
   */
  private async storeToolInteraction(
    toolName: string,
    args: Record<string, any>,
    success: boolean,
    output: string,
  ): Promise<void> {
    if (!this.memoryManager) return;
    try {
      const argsStr = JSON.stringify(args);
      const truncatedArgs = argsStr.length > 200 ? argsStr.substring(0, 200) + '...' : argsStr;
      const truncatedOutput = output.substring(0, 200);
      const status = success ? '成功' : '失败';
      const description = `工具调用 ${toolName}(${truncatedArgs}) → ${status}: ${truncatedOutput}`;

      await this.memoryManager.store(description, MemoryType.EPISODIC, {
        interactionType: 'agent_transfer',
        sourceAgent: 'harness',
        participants: ['harness', toolName],
        occurredAt: new Date().toISOString(),
        toolName,
        success,
      });

      // 存入语义记忆：工具使用模式（知识图谱三元组）
      if (success) {
        await this.memoryManager.store(
          `工具 ${toolName} 可用于: ${truncatedArgs}`,
          MemoryType.SEMANTIC,
          { interactionType: 'tool_knowledge', sourceAgent: 'harness', toolName },
        ).catch(() => {});
      }

      // 存入过程记忆：工具执行技能追踪
      await this.memoryManager.store(
        `${toolName}: ${status}`,
        MemoryType.PROCEDURAL,
        { interactionType: 'skill_tracking', sourceAgent: 'harness', toolName, success },
      ).catch(() => {});
    } catch {
      // 记忆存储失败不阻塞主流程
    }
  }

  /**
   * 触发记忆合并 + 自动提取 + 衰减。
   * 在循环结束时调用，失败不阻塞。
   */
  private async consolidateMemory(): Promise<void> {
    // ── 结构化记忆合并+衰减 ──
    if (this.memoryManager) {
      try {
        const consolidated = await this.memoryManager.consolidate();
        if (consolidated > 0) {
          console.log(`[harness] 记忆合并: ${consolidated} 条短期记忆转入长期记忆`);
        }

        const decayed = await this.memoryManager.decay();
        if (decayed > 0) {
          console.log(`[harness] 记忆衰减: ${decayed} 条记忆受影响`);
        }

        // 发现记忆间的关联（内容相似性 + 时间邻近性）
        const associations = await this.memoryManager.discoverAssociations();
        if (associations.length > 0) {
          console.log(`[harness] 发现 ${associations.length} 条记忆关联`);
        }
      } catch {
        // 合并/衰减失败不阻塞
      }
    }

    // ── 文件记忆自动提取 ──
    if (this.fileMemoryManager) {
      try {
        // 从当前对话中提取值得记住的信息
        const conversationMessages: ConversationMessage[] = [];
        // 只提取 user 和 assistant 消息（跳过 system/tool）
        if (this.currentUserMessage) {
          conversationMessages.push({
            role: 'user',
            content: this.currentUserMessage,
            timestamp: Date.now(),
          });
        }
        if (conversationMessages.length > 0) {
          const { saved } = await this.fileMemoryManager.extractMemoriesFromConversation(
            conversationMessages,
          );
          if (saved > 0) {
            console.log(`[harness] 自动记忆提取: ${saved} 条记忆已保存`);
          }
        }
      } catch {
        // 自动提取失败不阻塞
      }
    }
  }

  /**
   * 启动异步记忆预取（不阻塞主流程）。
   * 在循环开始时调用，结果在 injectMemoryContext 时消费。
   */
  private startMemoryPrefetch(query: string): void {
    if (!this.fileMemoryManager) return;
    // fire-and-forget：不 await，不阻塞
    this.fileMemoryManager.prefetchMemories(query).catch(() => {
      // 预取失败静默处理
    });
  }
}