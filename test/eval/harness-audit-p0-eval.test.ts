/**
 * Harness 审计 P0 修复的端到端 eval（脚本驱动 LLM，不打真实 API）。
 * 覆盖：工具超时 / 中止、讲解型 JSON 不执行、未知工具名不抢救、锁定工作区写边界。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import type { ChatFunction, HarnessConfig } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
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
  toolTimeout = 5_000,
): { executor: ToolExecutor; tools: ToolDefinition[] } {
  const registry = new ToolRegistry();
  const tools = Object.keys(handlers).map(makeTool);
  for (const t of tools) registry.register({ definition: t, handler: handlers[t.name]! });
  return {
    tools,
    executor: new ToolExecutor(registry, { maxRetries: 2, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout }),
  };
}

function minConfig(overrides: Partial<HarnessConfig> & { tools: ToolDefinition[] }): HarnessConfig {
  const { tools, context, loop, ...rest } = overrides;
  return {
    context: { systemPrompt: 'eval harness', tools, ...context },
    loop: { maxRounds: loop?.maxRounds ?? 20, timeout: loop?.timeout, signal: loop?.signal },
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

function toolMessage(msgs: UnifiedMessage[] | undefined, id: string): string {
  return String(msgs?.find(m => m.role === 'tool' && m.toolCallId === id)?.content ?? '');
}

const hang: ToolHandler = () => new Promise(() => {});

describe('eval: harness audit P0', () => {
  let workDir: string;

  beforeEach(async () => {
    process.env.ICE_EVAL_MODE = '1';
    workDir = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-audit-'));
  });

  afterEach(async () => {
    delete process.env.ICE_EVAL_MODE;
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('a hung tool times out once (no retry storm) and the loop continues to model_done', async () => {
    const slow = vi.fn<ToolHandler>(hang);
    const { executor, tools } = createToolExecutor({ slow_probe: slow }, 150);
    const harness = new Harness(minConfig({ tools }), executor);
    stubMemoryPersist(harness);
    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      return captured.length === 1
        ? toolCallResponse([{ id: 'p1', name: 'slow_probe' }])
        : finalResponse('探测超时，已放弃。');
    };

    const started = Date.now();
    const result = await harness.run('probe the service', chatFn);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.loopState.stopReason).toBe('model_done');
    expect(slow).toHaveBeenCalledTimes(1);
    expect(toolMessage(captured[1], 'p1')).toContain('超时');
  }, 20_000);

  it('user abort during a hung tool ends the run promptly with user_abort', async () => {
    const ac = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const { executor, tools } = createToolExecutor({
      slow_probe: (_args, _onOutput, signal) => {
        toolSignal = signal;
        setTimeout(() => ac.abort(), 50);
        return new Promise(() => {});
      },
    }, 60_000);
    const harness = new Harness(minConfig({ tools, loop: { maxRounds: 5, signal: ac.signal } }), executor);
    stubMemoryPersist(harness);

    const started = Date.now();
    const result = await harness.run('probe', async () => toolCallResponse([{ id: 'p1', name: 'slow_probe' }]));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.loopState.stopReason).toBe('user_abort');
    expect(toolSignal?.aborted).toBe(true);
  }, 20_000);

  it('an explanatory answer with a JSON example is shown, not executed', async () => {
    const write = vi.fn<ToolHandler>(async () => ({ success: true, output: 'written' }));
    const { executor, tools } = createToolExecutor({ write_file: write, read_file: async () => ({ success: true, output: '' }) });
    const harness = new Harness(minConfig({ tools }), executor);
    stubMemoryPersist(harness);
    const answer = [
      'write_file 工具用于整体覆盖写入一个文件。调用时 name 填工具名，arguments 里给出 path 与 content 两个字段。',
      'path 需要是相对工作区根目录的路径；content 是完整的新文件内容，工具不会做增量合并，所以请先读取原文件再整体写回。',
      '示例：',
      '```json',
      '{"name": "write_file", "arguments": {"path": "src/config.ts", "content": "export const x = 1;"}}',
      '```',
      '成功时返回写入字节数，失败时返回错误原因，例如父目录不存在或者文件被其他进程占用。',
    ].join('\n');

    const result = await harness.run('write_file 工具怎么用？给个调用示例', async () => finalResponse(answer));
    expect(result.loopState.stopReason).toBe('model_done');
    expect(write).not.toHaveBeenCalled();
    expect(result.content).toContain('write_file 工具用于');
  });

  it('salvages a bare JSON call for an available tool but ignores unknown tool names', async () => {
    const read = vi.fn<ToolHandler>(async () => ({ success: true, output: 'export const a = 1;' }));
    const { executor, tools } = createToolExecutor({ read_file: read });
    const harness = new Harness(minConfig({ tools }), executor);
    stubMemoryPersist(harness);
    let round = 0;
    const chatFn: ChatFunction = async () => {
      round++;
      if (round === 1) return finalResponse('{"name": "read_file", "arguments": {"path": "src/a.ts"}}');
      if (round === 2) return finalResponse('{"name": "rm_rf_everything", "arguments": {"path": "/"}}');
      return finalResponse('src/a.ts 导出了常量 a。');
    };

    const result = await harness.run('看看 src/a.ts 导出了什么', chatFn);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.loopState.stopReason).toBeTruthy();
    const names = result.messages.flatMap(m => (m.toolCalls ?? []).map(tc => tc.name));
    expect(names).not.toContain('rm_rf_everything');
  });

  it('a locked workspace blocks writes that escape it, but allows writes inside', async () => {
    const root = path.join(workDir, 'project');
    await fs.mkdir(root, { recursive: true });
    const write = vi.fn<ToolHandler>(async () => ({ success: true, output: 'written' }));
    const { executor, tools } = createToolExecutor({ write_file: write });
    const harness = new Harness(minConfig({
      tools,
      workspaceRoot: root,
      workspaceLock: { lockedRoot: root, referenceReads: [] },
    }), executor);
    stubMemoryPersist(harness);
    const captured: UnifiedMessage[][] = [];
    const chatFn: ChatFunction = async (msgs) => {
      captured.push(msgs);
      if (captured.length === 1) {
        return toolCallResponse([
          { id: 'out', name: 'write_file', args: { path: '../escaped.txt', content: 'x' } },
          { id: 'abs', name: 'write_file', args: { path: path.join(workDir, 'abs.txt'), content: 'x' } },
          { id: 'in', name: 'write_file', args: { path: 'notes.txt', content: 'x' } },
        ]);
      }
      return finalResponse('完成');
    };

    await harness.run('在项目里写 notes.txt', chatFn);
    const afterTools = captured[1];
    expect(toolMessage(afterTools, 'out')).toContain('Workspace Boundary');
    expect(toolMessage(afterTools, 'abs')).toContain('Workspace Boundary');
    expect(toolMessage(afterTools, 'in')).not.toContain('Workspace Boundary');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ path: 'notes.txt' });
  });
});
