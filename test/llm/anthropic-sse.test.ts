import { describe, expect, it } from 'vitest';

import {
  applyAnthropicSseEvent,
  createAnthropicStreamState,
  createSseParser,
  finalizeAnthropicStream,
  parseSseBlock,
} from '../../src/llm/anthropic-sse.js';

function feed(events: Array<{ event: string; data: unknown }>) {
  const parser = createSseParser();
  const state = createAnthropicStreamState();
  const deltas: Array<{ text?: string; reasoning?: string }> = [];
  const raw = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  for (const frame of [...parser.push(raw), ...parser.flush()]) {
    const delta = applyAnthropicSseEvent(state, frame);
    if (delta.textDelta) deltas.push({ text: delta.textDelta });
    if (delta.reasoningDelta) deltas.push({ reasoning: delta.reasoningDelta });
  }
  return { state, deltas, result: finalizeAnthropicStream(state, 'anthropic') };
}

describe('parseSseBlock', () => {
  it('joins multi-line data and ignores comments', () => {
    const frame = parseSseBlock('event: ping\n: keep-alive\ndata: {"ok":\ndata: true}\n');
    expect(frame).toEqual({ event: 'ping', data: '{"ok":\ntrue}' });
  });
});

describe('createSseParser', () => {
  it('splits frames across chunk boundaries', () => {
    const parser = createSseParser();
    expect(parser.push('event: ping\ndata: {}')).toEqual([]);
    const frames = parser.push('\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(frames).toHaveLength(2);
    expect(frames[0]?.event).toBe('ping');
    expect(frames[1]?.event).toBe('message_stop');
  });
});

describe('applyAnthropicSseEvent', () => {
  it('accumulates text, thinking, tool json and usage', () => {
    const { deltas, result } = feed([
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 8 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
      },
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
        },
      },
      {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"city":"SF"}' },
        },
      },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 9 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);

    expect(deltas).toEqual([{ reasoning: 'hmm' }, { text: 'Hi' }]);
    expect(result.content).toBe('Hi');
    expect(result.reasoningContent).toBe('hmm');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'get_weather', arguments: { city: 'SF' } },
    ]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(9);
    expect(result.usage.cacheReadTokens).toBe(8);
  });

  it('reads payload.type when SSE event line is generic message', () => {
    const parser = createSseParser();
    const state = createAnthropicStreamState();
    const raw = 'event: message\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n';
    for (const frame of parser.push(raw)) {
      applyAnthropicSseEvent(state, frame);
    }
    expect(finalizeAnthropicStream(state, 'anthropic').content).toBe('Hi');
  });

  it('seeds text from content_block_start when there are no deltas', () => {
    const { result } = feed([
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'pong' } },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    expect(result.content).toBe('pong');
  });

  it('throws when the stream emits an error event', () => {
    const state = createAnthropicStreamState();
    applyAnthropicSseEvent(state, {
      event: 'error',
      data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    });
    expect(() => finalizeAnthropicStream(state, 'anthropic')).toThrow(/Overloaded/);
  });
});
