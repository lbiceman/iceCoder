/**
 * Harness 审计 P4（#89 见 task-graph.test.ts，本文件覆盖 #92）。
 * 静默失败要打 warn，并写入 failure telemetry。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { spillToolOutputToSession } from '../../src/harness/tool-output-spill.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

let tmp: string;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function isolatedSession(): Promise<{ root: string; sessionDir: string; telemetryPath: string }> {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-audit-p4-'));
  const sessionDir = path.join(tmp, 'sessions', 's1');
  await fs.mkdir(sessionDir, { recursive: true });
  return {
    root: tmp,
    sessionDir,
    telemetryPath: path.join(sessionDir, 's1.telemetry.jsonl'),
  };
}

describe('#92 静默失败补日志', () => {
  it('工具输出落盘失败时 warn 并写入 telemetry，仍返回 null', async () => {
    const prevRuntimeDir = process.env.ICE_RUNTIME_DIR;
    delete process.env.ICE_RUNTIME_DIR;
    const { sessionDir } = await isolatedSession();
    await fs.writeFile(path.join(sessionDir, 'tool-output'), 'x', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const file = await spillToolOutputToSession({
        sessionDir,
        sessionId: 's1',
        toolCallId: 'tc-1',
        content: 'FULL',
      });

      expect(file).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[harness] tool_output_spill failed:',
        expect.any(String),
      );
      const telemetryPath = path.join(sessionDir, 's1.telemetry.jsonl');
      const event = JSON.parse(await fs.readFile(telemetryPath, 'utf8'));
      expect(event).toMatchObject({
        type: 'failure',
        source: 'tool_output_spill',
        sessionId: 's1',
      });
      expect(event.message).toEqual(expect.any(String));
      expect(event.message.length).toBeGreaterThan(0);
    } finally {
      if (prevRuntimeDir === undefined) delete process.env.ICE_RUNTIME_DIR;
      else process.env.ICE_RUNTIME_DIR = prevRuntimeDir;
    }
  });

  it('LLM 摘要抛错时回退结构化摘要，并记录 warn 与 telemetry', async () => {
    const prevRuntimeDir = process.env.ICE_RUNTIME_DIR;
    delete process.env.ICE_RUNTIME_DIR;
    const { sessionDir, telemetryPath } = await isolatedSession();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const compactor = new ContextCompactor({
      enableLLMSummary: true,
      keepRecent: 2,
      keepRecentMinMessages: 2,
      keepRecentMinTokens: 1,
      keepRecentMaxTokens: 100_000,
      sessionId: 's1',
      sessionDir,
    });
    const messages: UnifiedMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'user',
      content: `note ${i}`,
    }));

    try {
      const compacted = await compactor.compact(
        messages,
        async () => {
          throw new Error('summarizer down');
        },
        undefined,
        { forceFullCompact: true },
      );

      expect(compacted.some(message => String(message.content).includes('<context-summary>'))).toBe(true);
      expect(warn).toHaveBeenCalledWith('[harness] llm_summarize failed:', 'summarizer down');
      const event = JSON.parse(await fs.readFile(telemetryPath, 'utf8'));
      expect(event).toMatchObject({
        type: 'failure',
        source: 'llm_summarize',
        sessionId: 's1',
        message: 'summarizer down',
      });
    } finally {
      if (prevRuntimeDir === undefined) delete process.env.ICE_RUNTIME_DIR;
      else process.env.ICE_RUNTIME_DIR = prevRuntimeDir;
    }
  });
});
