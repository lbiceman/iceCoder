/**
 * 流式工具执行器 — 在模型还在输出时就开始执行工具。
 *
 * 参考 Claude Code 的 services/tools/StreamingToolExecutor.ts：
 * 当模型流式输出包含多个工具调用时，不需要等所有工具调用
 * 都输出完毕才开始执行。已经完整输出的工具调用可以立即开始执行，
 * 与模型的后续输出并行进行。
 *
 * 这显著减少了多工具调用场景的总延迟：
 * - 传统方式：等模型输出完 → 串行执行所有工具 → 总延迟 = 模型时间 + 工具1 + 工具2 + ...
 * - 流式方式：模型输出工具1 → 立即执行工具1 → 模型继续输出工具2 → 执行工具2 → ...
 *
 * 注意：只有标记为 isConcurrencySafe 的工具才会并行执行。
 */

import type { ToolCall } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import { isConcurrencySafe } from '../tools/tool-metadata.js';

/**
 * 工具执行结果（带工具调用信息）。
 */
export interface StreamingToolResult {
  /** 原始工具调用 */
  toolCall: ToolCall;
  /** 执行结果 */
  result: ToolResult;
  /** 执行耗时（毫秒） */
  durationMs: number;
}

/**
 * 流式工具执行器。
 *
 * 使用方式：
 * ```ts
 * const executor = new StreamingToolExecutor(toolExecutor);
 *
 * // 模型流式输出时，每完成一个工具调用就提交
 * executor.submit(toolCall1);  // 立即开始执行
 * executor.submit(toolCall2);  // 如果并行安全，也立即开始
 *
 * // 模型输出完毕后，获取所有结果
 * const results = await executor.flush();
 * ```
 */
export class StreamingToolExecutor {
  private toolExecutor: ToolExecutor;
  private pendingResults: Map<string, Promise<StreamingToolResult>> = new Map();
  private completedResults: StreamingToolResult[] = [];

  constructor(toolExecutor: ToolExecutor) {
    this.toolExecutor = toolExecutor;
  }

  /**
   * 提交一个工具调用，立即开始执行。
   * 如果工具是并行安全的，会与其他工具并行执行。
   * 如果不是并行安全的，会等待之前的工具完成后再执行。
   */
  submit(toolCall: ToolCall): void {
    const startTime = Date.now();

    const executePromise = (async (): Promise<StreamingToolResult> => {
      // 如果工具不是并行安全的，等待所有之前的工具完成
      if (!isConcurrencySafe(toolCall.name)) {
        await this.waitForAll();
      }

      let result: ToolResult;
      try {
        result = await this.toolExecutor.executeTool(toolCall);
      } catch (err) {
        // 兜底：ToolExecutor 内部异常不应该发生，但防御性处理
        result = {
          success: false,
          output: '',
          error: `工具执行异常: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const durationMs = Date.now() - startTime;

      const streamingResult: StreamingToolResult = {
        toolCall,
        result,
        durationMs,
      };

      this.completedResults.push(streamingResult);
      return streamingResult;
    })();

    this.pendingResults.set(toolCall.id, executePromise);
  }

  /**
   * 等待所有已提交的工具执行完毕，返回所有结果。
   */
  async flush(): Promise<StreamingToolResult[]> {
    await this.waitForAll();
    const results = [...this.completedResults];
    this.completedResults = [];
    this.pendingResults.clear();
    return results;
  }

  /**
   * 获取已完成的结果（不等待未完成的）。
   */
  getCompletedResults(): StreamingToolResult[] {
    return [...this.completedResults];
  }

  /**
   * 是否有正在执行的工具。
   */
  hasPending(): boolean {
    return this.pendingResults.size > this.completedResults.length;
  }

  /**
   * 等待所有 pending 的工具完成。
   */
  private async waitForAll(): Promise<void> {
    const promises = Array.from(this.pendingResults.values());
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }
}
