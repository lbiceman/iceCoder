/**
 * 批次 2/3 + 记忆 model_done 写入的确定性 Harness eval。
 * 脚本驱动 LLM，不打真实 API。
 */
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import type { ChatFunction, HarnessConfig } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import type { ToolResult } from '../../src/tools/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { agentEvalCases } from '../../scripts/agent-eval-cases.js';

/** 旧实现保留完整正文的最近工具结果数；后续轮次超过它才能验证旧结果不会被裁 */
const LATER_TOOL_ROUNDS = 8;

function makeTool(name: string): ToolDefinition {
  return { name, description: `eval ${name}`, parameters: { type: 'object', properties: {} } };
}

function usage() {
  return { inputTokens: 80, outputTokens: 40, totalTokens: 120, provider: 'eval' };
}

function finalResponse(content: string): LLMResponse {
  return { content, usage: usage(), finishReason: 'stop' };
}

function toolCallResponse(
  calls: { id: string; name: string; args?: Record<string, unknown> }[],
): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: usage(),
    finishReason: 'tool_calls',
  };
}

function createToolExecutor(
  tools: ToolDefinition[],
  handler: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
): ToolExecutor {
  const registry = new ToolRegistry();
  for (const t of tools) {
    registry.register({
      definition: t,
      handler: async (args) => handler(t.name, args ?? {}),
    });
  }
  return new ToolExecutor(registry, {
    maxRetries: 0,
    retryBaseDelay: 0,
    retryMaxDelay: 0,
    toolTimeout: 5_000,
  });
}

function minConfig(overrides: Partial<HarnessConfig> & { tools: ToolDefinition[] }): HarnessConfig {
  const { tools, context, loop, ...rest } = overrides;
  return {
    context: {
      systemPrompt: 'eval harness',
      tools,
      ...context,
    },
    loop: { maxRounds: loop?.maxRounds ?? 40, timeout: loop?.timeout, signal: loop?.signal },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999_999,
    memoryDir: '__test_nonexistent_memory_dir__',
    skipPermissionChecks: true,
    ...rest,
  };
}

function stubMemoryPersist(harness: Harness) {
  const mem = (harness as unknown as {
    memoryIntegration: {
      sequentialExtract: (ctx: unknown) => Promise<void>;
      maybeUpdateSessionMemory: (...args: unknown[]) => Promise<void>;
      maybeDream: () => Promise<void>;
      memoryDream: { recordSession: () => Promise<void> };
    };
  }).memoryIntegration;
  return {
    extract: vi.spyOn(mem, 'sequentialExtract').mockResolvedValue(undefined),
    session: vi.spyOn(mem, 'maybeUpdateSessionMemory').mockResolvedValue(undefined),
    dream: vi.spyOn(mem, 'maybeDream').mockResolvedValue(undefined),
    record: vi.spyOn(mem.memoryDream, 'recordSession').mockResolvedValue(undefined),
  };
}

describe('eval: runtime skip / failed log tail / memory persist', () => {
  afterEach(() => {
    delete process.env.ICE_EVAL_MODE;
  });

  it('agent-eval catalog includes the new harness cases', () => {
    const ids = agentEvalCases.map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining([
      'noisy-test-failure-fix',
      'multi-round-runtime-stable-edit',
      'test-failure-fix',
      'local-edit-stop-runs-npm-test',
      'local-edit-stale-after-second-write',
      'local-git-diff-noise-does-not-block',
      'local-runtime-default-fail-unverified',
      'local-explicit-must-run-failed',
      'local-user-check-overrides-npm-test',
      'local-write-new-file-runs-npm-test',
      'local-engineering-edit-no-plan-unverified',
      'local-mutating-verify-command-not-fresh',
      'local-explicit-two-commands',
      'local-read-only-no-file-change',
    ]));
  });

  it('unchanged Runtime JSON is not re-attached on later LLM rounds', async () => {
    process.env.ICE_EVAL_MODE = '1';
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools, async () => ({ success: true, output: 'file-body' }));
    const harness = new Harness(minConfig({ tools }), executor);
    stubMemoryPersist(harness);
    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      if (captured.length === 1) {
        return toolCallResponse([{ id: 'r1', name: 'read_file', args: { path: 'src/a.ts' } }]);
      }
      if (captured.length === 2) {
        return toolCallResponse([{ id: 'r2', name: 'read_file', args: { path: 'src/a.ts' } }]);
      }
      return finalResponse('done');
    };

    const result = await harness.run('Read src/a.ts twice', chatFn);
    expect(result.loopState.stopReason).toBe('model_done');

    const withRuntime = (msgs: UnifiedMessage[]) => msgs.some(m =>
      typeof m.content === 'string' && m.content.includes('[System Runtime State]'),
    );
    expect(withRuntime(captured[1] ?? [])).toBe(true);
    expect(withRuntime(captured[2] ?? [])).toBe(false);
  });

  it('keeps every theme of an early theme-file read visible after many later tool calls', async () => {
    process.env.ICE_EVAL_MODE = '1';
    const themes = ['dark', 'light', 'modern', 'fresh']
      .map(t => `[data-theme="${t}"] {\n${`  --${t}-color: #101010;\n`.repeat(60)}}`)
      .join('\n\n');
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools, async (_name, args) => (
      args.path === 'src/tokens.css'
        ? { success: true, output: themes }
        : { success: true, output: `body of ${String(args.path)}` }
    ));
    const harness = new Harness(minConfig({ tools }), executor);
    stubMemoryPersist(harness);
    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      const n = captured.length;
      if (n === 1) {
        return toolCallResponse([{ id: 'theme', name: 'read_file', args: { path: 'src/tokens.css' } }]);
      }
      if (n <= 1 + LATER_TOOL_ROUNDS) {
        return toolCallResponse([{ id: `r${n}`, name: 'read_file', args: { path: `src/f${n}.ts` } }]);
      }
      return finalResponse('done');
    };

    await harness.run('List all themes in tokens.css', chatFn);

    const last = captured.at(-1) ?? [];
    const themeMsg = last.find(m => m.role === 'tool' && m.toolCallId === 'theme');
    expect(themes.length).toBeGreaterThan(3_000);
    expect(themeMsg!.content).toBe(themes);
    for (const t of ['dark', 'light', 'modern', 'fresh']) {
      expect(String(themeMsg!.content)).toContain(`[data-theme="${t}"]`);
    }
  }, 30_000);

  it('keeps head and tail of an old failed run_command after later tools', async () => {
    process.env.ICE_EVAL_MODE = '1';
    const tools = [makeTool('run_command'), makeTool('read_file')];
    const executor = createToolExecutor(tools, async (name, args) => {
      if (name === 'run_command') {
        const cmd = String(args.command ?? '');
        const id = cmd.replace(/\D/g, '') || 'x';
        const body = `HEAD-${id}\n${'noise'.repeat(12_000)}\nTAIL-${id}-STACK`;
        return { success: false, output: body, error: `Command failed (exit code: 1)` };
      }
      return { success: true, output: 'ok' };
    });
    const harness = new Harness(minConfig({ tools }), executor);
    stubMemoryPersist(harness);
    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      const n = captured.length;
      if (n <= 3) {
        return toolCallResponse([{
          id: `fail-${n - 1}`,
          name: 'run_command',
          args: { command: `npm test --fail-${n - 1}` },
        }]);
      }
      if (n <= 3 + LATER_TOOL_ROUNDS) {
        return toolCallResponse([{
          id: `read-${n}`,
          name: 'read_file',
          args: { path: `src/f${n}.ts` },
        }]);
      }
      return finalResponse('done');
    };

    const result = await harness.run('Diagnose failing tests', chatFn);
    expect(result.loopState.stopReason).toBeTruthy();
    expect(captured.length).toBeGreaterThan(3);

    const last = captured.at(-1) ?? [];
    const oldestFail = last.find(m => m.role === 'tool' && m.toolCallId === 'fail-0');
    expect(oldestFail).toBeDefined();
    const sealed = String(oldestFail!.content);
    expect(sealed).toContain('TAIL-0-STACK');
    expect(sealed).toContain('HEAD-0');
    expect(sealed).toMatch(/工具结果已裁剪|输出已截断/);
    expect(sealed.length).toBeLessThan(55_000);
  }, 30_000);

  it('spills truncated failed command output into the session dir', async () => {
    process.env.ICE_EVAL_MODE = '1';
    const sessionDir = mkdtempSync(join(tmpdir(), 'ice-eval-spill-'));
    const tools = [makeTool('run_command')];
    const huge = `HEAD-LOG\n${'x'.repeat(80_000)}\nTAIL-UNIQUE-ASSERT`;
    const executor = createToolExecutor(tools, async () => ({
      success: false,
      output: huge,
      error: 'Command failed (exit code: 1)',
    }));
    const harness = new Harness(minConfig({
      tools,
      sessionDir,
      sessionId: 'eval-spill',
    }), executor);
    stubMemoryPersist(harness);

    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      if (captured.length === 1) {
        return toolCallResponse([{ id: 'fail-big', name: 'run_command', args: { command: 'npm test' } }]);
      }
      return finalResponse('done');
    };

    await harness.run('Run tests', chatFn);
    const afterFail = captured[1] ?? [];
    const tool = afterFail.find(m => m.toolCallId === 'fail-big');
    expect(String(tool?.content)).toContain('TAIL-UNIQUE-ASSERT');
    expect(String(tool?.content)).toContain('输出已截断');
    expect(String(tool?.content)).toContain('Full output saved to:');

    const spillDir = join(sessionDir, 'tool-output', 'eval-spill');
    const files = await fs.readdir(spillDir);
    expect(files.some(f => f.startsWith('fail-big'))).toBe(true);
    const spilled = await fs.readFile(join(spillDir, files[0]!), 'utf-8');
    expect(spilled).toContain('TAIL-UNIQUE-ASSERT');
    expect(spilled.length).toBeGreaterThan(80_000);
  }, 30_000);

  it('recovers the middle of a large command output by reading its spill file', async () => {
    process.env.ICE_EVAL_MODE = '1';
    process.env.ICE_CONTEXT_WINDOW = '128000';
    const sessionDir = mkdtempSync(join(tmpdir(), 'ice-eval-spill-read-'));
    const log = Array.from({ length: 4_000 }, (_, i) => (
      i === 2_100 ? 'ERROR module=kestrel-42 checksum mismatch' : `[build] step ${i} ok: compiled module m${i}`
    )).join('\n');
    const tools = [makeTool('run_command'), makeTool('read_file')];
    const executor = createToolExecutor(tools, async (name, args) => {
      if (name === 'run_command') return { success: true, output: log };
      const text = await fs.readFile(String(args.path), 'utf-8');
      const lines = text.split('\n');
      const offset = Number(args.offset ?? 1);
      const limit = Number(args.limit ?? lines.length);
      return { success: true, output: lines.slice(offset - 1, offset - 1 + limit).join('\n') };
    });
    const harness = new Harness(minConfig({ tools, sessionDir, sessionId: 'eval-spill-read' }), executor);
    stubMemoryPersist(harness);
    const captured: UnifiedMessage[][] = [];
    let spillPath = '';
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      const n = captured.length;
      if (n === 1) return toolCallResponse([{ id: 'build', name: 'run_command', args: { command: 'node noisy.js' } }]);
      if (n === 2) {
        const view = String(msgs.find(m => m.toolCallId === 'build')?.content ?? '');
        spillPath = /Full output saved to: (\S+)/.exec(view)?.[1] ?? '';
        return toolCallResponse([{ id: 'reread', name: 'read_file', args: { path: spillPath, offset: 2_095, limit: 12 } }]);
      }
      return finalResponse('module kestrel-42');
    };

    try {
      await harness.run('Find the ERROR module', chatFn);
    } finally {
      delete process.env.ICE_CONTEXT_WINDOW;
    }

    const firstView = String(captured[1]?.find(m => m.toolCallId === 'build')?.content ?? '');
    expect(firstView).not.toContain('kestrel-42');
    expect(firstView).toContain('Total output lines: 4000');
    expect(spillPath).toMatch(/eval-spill-read[\\/]build\.log$/);
    expect(String(captured[2]?.find(m => m.toolCallId === 'reread')?.content)).toContain('ERROR module=kestrel-42');

    await new Promise(r => setTimeout(r, 50));
    const telemetry = (await fs.readFile(join(sessionDir, 'eval-spill-read.telemetry.jsonl'), 'utf-8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; reason?: string; rereadOf?: string; shapedSavedTokens?: number });
    const reread = telemetry.find(e => e.type === 'tool_result_reread');
    expect(reread).toMatchObject({ reason: 'spill', rereadOf: 'build' });
    const savings = telemetry.filter(e => e.type === 'tool_result_savings');
    expect(savings.length).toBeGreaterThanOrEqual(2);
    expect(savings.some(e => (e.shapedSavedTokens ?? 0) > 0)).toBe(true);
  }, 30_000);

  it('warns before sending when even the history alone exceeds the window', async () => {
    process.env.ICE_EVAL_MODE = '1';
    process.env.ICE_CONTEXT_WINDOW = '20000';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools, async () => ({ success: true, output: 'ok' }));
    const harness = new Harness(minConfig({
      tools,
      context: { systemPrompt: `eval harness\n${'policy line about style. '.repeat(1_200)}`, tools },
    }), executor);
    stubMemoryPersist(harness);
    try {
      await harness.run('hello', async () => finalResponse('done'));
    } finally {
      delete process.env.ICE_CONTEXT_WINDOW;
    }
    const messages = warn.mock.calls.map(args => String(args[0]));
    warn.mockRestore();
    expect(messages.some(m => m.includes('请求仍超出上下文硬上限'))).toBe(true);
  }, 30_000);

  it('Harness onLoopEnd only persists memory after model_done, not after abort', async () => {
    delete process.env.ICE_EVAL_MODE;
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools, async () => ({ success: true, output: 'ok' }));

    const doneHarness = new Harness(minConfig({ tools }), executor);
    const doneSpies = stubMemoryPersist(doneHarness);
    await doneHarness.run('finish', async () => finalResponse('ok'));
    expect(doneSpies.extract).toHaveBeenCalled();
    expect(doneSpies.session).toHaveBeenCalled();

    const ac = new AbortController();
    const abortHarness = new Harness(minConfig({
      tools,
      loop: { maxRounds: 10, signal: ac.signal },
    }), executor);
    const abortSpies = stubMemoryPersist(abortHarness);
    const abortChat: ChatFunction = async () => {
      ac.abort();
      return toolCallResponse([{ id: 't1', name: 'read_file', args: { path: 'a.ts' } }]);
    };
    const aborted = await abortHarness.run('interrupted work', abortChat);
    expect(aborted.loopState.stopReason).toBe('user_abort');
    expect(abortSpies.extract).not.toHaveBeenCalled();
    expect(abortSpies.session).not.toHaveBeenCalled();
  });
});
