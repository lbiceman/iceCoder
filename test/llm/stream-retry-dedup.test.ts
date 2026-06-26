/**
 * LLMAdapter.stream 重试去重回归测试（修复 P0-13）。
 *
 * 背景：withRetry 包裹整个 stream() 调用。若流在已经向调用方推送过若干
 * delta 之后才失败，简单重试会从头重放，导致调用方收到重复内容。
 *
 * 覆盖：
 * 1. 流在产出内容后失败 → 不重试，错误上抛，调用方只收到一份内容（无重复）。
 * 2. 流在产出任何内容前失败（可重试错误）→ 正常重试并最终成功，无重复。
 * 3. reasoning channel 的 delta 同样计入"已产出"，产出后失败不重试。
 * 4. skipRetry 路径不受影响。
 */

import { describe, it, expect, vi } from 'vitest';
import { LLMAdapter } from '../../src/llm/llm-adapter.js';
import type {
  LLMOptions,
  LLMResponse,
  StreamCallback,
  UnifiedMessage,
} from '../../src/llm/types.js';

const sampleMessages: UnifiedMessage[] = [{ role: 'user', content: 'hi' }];

function okResponse(content: string): LLMResponse {
  return {
    content,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'openai' },
    finishReason: 'stop',
  };
}

describe('LLMAdapter.stream · 重试去重（P0-13）', () => {
  it('已产出内容后失败 → 不重试，调用方只收到一份内容', async () => {
    const adapter = new LLMAdapter({ maxRetries: 3, baseDelay: 1, maxDelay: 5 });
    const streamFn = vi.fn(
      async (_m: UnifiedMessage[], cb: StreamCallback, _o: LLMOptions): Promise<LLMResponse> => {
        cb('Hello', false);
        cb(' world', false);
        throw new Error('socket hang up'); // 本是"可重试"错误，但已产出内容
      },
    );
    adapter.registerProvider({
      name: 'openai',
      chat: vi.fn() as any,
      stream: streamFn as any,
      countTokens: vi.fn().mockResolvedValue(0),
    });
    adapter.setDefaultProvider('openai');

    const received: string[] = [];
    await expect(
      adapter.stream(sampleMessages, (chunk) => {
        if (typeof chunk === 'string' && chunk) received.push(chunk);
      }),
    ).rejects.toThrow(/socket hang up/i);

    // 关键：只调用一次 stream（没有重试重放），内容无重复
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(received.join('')).toBe('Hello world');
  });

  it('未产出任何内容即失败（可重试）→ 正常重试并成功，无重复', async () => {
    const adapter = new LLMAdapter({ maxRetries: 2, baseDelay: 1, maxDelay: 5 });
    let calls = 0;
    const streamFn = vi.fn(
      async (_m: UnifiedMessage[], cb: StreamCallback, _o: LLMOptions): Promise<LLMResponse> => {
        calls++;
        if (calls < 2) {
          // 连接刚建立就失败，未推送任何 delta（socket hang up 属可重试错误）
          throw new Error('socket hang up');
        }
        cb('done', false);
        cb('', true);
        return okResponse('done');
      },
    );
    adapter.registerProvider({
      name: 'openai',
      chat: vi.fn() as any,
      stream: streamFn as any,
      countTokens: vi.fn().mockResolvedValue(0),
    });
    adapter.setDefaultProvider('openai');

    const received: string[] = [];
    const resp = await adapter.stream(sampleMessages, (chunk) => {
      if (typeof chunk === 'string' && chunk) received.push(chunk);
    });

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(resp.content).toBe('done');
    expect(received.join('')).toBe('done'); // 无重复
  });

  it('reasoning delta 也计入已产出 → 产出后失败不重试', async () => {
    const adapter = new LLMAdapter({ maxRetries: 3, baseDelay: 1, maxDelay: 5 });
    const streamFn = vi.fn(
      async (_m: UnifiedMessage[], cb: StreamCallback, _o: LLMOptions): Promise<LLMResponse> => {
        cb({ channel: 'reasoning', delta: 'thinking...' }, false);
        throw new Error('socket hang up');
      },
    );
    adapter.registerProvider({
      name: 'openai',
      chat: vi.fn() as any,
      stream: streamFn as any,
      countTokens: vi.fn().mockResolvedValue(0),
    });
    adapter.setDefaultProvider('openai');

    await expect(adapter.stream(sampleMessages, () => {})).rejects.toThrow(/socket hang up/i);
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it('skipRetry 路径不重试，行为不变', async () => {
    const adapter = new LLMAdapter({ maxRetries: 3, baseDelay: 1, maxDelay: 5 });
    const streamFn = vi.fn(
      async (_m: UnifiedMessage[], _cb: StreamCallback, _o: LLMOptions): Promise<LLMResponse> => {
        throw new Error('ECONNRESET');
      },
    );
    adapter.registerProvider({
      name: 'openai',
      chat: vi.fn() as any,
      stream: streamFn as any,
      countTokens: vi.fn().mockResolvedValue(0),
    });
    adapter.setDefaultProvider('openai');

    await expect(
      adapter.stream(sampleMessages, () => {}, { skipRetry: true }),
    ).rejects.toThrow(/ECONNRESET/i);
    expect(streamFn).toHaveBeenCalledTimes(1);
  });
});
