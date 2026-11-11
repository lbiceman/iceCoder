import { describe, expect, it } from 'vitest';

import {
  buildAnthropicMessagesRequest,
  convertImageUrlToAnthropicSource,
  convertUnifiedMessagesToAnthropic,
  convertAnthropicMessageResponse,
  mapAnthropicStopReason,
} from '../../src/llm/anthropic-messages.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('convertImageUrlToAnthropicSource', () => {
  it('parses data URLs into base64 sources', () => {
    expect(convertImageUrlToAnthropicSource('data:image/png;base64,QUJD')).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'QUJD',
    });
  });

  it('maps image/jpg to image/jpeg', () => {
    const src = convertImageUrlToAnthropicSource('data:image/jpg;base64,QUJD');
    expect(src).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'QUJD' });
  });

  it('keeps http(s) URLs as url sources', () => {
    expect(convertImageUrlToAnthropicSource('https://cdn.example.com/a.png')).toEqual({
      type: 'url',
      url: 'https://cdn.example.com/a.png',
    });
  });
});

describe('convertUnifiedMessagesToAnthropic', () => {
  it('lifts system messages and keeps user/assistant turns', () => {
    const converted = convertUnifiedMessagesToAnthropic([
      { role: 'system', content: 'you are iceCoder' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(converted.system).toEqual([
      { type: 'text', text: 'you are iceCoder', cache_control: { type: 'ephemeral' } },
    ]);
    expect(converted.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('converts tool_calls into tool_use and tool results into a following user turn', () => {
    const converted = convertUnifiedMessagesToAnthropic([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'checking',
        toolCalls: [{ id: 'toolu_1', name: 'get_weather', arguments: { city: 'SF' } }],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: '68F' },
    ]);
    expect(converted.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } },
        ],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '68F',
          cache_control: { type: 'ephemeral' },
        }],
      },
    ]);
  });

  it('merges consecutive user turns so roles always alternate', () => {
    const converted = convertUnifiedMessagesToAnthropic([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(converted.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one\ntwo' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('inserts a placeholder tool_result when pairing is missing', () => {
    const converted = convertUnifiedMessagesToAnthropic([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_missing', name: 'read_file', arguments: { path: 'a.ts' } }],
      },
    ]);
    const last = converted.messages[converted.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_missing',
        content: '[工具结果丢失]',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('drops orphan tool results with no matching tool_use', () => {
    const converted = convertUnifiedMessagesToAnthropic([
      { role: 'user', content: 'hi' },
      { role: 'tool', toolCallId: 'orphan', content: 'nope' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(converted.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('puts the conversation breakpoint before the ephemeral tail', () => {
    const converted = convertUnifiedMessagesToAnthropic([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: 'file body' },
      { role: 'user', content: '[System Runtime State]\nnow\n[/System Runtime State]', promptCacheEphemeral: true },
    ]);
    const last = converted.messages[converted.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'file body',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: '[System Runtime State]\nnow\n[/System Runtime State]' },
    ]);
    const cachedBlocks = JSON.stringify(converted).match(/"cache_control"/g) ?? [];
    expect(cachedBlocks).toHaveLength(2);
  });

  it('does not cache a request that is only the ephemeral tail', () => {
    const converted = convertUnifiedMessagesToAnthropic([
      { role: 'user', content: 'stable question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'clock tick', promptCacheEphemeral: true },
    ]);
    expect(converted.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'stable question' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: [{ type: 'text', text: 'clock tick' }] },
    ]);
  });

  it('converts image content blocks', () => {
    const converted = convertUnifiedMessagesToAnthropic([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', imageUrl: 'https://cdn.example.com/a.png' },
        ],
      },
    ]);
    expect(converted.messages[0]?.content).toEqual([
      { type: 'text', text: 'see' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://cdn.example.com/a.png' },
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});

describe('buildAnthropicMessagesRequest', () => {
  it('requires max_tokens and converts tools to input_schema', () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'hi' }];
    const req = buildAnthropicMessagesRequest(
      messages,
      {
        tools: [{
          name: 'read_file',
          description: 'read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        }],
      },
      { model: 'claude-sonnet-4-5', maxTokens: 2048, temperature: 0.2 },
      true,
    );
    expect(req.model).toBe('claude-sonnet-4-5');
    expect(req.max_tokens).toBe(2048);
    expect(req.stream).toBe(true);
    expect(req.temperature).toBe(0.2);
    expect(req.tools).toEqual([{
      name: 'read_file',
      description: 'read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      cache_control: { type: 'ephemeral' },
    }]);
    expect(Object.keys(req)[0]).toBe('model');
  });

  it('marks only the last tool, after name order', () => {
    const req = buildAnthropicMessagesRequest(
      [{ role: 'user', content: 'hi' }],
      {
        tools: [
          { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
          { name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } },
        ],
      },
      { model: 'claude-sonnet-4-5' },
      false,
    );
    expect(req.tools?.map(tool => tool.name)).toEqual(['grep', 'read_file']);
    expect(req.tools?.[0]?.cache_control).toBeUndefined();
    expect(req.tools?.[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('throws when there is no user/assistant message after stripping system', () => {
    expect(() => buildAnthropicMessagesRequest(
      [{ role: 'system', content: 'only system' }],
      {},
      { model: 'claude-sonnet-4-5' },
      false,
    )).toThrow(/至少需要一条/);
  });

  it('maps reasoningEffort onto Anthropic thinking and forces temperature 1', () => {
    const req = buildAnthropicMessagesRequest(
      [{ role: 'user', content: 'hi' }],
      { reasoningEffort: 'high', temperature: 0.2, topP: 0.9 },
      { model: 'union-alpha', maxTokens: 16384, temperature: 0.2 },
      true,
    );
    expect(req.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(req.temperature).toBe(1);
    expect(req.top_p).toBeUndefined();
  });

  it('omits thinking when reasoningEffort is not set', () => {
    const req = buildAnthropicMessagesRequest(
      [{ role: 'user', content: 'hi' }],
      {},
      { model: 'union-alpha', maxTokens: 16384 },
      false,
    );
    expect(req.thinking).toBeUndefined();
  });
});

describe('convertAnthropicMessageResponse', () => {
  it('maps text, thinking, tool_use and usage', () => {
    const converted = convertAnthropicMessageResponse({
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
      },
    }, 'anthropic');
    expect(converted.content).toBe('hello');
    expect(converted.reasoningContent).toBe('plan');
    expect(converted.toolCalls).toEqual([
      { id: 'toolu_1', name: 'read_file', arguments: { path: 'a.ts' } },
    ]);
    expect(converted.finishReason).toBe('tool_calls');
    expect(converted.usage).toMatchObject({
      inputTokens: 35,
      outputTokens: 4,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
      cacheMissTokens: 10,
      provider: 'anthropic',
    });
  });

  it('maps reasoning/text thinking blocks', () => {
    const converted = convertAnthropicMessageResponse({
      content: [
        { type: 'reasoning', text: 'plan' },
        { type: 'text', text: 'hello' },
      ],
      stop_reason: 'end_turn',
    }, 'anthropic');
    expect(converted.content).toBe('hello');
    expect(converted.reasoningContent).toBe('plan');
  });
});

describe('mapAnthropicStopReason', () => {
  it('maps Anthropic stop reasons onto unified finishReason', () => {
    expect(mapAnthropicStopReason('end_turn')).toBe('stop');
    expect(mapAnthropicStopReason('tool_use')).toBe('tool_calls');
    expect(mapAnthropicStopReason('max_tokens')).toBe('length');
    expect(mapAnthropicStopReason('refusal')).toBe('error');
  });
});
