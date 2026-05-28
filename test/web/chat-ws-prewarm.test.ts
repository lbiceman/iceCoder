import { describe, expect, it, vi } from 'vitest';

import type { AssembledPrompt } from '../../src/prompts/types.js';
import {
  getOrLoadAssembledChatPrompt,
  prewarmChatRuntime,
  resetAssembledChatPromptCache,
} from '../../src/web/chat-ws-prewarm.js';

const fakePrompt = {
  systemPrompt: 'sys',
  harnessOverlay: {},
} as unknown as AssembledPrompt;

describe('chat-ws-prewarm', () => {
  it('getOrLoadAssembledChatPrompt 同进程内只加载一次', async () => {
    resetAssembledChatPromptCache();
    const spy = vi.spyOn(
      await import('../../src/prompts/load-chat-prompt.js'),
      'loadAssembledChatPrompt',
    ).mockResolvedValue(fakePrompt);

    const a = await getOrLoadAssembledChatPrompt('[test]');
    const b = await getOrLoadAssembledChatPrompt('[test]');

    expect(a).toBe(fakePrompt);
    expect(b).toBe(fakePrompt);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('load 失败后允许重试', async () => {
    resetAssembledChatPromptCache();
    const spy = vi.spyOn(
      await import('../../src/prompts/load-chat-prompt.js'),
      'loadAssembledChatPrompt',
    )
      .mockRejectedValueOnce(new Error('io fail'))
      .mockResolvedValueOnce(fakePrompt);

    await expect(getOrLoadAssembledChatPrompt('[test]')).rejects.toThrow('io fail');
    await expect(getOrLoadAssembledChatPrompt('[test]')).resolves.toBe(fakePrompt);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('prewarmChatRuntime 并行触发三个 hook 且吞掉错误', async () => {
    const ensureMemory = vi.fn().mockResolvedValue(undefined);
    const getSupervisor = vi.fn().mockResolvedValue({});
    const loadPrompt = vi.fn().mockResolvedValue(fakePrompt);

    prewarmChatRuntime({
      ensureMemoryInitialized: ensureMemory,
      getSupervisorRuntime: getSupervisor,
      loadAssembledPrompt: loadPrompt,
    });

    await vi.waitFor(() => {
      expect(ensureMemory).toHaveBeenCalledTimes(1);
      expect(getSupervisor).toHaveBeenCalledTimes(1);
      expect(loadPrompt).toHaveBeenCalledTimes(1);
    });

    const failMemory = vi.fn().mockRejectedValue(new Error('mem'));
    prewarmChatRuntime({
      ensureMemoryInitialized: failMemory,
      getSupervisorRuntime: vi.fn().mockResolvedValue({}),
      loadAssembledPrompt: vi.fn().mockResolvedValue(fakePrompt),
    });
    await vi.waitFor(() => expect(failMemory).toHaveBeenCalled());
  });
});
