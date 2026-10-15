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

const TOOL_ABORTED_MESSAGE = '工具执行已中止 (aborted)';

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EAGAIN',
  'EBUSY',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EADDRINUSE',
  'ENOTFOUND',
]);

const PERMANENT_ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ENOTDIR',
  'EINVAL',
  'EEXIST',
  'ERR_INVALID_ARG_TYPE',
]);

/**
 * 只有暂时性故障才重试。参数错误、路径错误、类型错误立刻失败。
 * 未归类的异常默认不重试，避免永久错误打满 maxRetries。
 */
export function isRetryableToolError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (PERMANENT_ERROR_CODES.has(code)) return false;
    if (RETRYABLE_ERROR_CODES.has(code)) return true;
  }
  if (
    error instanceof TypeError
    || error instanceof SyntaxError
    || error instanceof ReferenceError
    || error instanceof RangeError
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/must be of type|Unknown tool|Input validation failed|ENOENT|EACCES|EPERM|no such file|not found|invalid argument/i.test(message)) {
    return false;
  }
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|timeout|timed out|\b429\b|\b502\b|\b503\b|\b504\b|temporar|EAGAIN|EBUSY/i.test(message);
}

/** 超时或外部中止：不可重试，直接返回失败。 */
class ToolInterruptedError extends Error {}

const DEFAULT_CONFIG: ToolExecutorConfig = {
  maxRetries: 3,
  retryBaseDelay: 1000,
  retryMaxDelay: 15000,
  toolTimeout: 10 * 60 * 1000,
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
  async executeTool(
    toolCall: ToolCall,
    onOutput?: ToolOutputCallback,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
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
      if (signal?.aborted) {
        return { success: false, output: '', error: TOOL_ABORTED_MESSAGE };
      }
      try {
        const result = await this.executeWithTimeout(
          (handlerSignal) => tool.handler(normalizedCall.arguments, onOutput, handlerSignal),
          this.config.toolTimeout,
          signal,
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
        if (error instanceof ToolInterruptedError) {
          return { success: false, output: '', error: error.message };
        }
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

        if (!isRetryableToolError(error) || attempt >= this.config.maxRetries) break;
        const delay = Math.min(
          this.config.retryBaseDelay * Math.pow(2, attempt),
          this.config.retryMaxDelay,
        );
        await this.sleep(delay, signal);
      }
    }

    return {
      success: false,
      output: '',
      error: `Tool "${toolCall.name}" failed after ${this.config.maxRetries + 1} attempts: ${lastError}`,
    };
  }

  /**
   * handler 不响应 signal 时也必须按时返回：与超时 / 外部中止竞速，
   * 竞速失败后 handler 仍可能在后台跑完，但结果被丢弃。
   */
  private async executeWithTimeout<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let interrupt!: (error: ToolInterruptedError) => void;
    const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
    const stop = (error: ToolInterruptedError) => {
      controller.abort();
      interrupt(error);
    };
    const timer = setTimeout(() => stop(new ToolInterruptedError(`工具执行超时 (${timeoutMs}ms)`)), timeoutMs);
    const onParentAbort = () => stop(new ToolInterruptedError(TOOL_ABORTED_MESSAGE));
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      return await Promise.race([fn(controller.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      const onAbort = () => finish();
      function finish(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
