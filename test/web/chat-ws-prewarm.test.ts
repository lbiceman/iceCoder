import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
const originalSystemPromptPath = process.env.ICE_SYSTEM_PROMPT_PATH;

afterEach(() => {
  if (originalSystemPromptPath === undefined) {
    delete process.env.ICE_SYSTEM_PROMPT_PATH;
  } else {
    process.env.ICE_SYSTEM_PROMPT_PATH = originalSystemPromptPath;
  }
  resetAssembledChatPromptCache();
});

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

  it('显式 prompt 文件变化时刷新缓存', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-prompt-prewarm-'));
    const promptPath = path.join(dir, 'system-prompt.md');
    await fs.writeFile(promptPath, 'one', 'utf-8');
    process.env.ICE_SYSTEM_PROMPT_PATH = promptPath;
    resetAssembledChatPromptCache();

    const spy = vi.spyOn(
      await import('../../src/prompts/load-chat-prompt.js'),
      'loadAssembledChatPrompt',
    ).mockResolvedValue(fakePrompt);

    await getOrLoadAssembledChatPrompt('[test]');
    await fs.writeFile(promptPath, 'a longer second value', 'utf-8');
    await getOrLoadAssembledChatPrompt('[test]');

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
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
