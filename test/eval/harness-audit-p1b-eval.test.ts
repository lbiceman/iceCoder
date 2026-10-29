/**
 * Harness 审计 P1（#19–#47）的端到端 eval（脚本驱动 LLM，不打真实 API）。
 * 每条场景都在修复前的代码上表现为多余续跑、误拦或状态泄漏。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import { evaluateIncompleteTaskStopHook } from '../../src/harness/incomplete-task-stop-hook.js';
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

describe('eval: harness audit P1 #19–#47', () => {
  let workDir: string;

  beforeEach(async () => {
    process.env.ICE_EVAL_MODE = '1';
    workDir = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-audit-p1b-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(async () => {
    delete process.env.ICE_EVAL_MODE;
    vi.restoreAllMocks();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('#19 a reminder like "还需要注意…" does not trigger the incomplete-task stop hook', async () => {
    const { executor, tools } = createToolExecutor({ read_file: async () => ({ success: true, output: '' }) });
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    harness.getStopHookManager().register(async (messages, lastContent) =>
      evaluateIncompleteTaskStopHook(messages, lastContent));
    const llm = scripted([
      finalResponse('登录接口的设计如下：用 JWT 做会话，刷新令牌放 httpOnly cookie。还需要注意密码必须加盐哈希存储。'),
    ]);

    const result = await harness.run('实现登录接口的鉴权', llm);

    expect(llm.inputs).toHaveLength(1);
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('#19 an explicit "接下来我会…" still gets pulled back to tools', async () => {
    const { executor, tools } = createToolExecutor({ read_file: async () => ({ success: true, output: '' }) });
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    harness.getStopHookManager().register(async (messages, lastContent) =>
      evaluateIncompleteTaskStopHook(messages, lastContent));
    const llm = scripted([
      finalResponse('接下来我会修改 src/login.ts。'),
      finalResponse('无法访问仓库，先停在这里。'),
    ]);

    await harness.run('实现登录功能', llm);

    expect(llm.inputs).toHaveLength(2);
  });

  it('#23 an explanation that mentions <tool_call> is answered once, without a recovery round', async () => {
    const read = vi.fn<ToolHandler>(async () => ({ success: true, output: '' }));
    const { executor, tools } = createToolExecutor({ read_file: read });
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    const answer = [
      '早期一些模型会把工具调用包在 <tool_call> 标签里写进正文，客户端再从文本里解析出工具名和参数。',
      '现在主流服务都改成了原生 function calling，调用会作为结构化字段返回，所以你不需要做任何额外配置。',
    ].join('\n');
    const llm = scripted([finalResponse(answer)]);

    const result = await harness.run('以前的模型是怎么在文本里调用工具的？', llm);

    expect(llm.inputs).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('#20 "放到" without a file name does not spend a completion self-check', async () => {
    const write = vi.fn<ToolHandler>(async () => ({ success: true, output: 'written' }));
    const { executor, tools } = createToolExecutor({ write_file: write });
    const harness = new Harness(minConfig({ tools, workspaceRoot: workDir }), executor);
    stubMemoryPersist(harness);
    const llm = scripted([
      finalResponse('parseConfig 已经在 config 模块里，不需要再移动。'),
    ]);

    const result = await harness.run('实现这次调整：把 parseConfig 放到 config 模块，不要新建文件。', llm);

    expect(llm.inputs).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.messages.some(message =>
      typeof message.content === 'string' && message.content.includes('Completion Check'),
    )).toBe(false);
  });

  it('#21 "不要忘记提交" after compaction is not treated as amnesia', async () => {
    const { executor, tools } = createToolExecutor({ read_file: async () => ({ success: true, output: '' }) });
    const harness = new Harness(minConfig({
      tools,
      workspaceRoot: workDir,
      compactionThreshold: 1,
      compactionTokenThreshold: 1,
      compactionEnableLLMSummary: false,
    }), executor);
    stubMemoryPersist(harness);
    const llm = scripted([
      finalResponse('登录校验已按现有实现核对。不要忘记提交。'),
    ]);

    const result = await harness.run('修复登录校验，改完就结束。', llm);

    expect(llm.inputs).toHaveLength(1);
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.content).toContain('不要忘记提交');
  });

  it('#47 skipPermissionChecks still enforces an explicit deny', async () => {
    const write = vi.fn<ToolHandler>(async () => ({ success: true, output: 'written' }));
    const { executor, tools } = createToolExecutor({ write_file: write });
    const harness = new Harness(minConfig({
      tools,
      workspaceRoot: workDir,
      permissions: [{ pattern: 'write_file', permission: 'deny', reason: 'eval deny' }],
    }), executor);
    stubMemoryPersist(harness);
    const llm = scripted([
      toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'notes.txt', content: 'hello' } }]),
      finalResponse('写入被拒绝。'),
    ]);

    const result = await harness.run('实现打开调试开关', llm);

    expect(write).not.toHaveBeenCalled();
    expect(result.completionStatus).toBe('paused');
    expect(result.completionReason).toBe('operation_policy_blocked');
    expect(llm.inputs).toHaveLength(2);
  });
});
