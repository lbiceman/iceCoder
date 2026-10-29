/**
 * Harness 审计 P2 的端到端 eval（脚本驱动 LLM，不打真实 API）。
 * 覆盖：命令清单差分、checkpoint 单次紧凑落盘、压缩占用快照、
 * 嵌入工具一次解析仍可执行、永久错误不重试。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { readEffectiveContextWindowTokens } from '../../src/harness/context-window-tier.js';
import { buildMessagesForLlm } from '../../src/harness/harness-api-messages.js';
import {
  diffInventoryTouchedPaths,
  listWorkspaceFileInventory,
} from '../../src/harness/workspace-command-touch.js';
import type { ChatFunction, HarnessConfig } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import { resolveCompactionUsage } from '../../src/llm/token-estimator.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolCall } from '../../src/llm/types.js';
import type { ToolHandler } from '../../src/tools/types.js';

function makeTool(name: string): ToolDefinition {
  return { name, description: `eval ${name}`, parameters: { type: 'object', properties: {} } };
}

function usage() {
  return { inputTokens: 80, outputTokens: 40, totalTokens: 120, provider: 'eval' };
}

function finalResponse(content: string): LLMResponse {
  return { content, usage: usage(), finishReason: 'stop' };
}

function toolCallResponse(calls: { id: string; name: string; args?: Record<string, unknown> }[]): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: usage(),
    finishReason: 'tool_calls',
  };
}

function createToolExecutor(
  handlers: Record<string, ToolHandler>,
  options?: { maxRetries?: number; retryBaseDelay?: number; toolTimeout?: number },
): { executor: ToolExecutor; tools: ToolDefinition[] } {
  const registry = new ToolRegistry();
  const tools = Object.keys(handlers).map(makeTool);
  for (const t of tools) registry.register({ definition: t, handler: handlers[t.name]! });
  return {
    tools,
    executor: new ToolExecutor(registry, {
      maxRetries: options?.maxRetries ?? 2,
      retryBaseDelay: options?.retryBaseDelay ?? 0,
      retryMaxDelay: options?.retryBaseDelay ?? 0,
      toolTimeout: options?.toolTimeout ?? 5_000,
    }),
  };
}

function minConfig(overrides: Partial<HarnessConfig> & { tools: ToolDefinition[] }): HarnessConfig {
  const { tools, context, loop, ...rest } = overrides;
  return {
    context: { systemPrompt: 'eval harness', tools, ...context },
    loop: { maxRounds: loop?.maxRounds ?? 8, timeout: loop?.timeout, signal: loop?.signal },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999_999,
    memoryDir: '__test_nonexistent_memory_dir__',
    skipPermissionChecks: true,
    ...rest,
  };
}

function stubMemoryPersist(harness: Harness): void {
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

describe('eval: harness audit P2', () => {
  let workDir: string;
  const origWindow = process.env.ICE_CONTEXT_WINDOW;
  const origConfig = process.env.ICE_CONFIG_PATH;

  beforeEach(async () => {
    process.env.ICE_EVAL_MODE = '1';
    workDir = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-p2-'));
  });

  afterEach(async () => {
    delete process.env.ICE_EVAL_MODE;
    if (origWindow === undefined) delete process.env.ICE_CONTEXT_WINDOW;
    else process.env.ICE_CONTEXT_WINDOW = origWindow;
    if (origConfig === undefined) delete process.env.ICE_CONFIG_PATH;
    else process.env.ICE_CONFIG_PATH = origConfig;
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('reuses file metadata so a second full inventory does not reread unchanged files', async () => {
    const root = path.join(workDir, 'repo');
    await fs.mkdir(root);
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      fs.writeFile(path.join(root, `keep-${index}.txt`), `body-${index}`, 'utf8'),
    ));

    const first = await listWorkspaceFileInventory(root);
    expect(first.size).toBe(40);
    expect(first.contentReads).toBe(40);

    const second = await listWorkspaceFileInventory(root, { baseline: first });
    expect(second.contentReads).toBe(0);
    expect(diffInventoryTouchedPaths(root, first, second).changed).toEqual([]);

    await fs.writeFile(path.join(root, 'keep-0.txt'), 'edited', 'utf8');
    const third = await listWorkspaceFileInventory(root, { baseline: second });
    expect(third.contentReads).toBe(1);
    expect(diffInventoryTouchedPaths(root, second, third).changed).toContain('keep-0.txt');

    const scoped = await listWorkspaceFileInventory(root, {
      scopeRelPaths: ['keep-3.txt'],
      baseline: third,
    });
    expect([...scoped.keys()]).toEqual(['keep-3.txt']);
    expect(scoped.contentReads).toBe(0);
  });

  it('a shell command with a redirect only needs the target, and an opaque command still sees new files', async () => {
    const root = path.join(workDir, 'ws');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'stay.txt'), 'stay', 'utf8');
    const write = vi.fn<ToolHandler>(async (args) => {
      const command = String(args.command ?? '');
      if (command.includes('made.txt')) {
        await fs.writeFile(path.join(root, 'made.txt'), 'made', 'utf8');
      } else {
        await fs.writeFile(path.join(root, 'side.txt'), 'side', 'utf8');
      }
      return { success: true, output: 'ok' };
    });
    const { executor, tools } = createToolExecutor({ run_command: write });
    const harness = new Harness(minConfig({ tools, workspaceRoot: root }), executor);
    stubMemoryPersist(harness);
    let round = 0;
    const chatFn: ChatFunction = async () => {
      round += 1;
      if (round === 1) {
        return toolCallResponse([{ id: 'c1', name: 'run_command', args: { command: 'echo hi > made.txt' } }]);
      }
      if (round === 2) {
        return toolCallResponse([{ id: 'c2', name: 'run_command', args: { command: 'node build.js' } }]);
      }
      return finalResponse('两个文件都写好了。');
    };

    const result = await harness.run('把结果写到工作区', chatFn);
    expect(result.loopState.stopReason).toBe('model_done');
    expect(await fs.readFile(path.join(root, 'made.txt'), 'utf8')).toBe('made');
    expect(await fs.readFile(path.join(root, 'side.txt'), 'utf8')).toBe('side');
    const after = await listWorkspaceFileInventory(root);
    expect(after.has('made.txt')).toBe(true);
    expect(after.has('side.txt')).toBe(true);
    expect(after.has('stay.txt')).toBe(true);
  });

  it('folds the end-of-run resilience checkpoint into one compact JSON write', async () => {
    const sessionDir = path.join(workDir, 'session');
    await fs.mkdir(sessionDir);
    const { executor, tools } = createToolExecutor({
      read_file: async () => ({ success: true, output: 'ok' }),
    });
    const harness = new Harness(minConfig({ tools, sessionDir, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);

    const result = await harness.run('用一句话说明当前目录里有什么', async () => finalResponse('目录是空的。'));
    expect(result.loopState.stopReason).toBe('model_done');

    const checkpointPath = path.join(sessionDir, 'default.checkpoint.json');
    const raw = await fs.readFile(checkpointPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.slice(0, -1).includes('\n')).toBe(false);
    const parsed = JSON.parse(raw) as {
      snapshotMeta: { sequence: number; producer: string };
      extensions: { runtimeResilience?: unknown };
    };
    expect(parsed.snapshotMeta.sequence).toBe(1);
    expect(parsed.snapshotMeta.producer).toBe('checkpoint-engine');
    expect(parsed.extensions.runtimeResilience).toBeTruthy();
  });

  it('honors a precomputed compaction usage snapshot and caches the context window', async () => {
    const compactor = new ContextCompactor({ tokenThreshold: undefined });
    const tiny: UnifiedMessage[] = [{ role: 'user', content: 'hi' }];
    const high = resolveCompactionUsage({ messages: tiny });
    high.effectiveUsed = 180_000;
    expect(compactor.needsCompaction(tiny, {
      usage: high,
      contextWindowTokens: 200_000,
    })).toBe(true);
    expect(compactor.needsCompaction(tiny, { contextWindowTokens: 200_000 })).toBe(false);

    const configPath = path.join(workDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      providers: [{ id: 'eval', isDefault: true, maxContextTokens: 256_000, modelName: 'eval' }],
    }), 'utf8');
    delete process.env.ICE_CONTEXT_WINDOW;
    process.env.ICE_CONFIG_PATH = configPath;
    expect(readEffectiveContextWindowTokens()).toBe(256_000);
    await fs.writeFile(configPath, JSON.stringify({
      providers: [{ id: 'eval', isDefault: true, maxContextTokens: 64_000, modelName: 'eval' }],
    }), 'utf8');
    expect(readEffectiveContextWindowTokens()).toBe(256_000);
    process.env.ICE_CONTEXT_WINDOW = '32000';
    expect(readEffectiveContextWindowTokens()).toBe(32_000);
  });

  it('still executes a bare embedded tool call after parsing the body once', async () => {
    const read = vi.fn<ToolHandler>(async () => ({ success: true, output: 'file-body' }));
    const { executor, tools } = createToolExecutor({ read_file: read });
    const harness = new Harness(minConfig({ tools }), executor);
    stubMemoryPersist(harness);
    let round = 0;
    const chatFn: ChatFunction = async () => {
      round += 1;
      if (round === 1) {
        return finalResponse('<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>');
      }
      return finalResponse('读完了。');
    };
    const result = await harness.run('读 a.ts', chatFn);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('keeps tool results beside their assistant call in the API view', () => {
    const view = buildMessagesForLlm([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc', name: 'read_file', arguments: { path: 'a.ts' } }],
      },
      { role: 'user', content: '<resume-checkpoint>\nnext\n</resume-checkpoint>' },
      { role: 'tool', toolCallId: 'tc', content: 'body' },
    ]);
    const assistant = view.findIndex(message => message.role === 'assistant');
    expect(view[assistant + 1]?.role).toBe('tool');
    expect(view[assistant + 1]?.toolCallId).toBe('tc');
  });

  it('does not retry a permanent tool error, but retries a dropped connection', async () => {
    const permanent = vi.fn<ToolHandler>(() => {
      throw new TypeError('The "path" argument must be of type string. Received undefined');
    });
    const { executor, tools } = createToolExecutor({ bad_tool: permanent }, { maxRetries: 3, retryBaseDelay: 0 });
    const harness = new Harness(minConfig({ tools }), executor);
    stubMemoryPersist(harness);
    let round = 0;
    const result = await harness.run('调用工具', async () => {
      round += 1;
      return round === 1
        ? toolCallResponse([{ id: 'b1', name: 'bad_tool' }])
        : finalResponse('参数不对，停止。');
    });
    expect(permanent).toHaveBeenCalledTimes(1);
    expect(result.loopState.stopReason).toBe('model_done');

    let attempts = 0;
    const flaky = vi.fn<ToolHandler>(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return { success: true, output: 'recovered' };
    });
    const retry = createToolExecutor({ flaky_tool: flaky }, { maxRetries: 3, retryBaseDelay: 0 });
    const call: ToolCall = { id: 'f1', name: 'flaky_tool', arguments: {} };
    const recovered = await retry.executor.executeTool(call);
    expect(attempts).toBe(3);
    expect(recovered.success).toBe(true);
  });

  it('stops retry backoff immediately when the caller aborts', async () => {
    const ac = new AbortController();
    const flaky = vi.fn<ToolHandler>(async () => {
      setTimeout(() => ac.abort(), 20);
      throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    });
    const { executor } = createToolExecutor(
      { flaky_tool: flaky },
      { maxRetries: 3, retryBaseDelay: 5_000 },
    );
    const started = Date.now();
    const result = await executor.executeTool(
      { id: 'f2', name: 'flaky_tool', arguments: {} },
      undefined,
      ac.signal,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(flaky).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toContain('中止');
  });
});
