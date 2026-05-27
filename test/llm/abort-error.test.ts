/**
 * abort-error 工具与 LLMAdapter / harness 重试逻辑的中断短路测试。
 *
 * 覆盖：
 * 1. isAbortError 识别多种形态（AbortError name、ABORT_ERR code、flag、message）
 * 2. makeAbortedError 带标记
 * 3. LLMAdapter.setAbortSignal 后 provider 收到 options.signal
 * 4. provider 抛 AbortError 时 LLMAdapter 不会触发重试
 * 5. harness isRetryableError 对 abort 短路
 */

import { describe, it, expect, vi } from 'vitest';
import { isAbortError, makeAbortedError, ABORT_ERROR_FLAG } from '../../src/llm/abort-error.js';
import { LLMAdapter } from '../../src/llm/llm-adapter.js';
import { isRetryableError as harnessIsRetryableError } from '../../src/harness/harness-llm-log.js';
import type {
  LLMOptions,
  LLMResponse,
  ProviderAdapter,
  StreamCallback,
  UnifiedMessage,
} from '../../src/llm/types.js';

const sampleMessages: UnifiedMessage[] = [{ role: 'user', content: 'hi' }];

describe('isAbortError / makeAbortedError', () => {
  it('识别 name=AbortError 的标准错误', () => {
    const err = new Error('aborted');
    (err as any).name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('识别 code=ABORT_ERR 的 Node 错误', () => {
    const err = new Error('aborted');
    (err as any).code = 'ABORT_ERR';
    expect(isAbortError(err)).toBe(true);
  });

  it('识别带 isAbortError flag 的统一错误', () => {
    const err = makeAbortedError('openai');
    expect((err as any)[ABORT_ERROR_FLAG]).toBe(true);
    expect(isAbortError(err)).toBe(true);
  });

  it('普通网络错误不被误判为 abort', () => {
    expect(isAbortError(new Error('Connection reset'))).toBe(false);
    expect(isAbortError(new Error('rate limit exceeded'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('aborted')).toBe(false);
  });
});

describe('LLMAdapter.setAbortSignal · 注入到 provider options', () => {
  function mockProvider(name: string): ProviderAdapter {
    return {
      name,
      chat: vi.fn(async (_msgs: UnifiedMessage[], opts: LLMOptions): Promise<LLMResponse> => ({
        content: `chat-${opts.signal ? 'with-signal' : 'no-signal'}`,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: name },
        finishReason: 'stop',
      })),
      stream: vi.fn(async (_msgs: UnifiedMessage[], cb: StreamCallback, opts: LLMOptions): Promise<LLMResponse> => {
        cb('', true);
        return {
          content: `stream-${opts.signal ? 'with-signal' : 'no-signal'}`,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: name },
          finishReason: 'stop',
        };
      }),
      countTokens: vi.fn().mockResolvedValue(1),
    };
  }

  it('setAbortSignal 后 chat() 把 signal 传给 provider', async () => {
    const adapter = new LLMAdapter({ maxRetries: 0, baseDelay: 1, maxDelay: 1 });
    const p = mockProvider('openai');
    adapter.registerProvider(p);
    adapter.setDefaultProvider('openai');

    const ac = new AbortController();
    adapter.setAbortSignal(ac.signal);
    const resp = await adapter.chat(sampleMessages);

    expect(resp.content).toBe('chat-with-signal');
    expect((p.chat as any).mock.calls[0][1].signal).toBe(ac.signal);
  });

  it('setAbortSignal(null) 后不再注入 signal', async () => {
    const adapter = new LLMAdapter({ maxRetries: 0, baseDelay: 1, maxDelay: 1 });
    const p = mockProvider('openai');
    adapter.registerProvider(p);
    adapter.setDefaultProvider('openai');

    adapter.setAbortSignal(null);
    const resp = await adapter.stream(sampleMessages, () => {});
    expect(resp.content).toBe('stream-no-signal');
  });

  it('调用方显式传 options.signal 优先于 setAbortSignal', async () => {
    const adapter = new LLMAdapter({ maxRetries: 0, baseDelay: 1, maxDelay: 1 });
    const p = mockProvider('openai');
    adapter.registerProvider(p);
    adapter.setDefaultProvider('openai');

    const acBackground = new AbortController();
    const acExplicit = new AbortController();
    adapter.setAbortSignal(acBackground.signal);

    await adapter.chat(sampleMessages, { signal: acExplicit.signal });
    expect((p.chat as any).mock.calls[0][1].signal).toBe(acExplicit.signal);
  });
});

describe('LLMAdapter withRetry · abort 不触发重试', () => {
  it('provider 抛 AbortError 时 LLMAdapter 立即上抛，不重试', async () => {
    const adapter = new LLMAdapter({ maxRetries: 3, baseDelay: 1, maxDelay: 5 });
    const chatFn = vi.fn(async () => {
      throw makeAbortedError('openai');
    });
    adapter.registerProvider({
      name: 'openai',
      chat: chatFn as any,
      stream: vi.fn() as any,
      countTokens: vi.fn().mockResolvedValue(0),
    });
    adapter.setDefaultProvider('openai');

    await expect(adapter.chat(sampleMessages)).rejects.toThrow(/aborted/i);
    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  it('普通可重试错误仍会重试', async () => {
    const adapter = new LLMAdapter({ maxRetries: 2, baseDelay: 1, maxDelay: 5 });
    let calls = 0;
    const chatFn = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new Error('socket hang up');
      return {
        content: 'ok',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'openai' },
        finishReason: 'stop' as const,
      };
    });
    adapter.registerProvider({
      name: 'openai',
      chat: chatFn as any,
      stream: vi.fn() as any,
      countTokens: vi.fn().mockResolvedValue(0),
    });
    adapter.setDefaultProvider('openai');

    const resp = await adapter.chat(sampleMessages);
    expect(resp.content).toBe('ok');
    expect(chatFn).toHaveBeenCalledTimes(2);
  });
});

describe('harness isRetryableError · abort 短路', () => {
  it('abort 标记的错误不再被视为可重试', () => {
    const err = makeAbortedError('openai');
    expect(harnessIsRetryableError(err)).toBe(false);
  });

  it('「connection aborted」之类的普通网络错误仍可重试（未被 abort 标记）', () => {
    const err = new Error('Connection aborted');
    expect(harnessIsRetryableError(err)).toBe(true);
  });
});
