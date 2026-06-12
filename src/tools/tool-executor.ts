/**
 * 工具执行器。
 * 职责单一：执行工具调用，支持重试、超时和错误处理。
 *
 * 注意：循环控制（while loop）由 Harness 负责，不在这里。
 * ToolExecutor 只做"接到一个工具调用 → 执行 → 返回结果"。
 */

import type { ToolCall } from '../llm/types.js';
import type { ToolResult, ToolExecutorConfig, ToolOutputCallback } from './types.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolValidator } from './tool-validator.js';
import {
  buildSalvageTruncatedError,
  buildWrappedArgumentFormatHint,
  isSalvagedTruncatedArguments,
  isUnexpandedStringWrapper,
  normalizeToolArguments,
} from './tool-arguments-normalizer.js';

const DEFAULT_CONFIG: ToolExecutorConfig = {
  maxRetries: 3,
  retryBaseDelay: 1000,
  retryMaxDelay: 15000,
  toolTimeout: 60000,
};

export class ToolExecutor {
  private registry: ToolRegistry;
  private config: ToolExecutorConfig;
  private validator?: ToolValidator;

  constructor(registry: ToolRegistry, config?: Partial<ToolExecutorConfig>, validator?: ToolValidator) {
    this.registry = registry;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.validator = validator;
  }

  /**
   * 执行单个工具调用，带验证、重试和超时。
   * @param onOutput - 可选的实时输出回调（用于 shell 命令等长时间运行的工具）
   */
  async executeTool(toolCall: ToolCall, onOutput?: ToolOutputCallback): Promise<ToolResult> {
    const tool = this.registry.get(toolCall.name);
    if (!tool) {
      return { success: false, output: '', error: `Unknown tool: ${toolCall.name}` };
    }

    const normalizedCall: ToolCall = {
      ...toolCall,
      arguments: normalizeToolArguments(toolCall.arguments ?? {}) as Record<string, any>,
    };

    if (isSalvagedTruncatedArguments(normalizedCall.arguments)) {
      return {
        success: false,
        output: '',
        error: `${buildSalvageTruncatedError(toolCall.name, normalizedCall.arguments)} ${buildWrappedArgumentFormatHint()}`,
      };
    }

    // 执行前验证输入参数
    if (this.validator) {
      const validation = this.validator.validate(normalizedCall);
      if (!validation.valid) {
        const expectedParams = tool.definition.parameters?.properties
          ? Object.keys(tool.definition.parameters.properties)
          : [];
        const receivedParams = Object.keys(normalizedCall.arguments);
        const hint = expectedParams.length > 0
          ? ` [accepted params: ${expectedParams.join(', ')}] [received params: ${receivedParams.join(', ') || '(none)'}]`
          : '';
        const wrapHint = isUnexpandedStringWrapper(normalizedCall.arguments)
          ? ` ${buildWrappedArgumentFormatHint()}`
          : '';
        return { success: false, output: '', error: `Input validation failed: ${validation.message}${hint}${wrapHint}` };
      }
    }

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await this.executeWithTimeout(
          () => tool.handler(normalizedCall.arguments, onOutput),
          this.config.toolTimeout,
        );
        if (!result.success && isUnexpandedStringWrapper(normalizedCall.arguments)) {
          const wrapHint = buildWrappedArgumentFormatHint();
          const error = result.error?.includes(wrapHint)
            ? result.error
            : `${result.error ?? 'Tool failed'}. ${wrapHint}`;
          return { ...result, error };
        }
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);

        // Detect common parameter name mismatch patterns
        const isTypeError = lastError.includes('must be of type') && lastError.includes('Received undefined');
        if (isTypeError) {
          const expectedParams = tool.definition.parameters?.properties
            ? Object.keys(tool.definition.parameters.properties)
            : [];
          const receivedParams = Object.keys(normalizedCall.arguments);
          lastError = `${lastError} — Likely parameter name mismatch. Tool "${toolCall.name}" accepts: [${expectedParams.join(', ')}]. Received: [${receivedParams.join(', ') || '(none)'}].`;
        }

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
      error: `Tool "${toolCall.name}" failed after ${this.config.maxRetries + 1} attempts: ${lastError}`,
    };
  }

  private async executeWithTimeout<T>(fn: (signal?: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fn(controller.signal);
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`工具执行超时 (${timeoutMs}ms)`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
