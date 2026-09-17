/**
 * Anthropic Messages SSE 解析：帧切分 + 事件折叠为统一流式增量。
 * 不依赖官方 SDK。
 */

import type { LLMResponse, StreamCallback, ToolCall } from './types.js';
import { mapAnthropicStopReason, usageFromAnthropic, type AnthropicUsage } from './anthropic-messages.js';
import { safeParseToolArguments } from './text-sanitize.js';

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

export interface AnthropicSseParser {
  push(chunk: string): SseFrame[];
  flush(): SseFrame[];
}

interface ToolUseAcc {
  id: string;
  name: string;
  json: string;
}

export interface AnthropicStreamState {
  content: string;
  reasoningContent: string;
  toolCalls: Map<number, ToolUseAcc>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  stopReason?: string;
  error?: { type: string; message: string };
}

export interface AnthropicStreamDelta {
  textDelta?: string;
  reasoningDelta?: string;
}

/** 增量切分 SSE 帧（兼容 LF / CRLF）。 */
export function createSseParser(): AnthropicSseParser {
  let buffer = '';

  const consume = (final: boolean): SseFrame[] => {
    const frames: SseFrame[] = [];
    while (buffer.length > 0) {
      const lf = buffer.indexOf('\n\n');
      const crlf = buffer.indexOf('\r\n\r\n');
      let sep = -1;
      let sepLen = 0;
      if (lf >= 0 && (crlf < 0 || lf <= crlf)) {
        sep = lf;
        sepLen = 2;
      } else if (crlf >= 0) {
        sep = crlf;
        sepLen = 4;
      }
      if (sep < 0) {
        if (final) {
          const leftover = buffer;
          buffer = '';
          const frame = parseSseBlock(leftover);
          if (frame) frames.push(frame);
        }
        break;
      }
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + sepLen);
      const frame = parseSseBlock(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  };

  return {
    push(chunk: string): SseFrame[] {
      if (!chunk) return [];
      buffer += chunk;
      return consume(false);
    },
    flush(): SseFrame[] {
      return consume(true);
    },
  };
}

export function parseSseBlock(raw: string): SseFrame | null {
  const lines = raw.split(/\r?\n/);
  let event = '';
  const dataLines: string[] = [];
  let id: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id' && value) id = value;
  }

  if (dataLines.length === 0 && !event) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') {
    return { event: event || 'done', data: '[DONE]', ...(id ? { id } : {}) };
  }
  return { event: event || 'message', data, ...(id ? { id } : {}) };
}

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    content: '',
    reasoningContent: '',
    toolCalls: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw || raw === '[DONE]') return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

const ANTHROPIC_SSE_TYPES = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'ping',
  'error',
  'done',
]);

/** `event: message` 且 type 写在 JSON 里时，以 payload.type 为准。 */
export function resolveAnthropicSseEventType(
  frame: SseFrame,
  payload: Record<string, unknown> | null,
): string {
  const payloadType = typeof payload?.type === 'string' ? payload.type : '';
  const event = frame.event || '';
  if (payloadType && ANTHROPIC_SSE_TYPES.has(payloadType)) {
    if (!event || event === 'message' || event === 'delta' || event === payloadType) {
      return payloadType;
    }
  }
  return event || payloadType;
}

function takeReasoningDelta(delta: Record<string, unknown>): string | undefined {
  if (
    delta.type !== 'thinking_delta'
    && delta.type !== 'reasoning_delta'
    && delta.type !== 'reasoning_content'
  ) {
    return undefined;
  }
  for (const value of [delta.thinking, delta.reasoning_content, delta.text]) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function takeTextDelta(delta: Record<string, unknown>): string | undefined {
  if (typeof delta.text !== 'string' || !delta.text) return undefined;
  if (!delta.type || delta.type === 'text_delta' || delta.type === 'text') return delta.text;
  return undefined;
}

function applyUsage(state: AnthropicStreamState, usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const u = usage as AnthropicUsage;
  if (typeof u.input_tokens === 'number') state.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') state.outputTokens = u.output_tokens;
  if (typeof u.cache_read_input_tokens === 'number') state.cacheReadTokens = u.cache_read_input_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') {
    state.cacheCreationTokens = u.cache_creation_input_tokens;
  }
}

/** 将一帧 Anthropic SSE 事件折叠进累加器，并返回应对回调发出的增量。 */
export function applyAnthropicSseEvent(
  state: AnthropicStreamState,
  frame: SseFrame,
): AnthropicStreamDelta {
  const payload = parseJsonObject(frame.data);
  const type = resolveAnthropicSseEventType(frame, payload);

  if (type === 'ping' || type === 'done' || type === 'message_stop') {
    return {};
  }

  if (type === 'error') {
    const errObj = (payload?.error && typeof payload.error === 'object')
      ? payload.error as { type?: string; message?: string }
      : payload;
    const message = typeof errObj?.message === 'string' && errObj.message
      ? errObj.message
      : (typeof payload?.message === 'string' ? payload.message : frame.data || 'Anthropic stream error');
    const errType = typeof errObj?.type === 'string' ? errObj.type : 'error';
    state.error = { type: errType, message };
    return {};
  }

  if (!payload) return {};

  if (type === 'message_start') {
    const message = payload.message && typeof payload.message === 'object'
      ? payload.message as { usage?: unknown }
      : payload;
    applyUsage(state, message.usage);
    return {};
  }

  if (type === 'message_delta') {
    const delta = payload.delta && typeof payload.delta === 'object'
      ? payload.delta as { stop_reason?: string }
      : undefined;
    if (typeof delta?.stop_reason === 'string') state.stopReason = delta.stop_reason;
    applyUsage(state, payload.usage);
    return {};
  }

  if (type === 'content_block_start') {
    const index = typeof payload.index === 'number' ? payload.index : 0;
    const block = payload.content_block && typeof payload.content_block === 'object'
      ? payload.content_block as Record<string, unknown>
      : undefined;
    if (block?.type === 'tool_use') {
      const input = block.input;
      const hasInput = input && typeof input === 'object' && !Array.isArray(input)
        && Object.keys(input as Record<string, unknown>).length > 0;
      state.toolCalls.set(index, {
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        json: hasInput ? JSON.stringify(input) : '',
      });
    } else if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
      state.content += block.text;
      return { textDelta: block.text };
    } else if (
      (block?.type === 'thinking' || block?.type === 'reasoning' || block?.type === 'redacted_thinking')
    ) {
      const piece = typeof block.thinking === 'string' && block.thinking
        ? block.thinking
        : (typeof block.text === 'string' ? block.text : '');
      if (piece) {
        state.reasoningContent += piece;
        return { reasoningDelta: piece };
      }
    }
    return {};
  }

  if (type === 'content_block_delta') {
    const index = typeof payload.index === 'number' ? payload.index : 0;
    const delta = payload.delta && typeof payload.delta === 'object'
      ? payload.delta as Record<string, unknown>
      : undefined;
    if (!delta) return {};

    const textDelta = takeTextDelta(delta);
    if (textDelta) {
      state.content += textDelta;
      return { textDelta };
    }
    const reasoningDelta = takeReasoningDelta(delta);
    if (reasoningDelta) {
      state.reasoningContent += reasoningDelta;
      return { reasoningDelta };
    }
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const existing = state.toolCalls.get(index);
      if (existing) {
        existing.json += delta.partial_json;
      } else {
        state.toolCalls.set(index, { id: '', name: '', json: delta.partial_json });
      }
    }
    return {};
  }

  return {};
}

export function emitAnthropicStreamDelta(
  callback: StreamCallback,
  delta: AnthropicStreamDelta,
): void {
  if (delta.textDelta) callback(delta.textDelta, false);
  if (delta.reasoningDelta) callback({ channel: 'reasoning', delta: delta.reasoningDelta }, false);
}

export function finalizeAnthropicStream(
  state: AnthropicStreamState,
  provider: string,
): Pick<LLMResponse, 'content' | 'reasoningContent' | 'toolCalls' | 'finishReason' | 'usage'> {
  if (state.error) {
    const err = new Error(`Anthropic API Error: ${state.error.message}`);
    (err as { status?: number; code?: string; provider?: string }).code = state.error.type;
    (err as { provider?: string }).provider = provider;
    throw err;
  }

  const toolCalls: ToolCall[] = [];
  const indexes = [...state.toolCalls.keys()].sort((a, b) => a - b);
  for (const index of indexes) {
    const tc = state.toolCalls.get(index)!;
    toolCalls.push({
      id: tc.id,
      name: tc.name,
      arguments: safeParseToolArguments(tc.json || '{}'),
    });
  }

  return {
    content: state.content,
    reasoningContent: state.reasoningContent || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: mapAnthropicStopReason(state.stopReason),
    usage: usageFromAnthropic({
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      cache_read_input_tokens: state.cacheReadTokens,
      cache_creation_input_tokens: state.cacheCreationTokens,
    }, provider),
  };
}
