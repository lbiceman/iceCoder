/**
 * Harness — 核心循环引擎。
 *
 * 这是整个系统的心脏：
 *
 * while (未完成) {
 *   context = 组装上下文(系统提示 + 记忆 + 历史 + 工具结果)
 *   response = LLM(context)
 *   action = 解析(response)
 *   if (action == 调用工具) → 权限检查 → 执行工具 → 结果塞回 context → 继续循环
 *   if (action == 完成) → 退出
 * }
 *
 * 所有 AI 执行的操作均由 Harness 负责。
 * 其他模块（LLM、ToolExecutor、Memory）只提供能力，不驱动循环。
 */

import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { ToolCall } from '../llm/types.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type {
  HarnessConfig,
  HarnessResult,
  HarnessStepEvent,
  ChatFunction,
  StopReason,
} from './types.js';
import { ContextAssembler } from './context-assembler.js';
import { LoopController } from './loop-controller.js';
import { PermissionManager } from './permission.js';
import { ContextCompactor } from './context-compactor.js';
import { HarnessLogger } from './logger.js';
import type { HarnessLogEntry } from './logger.js';

/**
 * Harness 是 Agent 循环的核心引擎。
 *
 * 用户 prompt 决定"做什么"，Harness 决定"怎么做"。
 * 只有在安全边界上，Harness 才会硬性覆盖用户意图。
 */
export class Harness {
  private contextAssembler: ContextAssembler;
  private loopController: LoopController;
  private permissionManager: PermissionManager;
  private contextCompactor: ContextCompactor;
  private toolExecutor: ToolExecutor;
  private onConfirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;

  constructor(
    config: HarnessConfig,
    toolExecutor: ToolExecutor,
  ) {
    this.contextAssembler = new ContextAssembler(config.context);
    this.loopController = new LoopController(config.loop);
    this.permissionManager = new PermissionManager(config.permissions);
    this.contextCompactor = new ContextCompactor({
      threshold: config.compactionThreshold ?? 40,
      keepRecent: config.compactionKeepRecent ?? 10,
    });
    this.toolExecutor = toolExecutor;
    this.onConfirm = config.onConfirm;
  }

  /**
   * 执行核心循环。
   *
   * @param userMessage - 用户输入
   * @param chatFn - LLM 调用函数
   * @param onStep - 每一步的回调（用于 SSE 实时推送）
   * @returns Harness 执行结果（包含结构化日志）
   */
  async run(
    userMessage: string,
    chatFn: ChatFunction,
    onStep?: (event: HarnessStepEvent) => void,
  ): Promise<HarnessResult> {
    const logger = new HarnessLogger();

    // ── 第 0 步：组装初始上下文 ──
    const messages = this.contextAssembler.assembleInitialMessages(userMessage);
    const tools = this.contextAssembler.getTools();

    logger.loopStart(tools.length, messages.length);

    // ── 核心循环（受 maxRounds / tokenBudget / timeout / userAbort 控制）──
    let stopReason = this.loopController.shouldContinue();
    while (!stopReason) {
      this.loopController.advanceRound();
      const round = this.loopController.getState().currentRound;
      logger.roundStart(round, messages.length);

      // ── 上下文压缩（如果需要）──
      this.maybeCompact(messages, logger, onStep);

      // ── 调用 LLM ──
      logger.llmCall();
      const response = await chatFn(messages, { tools });

      const tokenUsage = {
        input: response.usage?.inputTokens ?? 0,
        output: response.usage?.outputTokens ?? 0,
      };
      this.loopController.recordTokenUsage(tokenUsage.input, tokenUsage.output);

      // ── 解析响应 ──

      // 情况 1：模型说 done（没有工具调用）
      if (response.finishReason !== 'tool_calls' || !response.toolCalls || response.toolCalls.length === 0) {
        logger.llmResponseFinal(tokenUsage);

        this.loopController.stop('model_done');
        const state = this.loopController.getState();
        logger.loopStop('model_done', state.currentRound, state.totalToolCalls);

        onStep?.({
          type: 'final',
          iteration: state.currentRound,
          totalToolCalls: state.totalToolCalls,
          content: response.content,
          stopReason: 'model_done',
          tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
          totalTokenUsage: { inputTokens: state.totalInputTokens, outputTokens: state.totalOutputTokens },
        });

        return {
          content: response.content,
          loopState: state,
          messages: [...messages],
          log: logger.getEntries(),
        };
      }

      // 情况 2：模型请求工具调用
      logger.llmResponseToolCalls(response.toolCalls.length, tokenUsage);

      // 推送 token 用量（附带思考内容，如果有的话）
      onStep?.({
        type: 'thinking',
        iteration: round,
        content: response.content || undefined,
        tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
        totalTokenUsage: { inputTokens: this.loopController.getState().totalInputTokens, outputTokens: this.loopController.getState().totalOutputTokens },
      });

      // 将 assistant 的 tool_calls 消息加入对话
      messages.push({
        role: 'assistant',
        content: response.content || '',
        toolCalls: response.toolCalls,
      });

      // ── 执行工具调用（带权限检查）──
      await this.executeToolCalls(response.toolCalls, messages, logger, onStep);

      // ── 检查下一轮是否应该停止 ──
      stopReason = this.loopController.shouldContinue();
    }

    // 循环因 maxRounds / tokenBudget / timeout / userAbort 退出
    return this.handleStop(stopReason, messages, chatFn, tools, logger, onStep);
  }

  /**
   * 执行工具调用，带权限检查。
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    messages: UnifiedMessage[],
    logger: HarnessLogger,
    onStep?: (event: HarnessStepEvent) => void,
  ): Promise<void> {
    for (const tc of toolCalls) {
      const iteration = this.loopController.getState().currentRound;

      // ── 权限检查 ──
      const permission = this.permissionManager.canUseTool(tc.name);

      if (!permission.allowed && permission.permission === 'deny') {
        logger.toolDenied(tc.name, permission.message);
        onStep?.({
          type: 'tool_denied',
          iteration,
          toolName: tc.name,
          toolArgs: tc.arguments,
          toolError: permission.message,
        });

        messages.push({
          role: 'tool',
          content: `工具调用被拒绝: ${permission.message}。请使用其他方式完成任务。`,
          toolCallId: tc.id,
        });
        this.loopController.recordToolCalls(1);
        continue;
      }

      // ── confirm 权限：等待用户确认 ──
      if (!permission.allowed && permission.permission === 'confirm') {
        onStep?.({
          type: 'tool_confirm',
          iteration,
          toolName: tc.name,
          toolArgs: tc.arguments,
        });

        let approved = true; // 没有 onConfirm 回调时默认允许
        if (this.onConfirm) {
          approved = await this.onConfirm(tc.name, tc.arguments);
        }

        if (!approved) {
          logger.toolDenied(tc.name, '用户拒绝');
          messages.push({
            role: 'tool',
            content: `工具调用被用户拒绝。请使用其他方式完成任务。`,
            toolCallId: tc.id,
          });
          this.loopController.recordToolCalls(1);
          continue;
        }
      }

      // ── 记录工具调用 ──
      logger.toolCall(tc.name, tc.arguments);
      onStep?.({
        type: 'tool_call',
        iteration,
        toolName: tc.name,
        toolArgs: tc.arguments,
      });

      // ── 执行工具 ──
      const result = await this.toolExecutor.executeTool(tc);

      const output = result.success
        ? result.output
        : `工具执行错误: ${result.error}`;

      // ── 记录工具结果 ──
      logger.toolResult(tc.name, result.success, output.length, result.error);
      onStep?.({
        type: 'tool_result',
        iteration,
        toolName: tc.name,
        toolSuccess: result.success,
        toolOutput: output.substring(0, 500),
        toolError: result.success ? undefined : result.error,
      });

      // 将工具结果加入对话（限制单次工具输出长度，防止上下文溢出）
      var MAX_TOOL_OUTPUT = 30000;
      var truncatedOutput = output.length > MAX_TOOL_OUTPUT
        ? output.substring(0, MAX_TOOL_OUTPUT) + '\n\n[输出已截断，原始长度: ' + output.length + ' 字符]'
        : output;

      messages.push({
        role: 'tool',
        content: truncatedOutput,
        toolCallId: tc.id,
      });

      this.loopController.recordToolCalls(1);
    }
  }

  /**
   * 处理循环停止：请求 LLM 给出最终总结。
   */
  private async handleStop(
    reason: StopReason,
    messages: UnifiedMessage[],
    chatFn: ChatFunction,
    tools: ToolDefinition[],
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
  private maybeCompact(
    messages: UnifiedMessage[],
    logger: HarnessLogger,
    onStep?: (event: HarnessStepEvent) => void,
  ): void {
    if (this.contextCompactor.needsCompaction(messages)) {
      const before = messages.length;
      const compacted = this.contextCompactor.compact(messages);

      messages.length = 0;
      messages.push(...compacted);

      logger.compaction(before, messages.length);
      onStep?.({ type: 'compaction', content: `${before} → ${messages.length}` });
    }
  }

  /**
   * 获取权限管理器（用于外部配置）。
   */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  /**
   * 获取循环状态。
   */
  getLoopState() {
    return this.loopController.getState();
  }
}
