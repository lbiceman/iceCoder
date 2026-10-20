/**
 * 整轮预算边界：多条工具结果累积后，最终发给模型的请求（系统提示 + 工具定义 + 历史 + 结果）
 * 不超过「窗口 − 输出预留」。脚本驱动 LLM，不打真实 API。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import type { ChatFunction, HarnessConfig } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import { estimateMessagesTokens, estimateToolsTokens } from '../../src/llm/token-estimator.js';
import type { ToolResult } from '../../src/tools/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { queueAlsoNote, resetPendingNotesForTests } from '../../src/session/pending-note.js';

const WINDOW = 40_000;
const MAX_OUTPUT = 8_000;
const LIMIT = WINDOW - MAX_OUTPUT;

function makeTool(name: string): ToolDefinition {
  return { name, description: `eval ${name}`, parameters: { type: 'object', properties: {} } };
}

function createToolExecutor(
  tools: ToolDefinition[],
  handler: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): ToolExecutor {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register({ definition: t, handler: async args => handler(t.name, args ?? {}) });
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5_000 });
}

function config(tools: ToolDefinition[], maxRounds = 20): HarnessConfig {
  return {
    context: { systemPrompt: 'eval harness', tools },
    loop: { maxRounds, maxOutputTokens: MAX_OUTPUT },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999_999,
    memoryDir: '__test_nonexistent_memory_dir__',
    skipPermissionChecks: true,
  };
}

function stubMemory(harness: Harness): void {
  const mem = (harness as unknown as {
    memoryIntegration: {
      sequentialExtract: () => Promise<void>;
      maybeUpdateSessionMemory: () => Promise<void>;
      maybeDream: () => Promise<void>;
      memoryDream: { recordSession: () => Promise<void> };
    };
  }).memoryIntegration;
  vi.spyOn(mem, 'sequentialExtract').mockResolvedValue(undefined);
  vi.spyOn(mem, 'maybeUpdateSessionMemory').mockResolvedValue(undefined);
  vi.spyOn(mem, 'maybeDream').mockResolvedValue(undefined);
  vi.spyOn(mem.memoryDream, 'recordSession').mockResolvedValue(undefined);
}

/** 每行不同，避免压缩器按重复内容估算偏低 */
function bigOutput(tag: string, lines: number): string {
  return Array.from({ length: lines }, (_, i) => `${tag} line ${i} value=${(i * 7919) % 104729} status=ok`).join('\n');
}

function requestTokens(msgs: UnifiedMessage[], tools: ToolDefinition[]): number {
  return estimateMessagesTokens(msgs) + estimateToolsTokens(tools);
}

function response(calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>, inputTokens = 80): LLMResponse {
  return {
    content: calls.length ? '' : 'done',
    ...(calls.length ? { toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })) } : {}),
    usage: { inputTokens, outputTokens: 20, totalTokens: inputTokens + 20, provider: 'eval' },
    finishReason: calls.length ? 'tool_calls' : 'stop',
  };
}

describe('whole-request budget boundary', () => {
  beforeEach(() => {
    process.env.ICE_EVAL_MODE = '1';
    process.env.ICE_CONTEXT_WINDOW = String(WINDOW);
  });
  afterEach(() => {
    delete process.env.ICE_EVAL_MODE;
    delete process.env.ICE_CONTEXT_WINDOW;
    resetPendingNotesForTests();
    vi.restoreAllMocks();
  });

  it('a parallel batch of large results never pushes the next request over the limit', async () => {
    const tools = [makeTool('run_command')];
    const outputs = new Map<string, string>();
    const executor = createToolExecutor(tools, async (_name, args) => {
      const out = bigOutput(String(args.command), 1_500);
      outputs.set(String(args.command), out);
      return { success: true, output: out };
    });
    const harness = new Harness(config(tools), executor);
    stubMemory(harness);
    const sizes: number[] = [];
    const chatFn: ChatFunction = async (msgs) => {
      sizes.push(requestTokens(msgs, tools));
      if (sizes.length === 1) {
        return response(Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: 'run_command', args: { command: `job${i}` } })));
      }
      return response([]);
    };

    const result = await harness.run('run ten jobs', chatFn);
    expect(sizes.length).toBe(2);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(LIMIT);
    // 原文仍在会话历史里，只是发给模型的视图被收紧
    for (let i = 0; i < 10; i++) {
      const tool = result.messages.find(m => m.toolCallId === `c${i}`);
      expect(tool?.content).toBe(outputs.get(`job${i}`));
    }
  }, 30_000);

  it('results accumulated over many rounds keep every request under the limit', async () => {
    const tools = [makeTool('run_command')];
    const executor = createToolExecutor(tools, async (_name, args) => ({
      success: true, output: bigOutput(String(args.command), 900),
    }));
    const harness = new Harness(config(tools, 30), executor);
    stubMemory(harness);
    const sizes: number[] = [];
    const chatFn: ChatFunction = async (msgs) => {
      sizes.push(requestTokens(msgs, tools));
      const n = sizes.length;
      if (n <= 12) return response([{ id: `r${n}`, name: 'run_command', args: { command: `step${n}` } }]);
      return response([]);
    };

    await harness.run('run twelve steps', chatFn);
    expect(sizes.length).toBe(13);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(LIMIT);
  }, 60_000);

  it('many small results after the room is gone are shrunk instead of overflowing', async () => {
    const tools = [makeTool('run_command')];
    const executor = createToolExecutor(tools, async (_name, args) => (
      String(args.command) === 'big'
        ? { success: true, output: bigOutput('big', 2_500) }
        : { success: true, output: bigOutput(String(args.command), 25) }
    ));
    const harness = new Harness(config(tools), executor);
    stubMemory(harness);
    const sizes: number[] = [];
    const chatFn: ChatFunction = async (msgs) => {
      sizes.push(requestTokens(msgs, tools));
      if (sizes.length === 1) {
        return response([
          { id: 'big', name: 'run_command', args: { command: 'big' } },
          ...Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, name: 'run_command', args: { command: `small${i}` } })),
        ]);
      }
      return response([]);
    };

    await harness.run('one big then sixty small', chatFn);
    expect(sizes.length).toBe(2);
    expect(sizes[1]).toBeLessThanOrEqual(LIMIT);
  }, 30_000);

  it('calibrates against provider prompt tokens when the local estimate runs low', async () => {
    const tools = [makeTool('run_command')];
    const executor = createToolExecutor(tools, async (_name, args) => ({
      success: true, output: bigOutput(String(args.command), 700),
    }));
    const harness = new Harness(config(tools, 30), executor);
    stubMemory(harness);
    const sizes: number[] = [];
    const ratio = 1.6;
    const chatFn: ChatFunction = async (msgs) => {
      const est = requestTokens(msgs, tools);
      sizes.push(est);
      const n = sizes.length;
      const reported = Math.ceil(est * ratio);
      if (n <= 3) {
        return response(
          Array.from({ length: 8 }, (_, i) => ({ id: `k${n}_${i}`, name: 'run_command', args: { command: `k${n}_${i}` } })),
          reported,
        );
      }
      return response([], reported);
    };

    await harness.run('provider counts more than we estimate', chatFn);
    expect(sizes.length).toBe(4);
    // 首轮没有校准数据；之后每一次按 provider 口径（估算 × 1.6）也不能超
    for (const est of sizes.slice(1)) {
      expect(Math.ceil(est * ratio)).toBeLessThanOrEqual(LIMIT);
    }
  }, 60_000);

  function queuedNoteRun(harness: Harness, tools: ToolDefinition[], pasted: string, providerRatio = 1) {
    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      const est = Math.ceil(requestTokens(msgs, tools) * providerRatio);
      if (captured.length === 1) {
        queueAlsoNote('default', { text: `Also look at this log:\n${pasted}`, runId: 1, messageId: 'm1' });
        return response(Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, name: 'run_command', args: { command: `q${i}` } })), est);
      }
      return response([], est);
    };
    return { captured, run: () => harness.run('run six jobs', chatFn) };
  }

  function jobExecutor(tools: ToolDefinition[], lines: number): ToolExecutor {
    return createToolExecutor(tools, async (_name, args) => ({
      success: true, output: bigOutput(String(args.command), lines),
    }));
  }

  it('content queued after tools ran is absorbed by compaction without losing the note', async () => {
    const tools = [makeTool('run_command')];
    const harness = new Harness(config(tools), jobExecutor(tools, 1_200));
    stubMemory(harness);
    const pasted = bigOutput('pasted-log', 2_500);
    const { captured, run } = queuedNoteRun(harness, tools, pasted);

    await run();
    expect(captured.length).toBe(2);
    const second = captured[1]!;
    expect(second.some(m => typeof m.content === 'string' && m.content.includes('pasted-log line 2499 '))).toBe(true);
    expect(requestTokens(second, tools)).toBeLessThanOrEqual(LIMIT);
  }, 30_000);

  /** 例如 fork 后首轮跳过压缩：只剩发送前总量检查兜底 */
  function skipCompaction(harness: Harness): void {
    const compactor = (harness as unknown as { contextCompactor: object }).contextCompactor as {
      needsCompaction: () => boolean;
      needsMicroCompaction: () => boolean;
    };
    vi.spyOn(compactor, 'needsCompaction').mockReturnValue(false);
    vi.spyOn(compactor, 'needsMicroCompaction').mockReturnValue(false);
  }

  it.each([
    { label: 'local estimate matches the provider', ratio: 1 },
    { label: 'provider counts 1.6x the local estimate', ratio: 1.6 },
  ])('when compaction is skipped this round, the pre-send guard shrinks unsent results to fit ($label)', async ({ ratio }) => {
    const tools = [makeTool('run_command')];
    const outputs = new Map<string, string>();
    const executor = createToolExecutor(tools, async (_name, args) => {
      const out = bigOutput(String(args.command), 1_200);
      outputs.set(String(args.command), out);
      return { success: true, output: out };
    });
    const harness = new Harness(config(tools), executor);
    stubMemory(harness);
    skipCompaction(harness);
    const { captured, run } = queuedNoteRun(harness, tools, bigOutput('pasted-log', 900), ratio);

    const result = await run();
    expect(captured.length).toBe(2);
    const second = captured[1]!;
    expect(Math.ceil(requestTokens(second, tools) * ratio)).toBeLessThanOrEqual(LIMIT);
    expect(second.some(m => typeof m.content === 'string' && m.content.includes('pasted-log line 899 '))).toBe(true);
    const shrunk = result.messages.filter(m => String(m.apiSealedContent ?? '').includes('omitted before sending'));
    expect(shrunk.length).toBeGreaterThan(0);
    for (const m of shrunk) {
      expect(m.apiSealedContent).toContain('This is NOT the tool output');
      expect(m.toolResultMeta?.strategy).toBe('omitted');
      expect(m.content).toBe(outputs.get(m.toolCallId!));
    }
  }, 30_000);

  it('a read of a huge file under low room is paged, not dropped, and stays under the limit', async () => {
    const tools = [makeTool('read_file'), makeTool('run_command')];
    const file = bigOutput('css', 4_000);
    const executor = createToolExecutor(tools, async (name) => (
      name === 'read_file' ? { success: true, output: file } : { success: true, output: bigOutput('pre', 1_400) }
    ));
    const harness = new Harness(config(tools), executor);
    stubMemory(harness);
    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      if (captured.length === 1) return response([{ id: 'pre', name: 'run_command', args: { command: 'pre' } }]);
      if (captured.length === 2) return response([{ id: 'read', name: 'read_file', args: { path: 'src/huge.css' } }]);
      return response([]);
    };

    const result = await harness.run('read the huge file', chatFn);
    for (const msgs of captured) expect(requestTokens(msgs, tools)).toBeLessThanOrEqual(LIMIT);
    const view = String(captured[2]?.find(m => m.toolCallId === 'read')?.content ?? '');
    expect(view.length).toBeGreaterThan(0);
    expect(view.length).toBeLessThan(file.length);
    expect(result.messages.find(m => m.toolCallId === 'read')?.content).toBe(file);
  }, 30_000);
});

describe('large output reserve', () => {
  const BIG_WINDOW = 100_000;
  const BIG_OUTPUT = 40_000;
  const BIG_LIMIT = BIG_WINDOW - BIG_OUTPUT;

  beforeEach(() => {
    process.env.ICE_EVAL_MODE = '1';
    process.env.ICE_CONTEXT_WINDOW = String(BIG_WINDOW);
  });
  afterEach(() => {
    delete process.env.ICE_EVAL_MODE;
    delete process.env.ICE_CONTEXT_WINDOW;
    vi.restoreAllMocks();
  });

  it('compaction frees room before the output reserve is reached, so new results stay visible', async () => {
    const tools = [makeTool('run_command')];
    const executor = createToolExecutor(tools, async (_name, args) => ({
      success: true, output: bigOutput(String(args.command), 900),
    }));
    const cfg = config(tools, 30);
    cfg.loop.maxOutputTokens = BIG_OUTPUT;
    const harness = new Harness(cfg, executor);
    stubMemory(harness);
    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      const n = captured.length;
      const est = requestTokens(msgs, tools);
      if (n <= 14) return response([{ id: `r${n}`, name: 'run_command', args: { command: `step${n}` } }], est);
      return response([], est);
    };

    await harness.run('run fourteen steps', chatFn);
    expect(captured.length).toBe(15);
    for (let n = 2; n <= captured.length; n++) {
      const msgs = captured[n - 1]!;
      expect(requestTokens(msgs, tools)).toBeLessThanOrEqual(BIG_LIMIT);
      const latest = msgs.find(m => m.toolCallId === `r${n - 1}`);
      expect(latest?.toolResultMeta?.strategy, `round ${n} sees step${n - 1}`).not.toBe('omitted');
      expect(String(latest?.content)).toContain(`step${n - 1} line 0 `);
    }
  }, 60_000);
});
