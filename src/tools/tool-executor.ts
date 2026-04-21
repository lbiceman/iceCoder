/**
 * 工具执行器。
 * 职责单一：执行工具调用，支持重试、超时和错误处理。
 *
 * 注意：循环控制（while loop）由 Harness 负责，不在这里。
 * ToolExecutor 只做"接到一个工具调用 → 执行 → 返回结果"。
 */

import type { ToolCall } from '../llm/types.js';
import type { ToolResult, ToolExecutorConfig } from './types.js';
import type { ToolRegistry } from './tool-registry.js';

const DEFAULT_CONFIG: ToolExecutorConfig = {
  maxRetries: 3,
  retryBaseDelay: 1000,
  retryMaxDelay: 15000,
  toolTimeout: 60000,
};

export class ToolExecutor {
  private registry: ToolRegistry;
  private config: ToolExecutorConfig;

  constructor(registry: ToolRegistry, config?: Partial<ToolExecutorConfig>) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 执行单个工具调用，带重试和超时。
   */
  async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(toolCall.name);
    if (!tool) {
      return { success: false, output: '', error: `未知工具: ${toolCall.name}` };
    }

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await this.executeWithTimeout(
          () => tool.handler(toolCall.arguments),
          this.config.toolTimeout,
        );
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < this.config.maxRetries) {
          const delay = Math.min(
            this.config.retryBaseDelay * Math.pow(2, attempt),
            this.config.retryMaxDelay,
          );
          await this.sleep(delay);
        }
      }
    }

    return {
      success: false,
      output: '',
      error: `工具 "${toolCall.name}" 在 ${this.config.maxRetries + 1} 次尝试后仍然失败: ${lastError}`,
    };
  }

  /**
   * 批量执行多个工具调用（并行）。
   */
  async executeToolCalls(toolCalls: ToolCall[]): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>();
    const promises = toolCalls.map(async (tc) => {
      const result = await this.executeTool(tc);
      results.set(tc.id, result);
    });
    await Promise.all(promises);
    return results;
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`工具执行超时 (${timeoutMs}ms)`)), timeoutMs);
      fn()
        .then((result) => { clearTimeout(timer); resolve(result); })
        .catch((error) => { clearTimeout(timer); reject(error); });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
