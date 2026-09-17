import { describe, expect, it, vi } from 'vitest';

import { AnthropicAdapter, resolveAnthropicMessagesUrl } from '../../src/llm/anthropic-adapter.js';
import { isAbortError } from '../../src/llm/abort-error.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('resolveAnthropicMessagesUrl', () => {
  it('appends /v1/messages to a host-only base URL', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com'))
      .toBe('https://api.anthropic.com/v1/messages');
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com/v1'))
      .toBe('https://api.anthropic.com/v1/messages');
  });

  it('does not duplicate an existing messages path', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com/v1/messages'))
      .toBe('https://api.anthropic.com/v1/messages');
    expect(resolveAnthropicMessagesUrl('https://proxy.example.com/anthropic/v1/messages'))
      .toBe('https://proxy.example.com/anthropic/v1/messages');
  });

  it('preserves query strings', () => {
    expect(resolveAnthropicMessagesUrl('https://gateway.example.com/v1?foo=1'))
      .toBe('https://gateway.example.com/v1/messages?foo=1');
  });
});

function sseBody(events: Array<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

describe('AnthropicAdapter', () => {
  const messages: UnifiedMessage[] = [{ role: 'user', content: 'hi' }];

  it('POSTs /v1/messages with x-api-key and no Authorization', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('sk-ant-test');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('authorization')).toBeNull();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('claude-sonnet-4-5');
      expect(body.max_tokens).toBe(1024);
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      baseURL: 'https://api.anthropic.com',
      maxTokens: 1024,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await adapter.chat(messages, {});
    expect(result.content).toBe('hello');
    expect(result.usage.inputTokens).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends thinking from the same reasoningEffort ladder as OpenAI', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
      expect(body.temperature).toBe(1);
      return new Response(JSON.stringify({
        content: [
          { type: 'thinking', thinking: 'reason' },
          { type: 'text', text: 'hello' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 8 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'union-alpha',
      maxTokens: 32768,
      reasoningEffortLevels: ['low', 'high', 'max'],
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await adapter.chat(messages, { reasoningEffort: 'max' });
    expect(result.reasoningContent).toBe('reason');
    expect(result.content).toBe('hello');
  });

  it('parses SSE stream events into content and tool calls', async () => {
    const fetchMock = vi.fn(async () => new Response(sseBody([
      {
        event: 'message_start',
        data: { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok ' } },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_9', name: 'read_file', input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
        },
      },
      {
        event: 'message_delta',
        data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const chunks: string[] = [];
    const result = await adapter.stream(messages, (chunk, done) => {
      if (!done && typeof chunk === 'string' && chunk) chunks.push(chunk);
    }, {});
    expect(chunks.join('')).toBe('ok ');
    expect(result.content).toBe('ok ');
    expect(result.toolCalls).toEqual([{ id: 'toolu_9', name: 'read_file', arguments: { path: 'a.ts' } }]);
    expect(result.finishReason).toBe('tool_calls');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { stream?: boolean };
    expect(body.stream).toBe(true);
  });

  it('maps HTTP errors to a status-bearing Error', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: 'invalid x-api-key' },
    }), { status: 401 }));
    const adapter = new AnthropicAdapter({
      apiKey: 'bad',
      model: 'claude-sonnet-4-5',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(adapter.chat(messages, {})).rejects.toMatchObject({
      message: expect.stringContaining('invalid x-api-key'),
      status: 401,
    });
  });

  it('treats user abort as a non-retryable abort error', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(err);
          return;
        }
        signal?.addEventListener('abort', () => reject(err), { once: true });
      });
    });
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const pending = adapter.chat(messages, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toSatisfy((error: unknown) => isAbortError(error));
  });

  it('falls back to non-stream chat when the SSE endpoint returns 503', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { stream?: boolean };
      if (body.stream) {
        return new Response(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Endpoint is unavailable.' },
        }), { status: 503 });
      }
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'pong' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const adapter = new AnthropicAdapter({
      apiKey: 'sk-ant-test',
      model: 'union-alpha',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const chunks: string[] = [];
    const result = await adapter.stream(messages, (chunk, done) => {
      if (!done && typeof chunk === 'string' && chunk) chunks.push(chunk);
    }, {});
    expect(chunks.join('')).toBe('pong');
    expect(result.content).toBe('pong');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
