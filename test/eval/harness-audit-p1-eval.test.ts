/**
 * Harness 审计 P1（#10–#18 完成判定 / 停止）的端到端 eval（脚本驱动 LLM，不打真实 API）。
 * 每条场景都在修复前的代码上失败：要么提前标 completed，要么卡在旧失败上，要么丢结果。
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
import type { ToolHandler, ToolResult } from '../../src/tools/types.js';

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

function createToolExecutor(handlers: Record<string, ToolHandler>): { executor: ToolExecutor; tools: ToolDefinition[] } {
  const registry = new ToolRegistry();
  const tools = Object.keys(handlers).map(makeTool);
  for (const t of tools) registry.register({ definition: t, handler: handlers[t.name]! });
  return {
    tools,
    executor: new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 10_000 }),
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

function scripted(responses: LLMResponse[]): ChatFunction & { inputs: UnifiedMessage[][] } {
  const inputs: UnifiedMessage[][] = [];
  const fn = (async (msgs: UnifiedMessage[]) => {
    inputs.push([...msgs]);
    return responses[inputs.length - 1] ?? finalResponse('unexpected extra LLM round');
  }) as ChatFunction & { inputs: UnifiedMessage[][] };
  fn.inputs = inputs;
  return fn;
}

function countUserMessagesContaining(msgs: UnifiedMessage[], needle: string): number {
  return msgs.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes(needle)).length;
}

function toolMessage(msgs: UnifiedMessage[], id: string): string {
  return String(msgs.find(m => m.role === 'tool' && m.toolCallId === id)?.content ?? '');
}

describe('eval: harness audit P1 (completion / stopping)', () => {
  let workDir: string;

  beforeEach(async () => {
    process.env.ICE_EVAL_MODE = '1';
    workDir = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-audit-p1-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(async () => {
    delete process.env.ICE_EVAL_MODE;
    vi.restoreAllMocks();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function fileTools(extra: Record<string, ToolHandler> = {}) {
    const write = vi.fn<ToolHandler>(async (args) => {
      const target = path.join(workDir, String(args.path));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(args.content ?? ''), 'utf8');
      return { success: true, output: `written ${String(args.path)}` };
    });
    const read = vi.fn<ToolHandler>(async (args) => ({
      success: true,
      output: await fs.readFile(path.join(workDir, String(args.path)), 'utf8').catch(() => ''),
    }));
    return { write, read, ...createToolExecutor({ write_file: write, read_file: read, ...extra }) };
  }

  it('#10 after reading sources, "已整理好" without a file triggers one self-check and the model writes the file', async () => {
    await fs.writeFile(path.join(workDir, 'README.md'), '# Demo\nA tiny demo project.\n', 'utf8');
    const { write, executor, tools } = fileTools();
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    const llm = scripted([
      toolCallResponse([{ id: 'r1', name: 'read_file', args: { path: 'README.md' } }]),
      finalResponse('已整理好。'),
      toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'notes.md', content: '# Notes\nA tiny demo project.\n' } }]),
      finalResponse('notes.md 已写入。'),
    ]);

    const result = await harness.run('把 README.md 的要点整理成 notes.md 文档保存到项目根目录', llm);

    expect(write).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(workDir, 'notes.md'), 'utf8')).toContain('A tiny demo project');
    expect(llm.inputs).toHaveLength(4);
    expect(countUserMessagesContaining(llm.inputs[2]!, 'Completion Check')).toBe(1);
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.completionStatus).toBe('completed');
    expect(result.content).toBe('notes.md 已写入。');
  });

  it('#10 when the model still stops after the self-check, its decision ends the turn (no extra nudges)', async () => {
    const { write, executor, tools } = fileTools();
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    const llm = scripted([
      finalResponse('已整理好。'),
      finalResponse('桌面路径不在可写范围内，没有保存文件；要点已列在上面，请告诉我可写的目录。'),
    ]);

    const result = await harness.run('把会议要点整理成 md 文档放到桌面', llm);

    expect(write).not.toHaveBeenCalled();
    expect(llm.inputs).toHaveLength(2);
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.completionStatus).toBe('completed');
    expect(result.content).toContain('请告诉我可写的目录');
    expect(countUserMessagesContaining(result.messages, 'Completion Check')).toBe(1);
  });

  it('#11 a failed edit that the model routes around does not turn the finished task into failed', async () => {
    const edit = vi.fn<ToolHandler>(async () => ({ success: false, output: '', error: 'search text not found' }));
    const { executor, tools } = fileTools({ edit_file: edit });
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    const llm = scripted([
      toolCallResponse([{ id: 'e1', name: 'edit_file', args: { path: 'src/config.ts', search: 'debug: false', replace: 'debug: true' } }]),
      toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'src/config.local.ts', content: 'export const debug = true;\n' } }]),
      finalResponse('原文件里没有 debug 字段，改为新建 src/config.local.ts 覆盖配置。'),
    ]);

    const result = await harness.run('打开调试开关', llm);

    expect(edit).toHaveBeenCalledOnce();
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.completionStatus).not.toBe('failed');
    expect(result.completionReason).not.toBe('operation_write_failed');
  });

  it('#13 repeatedly rejected writes trip the circuit breaker instead of counting as progress', async () => {
    const onConfirm = vi.fn(async () => false);
    const { write, executor, tools } = fileTools();
    const harness = new Harness(minConfig({
      tools,
      workspaceRoot: workDir,
      loop: { maxRounds: 25 },
      skipPermissionChecks: false,
      permissions: [{ pattern: 'write_file', permission: 'confirm' }],
      onConfirm,
    }), executor);
    stubMemoryPersist(harness);
    let n = 0;
    const llm: ChatFunction = async () => {
      n++;
      return toolCallResponse([{ id: `w${n}`, name: 'write_file', args: { path: `src/a${n}.ts`, content: 'x' } }]);
    };

    const result = await harness.run('写入 src/a.ts', llm);

    expect(write).not.toHaveBeenCalled();
    expect(result.loopState.stopReason).toBe('circuit_breaker');
    expect(onConfirm.mock.calls.length).toBeLessThan(25);
  });

  it('#14 aborting during a slow tool keeps the result of a tool that already finished', async () => {
    const ac = new AbortController();
    const slow: ToolHandler = () => {
      setTimeout(() => ac.abort(), 50);
      return new Promise(() => {});
    };
    const { write, executor, tools } = fileTools({ slow_probe: slow });
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir, loop: { maxRounds: 5, signal: ac.signal } }), executor);
    stubMemoryPersist(harness);

    const result = await harness.run('写 notes.txt 再探测服务', async () => toolCallResponse([
      { id: 'w1', name: 'write_file', args: { path: 'notes.txt', content: 'hello' } },
      { id: 'p1', name: 'slow_probe' },
    ]));

    expect(result.loopState.stopReason).toBe('user_abort');
    expect(write).toHaveBeenCalledOnce();
    expect(toolMessage(result.messages, 'w1')).toBe('written notes.txt');
    expect(toolMessage(result.messages, 'p1')).toMatch(/interrupted|aborted|中止/i);
  }, 15_000);

  it('#15 a crashing stop hook pauses the run instead of reporting completion', async () => {
    const { executor, tools } = fileTools();
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    harness.getStopHookManager().register(async () => { throw new Error('hook backend unavailable'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await harness.run('实现登录功能', async () => finalResponse('登录功能已实现。'));

    expect(result.completionStatus).toBe('paused');
    expect(result.completionReason).toBe('stop_hook_error');
    expect(result.loopState.stopReason).toBe('completion_paused');
    expect(result.content).toBe('登录功能已实现。');
  });

  it('#17 each real repair after a failed acceptance run earns a fresh continuation', async () => {
    const commands: string[] = [];
    const runCommand = vi.fn<ToolHandler>(async (args): Promise<ToolResult> => {
      commands.push(String(args.command));
      return commands.length < 3
        ? { success: false, output: '', error: 'Command failed (exit code: 1)' }
        : { success: true, output: 'all green' };
    });
    const { executor, tools } = fileTools({ run_command: runCommand });
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    const llm = scripted([
      toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'src/a.ts', content: 'broken' } }]),
      finalResponse('第一次结束'),
      toolCallResponse([{ id: 'w2', name: 'write_file', args: { path: 'src/a.ts', content: 'still broken' } }]),
      finalResponse('第二次结束'),
      toolCallResponse([{ id: 'w3', name: 'write_file', args: { path: 'src/a.ts', content: 'fixed' } }]),
      finalResponse('修好了'),
    ]);

    const result = await harness.run('实现功能。完成条件：必须运行 `npm test`。', llm);

    expect(commands).toEqual(['npm test', 'npm test', 'npm test']);
    expect(llm.inputs).toHaveLength(6);
    expect(result.completionStatus).toBe('completed');
    expect(result.completionReason).toBe('verification_passed');
    expect(result.content).toBe('修好了');
  });

  it('#17 stopping again without changes still ends the turn with the failure reported', async () => {
    const runCommand = vi.fn<ToolHandler>(async () => ({ success: false, output: '', error: 'Command failed (exit code: 1)' }));
    const { executor, tools } = fileTools({ run_command: runCommand });
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    const llm = scripted([
      toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'src/a.ts', content: 'broken' } }]),
      finalResponse('第一次结束'),
      finalResponse('修不好，先停下'),
    ]);

    const result = await harness.run('实现功能。完成条件：必须运行 `npm test`。', llm);

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(llm.inputs).toHaveLength(3);
    expect(result.completionStatus).toBe('failed');
    expect(result.content).toMatch(/Verification still failed: npm test/);
  });
});
