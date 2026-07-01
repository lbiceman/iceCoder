/**
 * LLMAdapter.pruneProviders 回归测试（修复 P2-18）。
 *
 * 背景：热重载只按 id 覆盖注册，被删除/改名的 provider 会残留在内部 Map，
 * 仍可能被选为默认或被引用。pruneProviders 在重载后清理不在新集合内的旧项。
 */

import { describe, it, expect, vi } from 'vitest';
import { LLMAdapter } from '../../src/llm/llm-adapter.js';
import type { LLMResponse, ProviderAdapter, UnifiedMessage } from '../../src/llm/types.js';

function fakeProvider(name: string): ProviderAdapter {
  return {
    name,
    chat: vi.fn(
      async (): Promise<LLMResponse> => ({
        content: name,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: name },
        finishReason: 'stop',
      }),
    ),
    stream: vi.fn() as any,
    countTokens: vi.fn().mockResolvedValue(0),
  };
}

const msgs: UnifiedMessage[] = [{ role: 'user', content: 'hi' }];

describe('LLMAdapter.pruneProviders（P2-18）', () => {
  it('移除不在 keepNames 内的陈旧 provider', () => {
    const adapter = new LLMAdapter({ maxRetries: 0 });
    adapter.registerProvider(fakeProvider('a'));
    adapter.registerProvider(fakeProvider('b'));
    adapter.registerProvider(fakeProvider('c'));
    expect(adapter.getProviderNames().sort()).toEqual(['a', 'b', 'c']);

    // 模拟热重载：新配置只剩 a、c
    adapter.pruneProviders(['a', 'c']);
    expect(adapter.getProviderNames().sort()).toEqual(['a', 'c']);
  });

  it('被移除的若是当前默认 provider，则清空默认指向', async () => {
    const adapter = new LLMAdapter({ maxRetries: 0 });
    adapter.registerProvider(fakeProvider('old'));
    adapter.registerProvider(fakeProvider('new'));
    adapter.setDefaultProvider('old');

    adapter.pruneProviders(['new']);

    // old 已移除，默认被清空：无显式 provider 时调用应报错
    expect(adapter.getProviderNames()).toEqual(['new']);
    await expect(adapter.chat(msgs)).rejects.toThrow(/no default provider|No provider/i);
  });

  it('保留集合内的 provider 不受影响，仍可正常调用', async () => {
    const adapter = new LLMAdapter({ maxRetries: 0 });
    adapter.registerProvider(fakeProvider('keep'));
    adapter.registerProvider(fakeProvider('drop'));
    adapter.setDefaultProvider('keep');

    adapter.pruneProviders(['keep']);

    const resp = await adapter.chat(msgs);
    expect(resp.content).toBe('keep');
  });
});
