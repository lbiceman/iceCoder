/**
 * Anthropic Messages 提供者适配器。
 * 请求体、x-api-key 鉴权、SSE 解析分别由独立模块实现，本文件负责 HTTP 与 ProviderAdapter 组装。
 */

import { randomUUID } from 'node:crypto';
import type {
  LLMOptions,
  LLMResponse,
  ProviderAdapter,
  StreamCallback,
  UnifiedMessage,
} from './types.js';
import { estimateStringTokens } from './token-estimator.js';
import { isAbortError, makeAbortedError } from './abort-error.js';
import {
  isStreamIdleTimeoutError,
  resolveOpenAiStreamIdleTimeoutMs,
  withStreamIdleWatchdog,
} from './stream-idle-watchdog.js';
import { resolveProviderRequestHeaders } from './provider-request-headers.js';
import {
  parseReasoningEffort,
  resolveWireReasoningEffort,
} from './reasoning-effort.js';
import { mergeAnthropicRequestHeaders } from './anthropic-auth.js';
import {
  buildAnthropicMessagesRequest,
  convertAnthropicMessageResponse,
  type AnthropicMessageResponse,
} from './anthropic-messages.js';
import {
  applyAnthropicSseEvent,
  createAnthropicStreamState,
  createSseParser,
  emitAnthropicStreamDelta,
  finalizeAnthropicStream,
} from './anthropic-sse.js';
import { endTiming, harnessTimingEnabled, markTimingStart, recordHarnessTiming } from '../harness/harness-timing.js';

export interface AnthropicAdapterConfig {
  apiKey: string;
  name?: string;
  baseURL?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** 单次 API 请求超时（毫秒），默认 600000（10 分钟） */
  timeout?: number;
  supportsVision?: boolean;
  requestHeaders?: Record<string, string>;
  anthropicVersion?: string;
  fetch?: typeof fetch;
  /** 该厂商配置的推理强度档位；为空则不发送 thinking */
  reasoningEffortLevels?: string[];
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 600_000;

/** 将 provider.apiUrl 解析为 POST /v1/messages 的绝对地址。 */
export function resolveAnthropicMessagesUrl(baseURL: string | undefined): string {
  const raw = (baseURL ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid Anthropic base URL: ${raw}`);
  }
  const path = url.pathname.replace(/\/+$/, '') || '';
  const lower = path.toLowerCase();
  if (lower.endsWith('/v1/messages') || lower.endsWith('/messages')) {
    url.pathname = path || '/';
    return url.toString();
  }
  if (lower.endsWith('/v1')) {
    url.pathname = `${path}/messages`;
    return url.toString();
  }
  url.pathname = `${path}/v1/messages`;
  return url.toString();
}

export class AnthropicAdapter implements ProviderAdapter {
  public readonly name: string;
  private readonly apiKey: string;
  private readonly messagesUrl: string;
  private readonly model: string;
  private readonly defaultRequestTimeoutMs: number;
  private readonly requestHeaderTemplates: Record<string, string>;
  private readonly fallbackSessionId: string;
  private readonly anthropicVersion?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly reasoningEffortLevels: string[];
  private readonly defaultParams: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };

  constructor(config: AnthropicAdapterConfig) {
    this.name = config.name ?? 'anthropic';
    this.apiKey = config.apiKey;
    this.messagesUrl = resolveAnthropicMessagesUrl(config.baseURL);
    this.model = config.model;
    this.defaultRequestTimeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.requestHeaderTemplates = { ...(config.requestHeaders ?? {}) };
    this.fallbackSessionId = randomUUID();
    this.anthropicVersion = config.anthropicVersion;
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.reasoningEffortLevels = [...(config.reasoningEffortLevels ?? [])];
    this.defaultParams = {
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      topP: config.topP,
    };
  }

  private withResolvedEffort(options: LLMOptions): LLMOptions {
    const effort = resolveWireReasoningEffort(options.reasoningEffort, this.reasoningEffortLevels);
    if (!effort) {
      if (!options.reasoningEffort) return options;
      const { reasoningEffort: _drop, ...rest } = options;
      return rest;
    }
    return { ...options, reasoningEffort: effort };
  }

  private effortLogFrag(options: LLMOptions): string {
    const effort = parseReasoningEffort(options.reasoningEffort);
    return effort ? `, reasoning=${effort}` : '';
  }

  async chat(messages: UnifiedMessage[], options: LLMOptions): Promise<LLMResponse> {
    try {
      options = this.withResolvedEffort(options);
      const signal = options.signal ?? undefined;
      if (signal?.aborted) throw makeAbortedError(this.name);

      const serializeStartedAt = markTimingStart();
      const body = buildAnthropicMessagesRequest(messages, options, {
        model: this.model,
        ...this.defaultParams,
      }, false);
      endTiming('llm_serialize', serializeStartedAt);

      const timeout = this.resolveTimeout(options);
      console.log(
        `[Anthropic] messages 请求 → model=${body.model}, messages=${body.messages.length}条, tools=${body.tools?.length ?? 0}个, timeout=${timeout}ms${this.effortLogFrag(options)}`,
      );
      const startTime = Date.now();
      const response = await this.send(body, options, signal, timeout);
      const elapsed = Date.now() - startTime;
      recordHarnessTiming('llm_http', elapsed);

      if (!response.ok) {
        throw await this.httpError(response);
      }

      const json = await response.json() as AnthropicMessageResponse;
      const converted = convertAnthropicMessageResponse(json, this.name);
      console.log(
        `[Anthropic] messages 响应: ${elapsed}ms | tokens: ${converted.usage.inputTokens} | ${converted.usage.outputTokens}`,
      );
      return converted;
    } catch (error) {
      throw this.convertError(error, options.signal ?? undefined);
    }
  }

  async stream(
    messages: UnifiedMessage[],
    callback: StreamCallback,
    options: LLMOptions,
  ): Promise<LLMResponse> {
    try {
      options = this.withResolvedEffort(options);
      const signal = options.signal ?? undefined;
      if (signal?.aborted) throw makeAbortedError(this.name);

      const serializeStartedAt = markTimingStart();
      const body = buildAnthropicMessagesRequest(messages, options, {
        model: this.model,
        ...this.defaultParams,
      }, true);
      endTiming('llm_serialize', serializeStartedAt);

      const idleTimeoutMs = resolveOpenAiStreamIdleTimeoutMs();
      console.log(
        `[Anthropic] messages stream → model=${body.model}, messages=${body.messages.length}条, tools=${body.tools?.length ?? 0}个, idleTimeout=${idleTimeoutMs}ms${this.effortLogFrag(options)}`,
      );
      const startTime = Date.now();
      const timingOn = harnessTimingEnabled();
      let firstTokenMs: number | undefined;

      return await withStreamIdleWatchdog(
        signal,
        async (watchdog) => {
          const response = await this.send(body, options, watchdog.signal, 0);
          watchdog.markActivity();
          if (!response.ok) {
            throw await this.httpError(response);
          }
          if (!response.body) {
            throw new Error('Anthropic stream response has no body');
          }

          const parser = createSseParser();
          const state = createAnthropicStreamState();
          const onText = (text: string) => {
            watchdog.markActivity();
            for (const frame of parser.push(text)) {
              const delta = applyAnthropicSseEvent(state, frame);
              if (timingOn && firstTokenMs === undefined && (delta.textDelta || delta.reasoningDelta)) {
                firstTokenMs = Date.now() - startTime;
                recordHarnessTiming('llm_first_token', firstTokenMs);
              }
              emitAnthropicStreamDelta(callback, delta);
            }
          };

          await this.readStream(response.body, watchdog.signal, onText);
          for (const frame of parser.flush()) {
            emitAnthropicStreamDelta(callback, applyAnthropicSseEvent(state, frame));
          }

          const result = finalizeAnthropicStream(state, this.name);
          callback('', true);

          if (!result.content && !result.toolCalls?.length) {
            console.warn(
              `[Anthropic] stream 无正文/工具 output=${result.usage.outputTokens} stop=${result.finishReason} reasoning=${result.reasoningContent ? 'yes' : 'no'}`,
            );
          }

          const elapsed = Date.now() - startTime;
          recordHarnessTiming('llm_http', elapsed);
          const cacheFrag =
            result.usage.cacheReadTokens != null || result.usage.cacheCreationTokens != null
              ? ` | cache_read|write=${result.usage.cacheReadTokens ?? '?'}|${result.usage.cacheCreationTokens ?? '?'}`
              : '';
          console.log(
            `[Anthropic] stream 完成 : ${elapsed}ms | tokens: ${result.usage.inputTokens} | ${result.usage.outputTokens}${cacheFrag}`,
          );
          return result;
        },
        { label: 'Anthropic' },
      );
    } catch (error) {
      const converted = this.convertError(error, options.signal ?? undefined);
      if (!options.skipStreamFallback && this.isStreamUnavailableError(converted)) {
        console.warn('[Anthropic] stream 网关不可用，回退非流式 /v1/messages');
        const result = await this.chat(messages, { ...options, skipStreamFallback: true });
        if (result.reasoningContent) {
          callback({ channel: 'reasoning', delta: result.reasoningContent }, false);
        }
        if (result.content) callback(result.content, false);
        callback('', true);
        return result;
      }
      throw converted;
    }
  }

  async countTokens(text: string): Promise<number> {
    return estimateStringTokens(text);
  }

  private resolveTimeout(options: LLMOptions): number {
    const perCall =
      typeof options.requestTimeoutMs === 'number'
      && Number.isFinite(options.requestTimeoutMs)
      && options.requestTimeoutMs > 0
        ? Math.floor(options.requestTimeoutMs)
        : undefined;
    return perCall !== undefined
      ? Math.max(this.defaultRequestTimeoutMs, perCall)
      : this.defaultRequestTimeoutMs;
  }

  private resolveConfiguredHeaders(options?: LLMOptions): Record<string, string> | undefined {
    const sessionId = typeof options?.sessionId === 'string' && options.sessionId.trim()
      ? options.sessionId.trim()
      : this.fallbackSessionId;
    return resolveProviderRequestHeaders(this.requestHeaderTemplates, {
      sessionId,
      providerId: this.name,
      model: options?.model || this.model,
    });
  }

  private async send(
    body: unknown,
    options: LLMOptions,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined = timeoutSignal
      ? (signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal)
      : signal;
    const headers = mergeAnthropicRequestHeaders(
      this.apiKey,
      this.resolveConfiguredHeaders(options),
      { version: this.anthropicVersion },
    );
    if (body && typeof body === 'object' && (body as { stream?: unknown }).stream === true) {
      headers.accept = 'text/event-stream';
    }

    try {
      return await this.fetchImpl(this.messagesUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(combined ? { signal: combined } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw makeAbortedError(this.name);
      if (timeoutSignal?.aborted) {
        const timedOut = new Error(`request timeout after ${timeoutMs}ms`);
        (timedOut as NodeJS.ErrnoException).code = 'ETIMEDOUT';
        throw timedOut;
      }
      throw error;
    }
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    onText: (text: string) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (signal?.aborted) throw makeAbortedError(this.name);
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          onText(decoder.decode(value, { stream: true }));
        }
      }
      const tail = decoder.decode();
      if (tail) onText(tail);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  private async httpError(response: Response): Promise<Error> {
    const text = await response.text().catch(() => '');
    let message = text || response.statusText || 'unknown error';
    let code: string | undefined;
    try {
      const json = JSON.parse(text) as {
        error?: { type?: string; message?: string };
        message?: string;
        type?: string;
      };
      if (json?.error?.message) message = json.error.message;
      else if (typeof json.message === 'string' && json.message) message = json.message;
      code = json?.error?.type ?? json?.type;
    } catch {
      /* plain text body */
    }
    const err = new Error(`Anthropic API Error [${response.status}]: ${message}`);
    (err as { status?: number; code?: string; provider?: string }).status = response.status;
    (err as { code?: string }).code = code;
    (err as { provider?: string }).provider = this.name;
    return err;
  }

  private isStreamUnavailableError(error: Error): boolean {
    if (isAbortError(error) || isStreamIdleTimeoutError(error)) return false;
    const status = (error as { status?: number }).status;
    if (status === 503) return true;
    const msg = error.message.toLowerCase();
    return msg.includes('endpoint is unavailable') || msg.includes('overloaded');
  }

  private convertError(error: unknown, userSignal?: AbortSignal): Error {
    if (isStreamIdleTimeoutError(error)) {
      if (error instanceof Error && !(error as { provider?: string }).provider) {
        (error as { provider?: string }).provider = this.name;
      }
      return error instanceof Error ? error : new Error(String(error));
    }
    if (userSignal?.aborted || isAbortError(error)) {
      const aborted = makeAbortedError(this.name);
      (aborted as { provider?: string }).provider = this.name;
      return aborted;
    }
    if (error instanceof Error) {
      if (!(error as { provider?: string }).provider) {
        (error as { provider?: string }).provider = this.name;
      }
      return error;
    }
    return new Error('Anthropic Adapter: Unknown error occurred');
  }
}
