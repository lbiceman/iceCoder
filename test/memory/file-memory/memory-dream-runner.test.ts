import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LLMAdapterInterface } from '../../../src/llm/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('memory-dream-runner manual queue', () => {
  let tempDir: string;
  let prevMemoryDir: string | undefined;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-dream-runner-'));
    prevMemoryDir = process.env.ICE_MEMORY_DIR;
    prevDataDir = process.env.ICE_DATA_DIR;
    process.env.ICE_MEMORY_DIR = tempDir;
    process.env.ICE_DATA_DIR = path.join(tempDir, 'runtime');
    await fs.mkdir(tempDir, { recursive: true });
    vi.resetModules();
    const { resetDreamRunnerChainForTests } = await import(
      '../../../src/memory/file-memory/memory-dream-runner.js'
    );
    resetDreamRunnerChainForTests();
  });

  afterEach(async () => {
    if (prevMemoryDir === undefined) delete process.env.ICE_MEMORY_DIR;
    else process.env.ICE_MEMORY_DIR = prevMemoryDir;
    if (prevDataDir === undefined) delete process.env.ICE_DATA_DIR;
    else process.env.ICE_DATA_DIR = prevDataDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('连续 scheduleManualDreamLlm 串行入队，第二次空跑退避', async () => {
    const notePath = path.join(tempDir, 'feedback_test.md');
    await fs.writeFile(
      notePath,
      `---
name: test
description: test feedback
type: feedback
memoryCategory: recurring_mistake
confidence: 0.9
---
content`,
      'utf-8',
    );

    const mockLLM: LLMAdapterInterface = {
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          actions: [],
          new_index: null,
          file_writes: [],
          file_deletes: [],
          summary: 'No changes needed.',
        }),
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'test' },
        finishReason: 'stop',
      })),
      stream: vi.fn(),
      countTokens: vi.fn(async () => 10),
    };

    const { scheduleManualDreamLlm, getDreamJobStatus } = await import(
      '../../../src/memory/file-memory/memory-dream-runner.js'
    );

    expect(scheduleManualDreamLlm({
      memoryDir: tempDir,
      llmAdapter: mockLLM,
      fileCountBefore: 1,
      preEvicted: 0,
    })).toBe(true);
    expect(scheduleManualDreamLlm({
      memoryDir: tempDir,
      llmAdapter: mockLLM,
      fileCountBefore: 1,
      preEvicted: 0,
    })).toBe(true);

    await new Promise((r) => setTimeout(r, 3000));

    const status = getDreamJobStatus();
    expect(status.running).toBe(false);
    expect(status.lastSummary).toMatch(/dream_empty_backoff/);
    expect(status.lastExecuted).toBe(false);
  });

  it('无 LLM 时手动整合优雅降级 no_llm，且不触发空跑退避', async () => {
    const { scheduleManualDreamLlm, getDreamJobStatus } = await import(
      '../../../src/memory/file-memory/memory-dream-runner.js'
    );

    expect(scheduleManualDreamLlm({
      memoryDir: tempDir,
      llmAdapter: null as never,
      fileCountBefore: 0,
      preEvicted: 0,
    })).toBe(true);

    await new Promise((r) => setTimeout(r, 1000));

    const status = getDreamJobStatus();
    expect(status.running).toBe(false);
    expect(status.lastExecuted).toBe(false);
    expect(status.lastSummary).toMatch(/No LLM adapter/);

    // 连续第二次：no_llm 不应计入空跑退避，仍能进入 Dream 入口
    expect(scheduleManualDreamLlm({
      memoryDir: tempDir,
      llmAdapter: null as never,
      fileCountBefore: 0,
      preEvicted: 0,
    })).toBe(true);

    await new Promise((r) => setTimeout(r, 1000));
    const status2 = getDreamJobStatus();
    expect(status2.running).toBe(false);
    expect(status2.lastSummary).toMatch(/No LLM adapter/);
    expect(status2.lastSummary).not.toMatch(/dream_empty_backoff/);
  });

  it('无 LLM + 记忆目录不存在：快路径不扫描不抛错（手动）', async () => {
    const { scheduleManualDreamLlm, getDreamJobStatus } = await import(
      '../../../src/memory/file-memory/memory-dream-runner.js'
    );

    // 目录不存在：若走正常路径 evaluateDreamGate 会扫描并可能抛错/耗时；快路径应直接跳过
    expect(scheduleManualDreamLlm({
      memoryDir: path.join(tempDir, 'no-such-dir'),
      llmAdapter: null as never,
      fileCountBefore: 0,
      preEvicted: 0,
    })).toBe(true);

    await new Promise((r) => setTimeout(r, 1000));
    const status = getDreamJobStatus();
    expect(status.running).toBe(false);
    expect(status.lastExecuted).toBe(false);
    expect(status.lastSummary).toMatch(/No LLM adapter/);
  });

  it('无 LLM 时自动整合快路径跳过，不触发空跑退避', async () => {
    const { scheduleAutoDream, getDreamJobStatus } = await import(
      '../../../src/memory/file-memory/memory-dream-runner.js'
    );

    expect(scheduleAutoDream({
      memoryDir: path.join(tempDir, 'no-such-dir'),
      llmAdapter: null as never,
      conversationPrefix: undefined,
      dreamGateTrigger: null,
      fileCountBefore: 0,
    })).toBe(true);

    await new Promise((r) => setTimeout(r, 1000));
    const status = getDreamJobStatus();
    expect(status.running).toBe(false);
    expect(status.lastExecuted).toBe(false);
    expect(status.lastSummary).toMatch(/No LLM adapter/);
    expect(status.lastSummary).not.toMatch(/dream_empty_backoff/);
  });
});
