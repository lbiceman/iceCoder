/**
 * Harness 核心循环引擎单元测试。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Harness } from '../../src/harness/harness.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { TaskState } from '../../src/harness/task-state.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import type { HarnessConfig, HarnessStepEvent, ChatFunction } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import type { ToolResult } from '../../src/tools/types.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { isDestructiveOperation, isDestructiveCommand } from '../../src/tools/tool-metadata.js';
import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';
import {
  DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL,
  DEFAULT_LONG_RUNNING_MAX_ROUNDS,
  DEFAULT_LONG_RUNNING_TIMEOUT_MS,
  getHarnessMaxRoundsFromEnv,
  getHarnessTimeoutMsFromEnv,
  getHarnessTokenBudget,
} from '../../src/harness/token-budget-config.js';
import { resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import { createSupervisorRuntimeBridge } from '../../src/harness/supervisor/supervisor-bridge.js';

// ═══ 测试工具 ═══

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { type: 'object', properties: {} },
  };
}

function makeUsage(input = 100, output = 50) {
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, provider: 'test' };
}

function finalResponse(content: string, tokens = { input: 100, output: 50 }): LLMResponse {
  return { content, usage: makeUsage(tokens.input, tokens.output), finishReason: 'stop' };
}

/** step-review 启发式不确定时会额外消费一次 chatFn；队列中插入本桩避免抢走主对话的 mock。 */
function stepReviewLlmStub(): LLMResponse {
  return finalResponse(
    '{"progressMade":false,"repeatedPattern":false,"fallbackSuggested":false,"reason":"test-stub"}',
  );
}

function toolCallResponse(calls: { id: string; name: string; args?: Record<string, any> }[], content = ''): LLMResponse {
  return {
    content,
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: makeUsage(),
    finishReason: 'tool_calls',
  };
}

function toolCallResponseAtOutputCeiling(
  calls: { id: string; name: string; args?: Record<string, any> }[],
  outputTokens = 16384,
): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: makeUsage(100, outputTokens),
    finishReason: 'tool_calls',
  };
}

function lengthResponse(content: string): LLMResponse {
  return { content, usage: makeUsage(), finishReason: 'length' };
}

function createToolExecutor(
  tools: ToolDefinition[],
  handler: (args: Record<string, any>) => Promise<ToolResult> = async () => ({ success: true, output: 'ok' }),
): ToolExecutor {
  const registry = new ToolRegistry();
  for (const t of tools) {
    registry.register({ definition: t, handler });
  }
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5000 });
}

function minConfig(overrides?: Partial<HarnessConfig>): HarnessConfig {
  return {
    context: {
      systemPrompt: 'You are a test assistant.',
      tools: overrides?.context?.tools ?? [makeTool('read_file')],
    },
    loop: {
      maxRounds: overrides?.loop?.maxRounds ?? 100,
      tokenBudget: overrides?.loop?.tokenBudget,
      timeout: overrides?.loop?.timeout,
      signal: overrides?.loop?.signal,
    },
    compactionThreshold: overrides?.compactionThreshold ?? 9999,
    compactionTokenThreshold: overrides?.compactionTokenThreshold ?? 999999,
    // 使用不存在的目录，避免记忆系统扫描到真实文件并触发 LLM sideQuery
    memoryDir: overrides?.memoryDir ?? '__test_nonexistent_memory_dir__',
    sessionDir: overrides?.sessionDir ?? '__test_nonexistent_session_dir__',
    ...overrides,
  };
}

/**
 * 创建一个基于队列的 chatFn mock。
 * 按顺序消费 responses 队列，队列用完后返回 fallback。
 */
function createChatFn(
  responses: LLMResponse[],
  fallback: LLMResponse = finalResponse('fallback'),
): ChatFunction {
  const queue = [...responses];
  const fn = vi.fn().mockImplementation(async () => {
    return queue.length > 0 ? queue.shift()! : fallback;
  });
  return fn;
}

// ═══ 抑制 console 输出 ═══
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});


// ═══════════════════════════════════════════════════════════════
// 1. 正常完成（model_done）
// ═══════════════════════════════════════════════════════════════
describe('Harness - 正常完成', () => {
  it('单轮对话直接返回最终回复', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([finalResponse('Hello!')]);
    const result = await harness.run('Hi', chatFn);

    expect(result.content).toBe('Hello!');
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.loopState.currentRound).toBe(1);
    expect(result.loopState.totalToolCalls).toBe(0);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.log.length).toBeGreaterThan(0);
  });

  it('返回的 messages 包含 system 和 user', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'sys', tools } }), executor);

    const chatFn = createChatFn([finalResponse('Done')]);
    const result = await harness.run('Do something', chatFn);

    const roles = result.messages.map(m => m.role);
    expect(roles).toContain('system');
    expect(roles).toContain('user');
  });

  it('token 使用量被正确记录', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([finalResponse('ok', { input: 200, output: 80 })]);
    const result = await harness.run('test', chatFn);

    expect(result.loopState.totalInputTokens).toBe(200);
    expect(result.loopState.totalOutputTokens).toBe(80);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 工具调用循环
// ═══════════════════════════════════════════════════════════════
describe('Harness - 工具调用循环', () => {
  it('即使 finishReason=stop，只要 toolCalls 非空也执行工具', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const responseWithStopAndTools: LLMResponse = {
      content: 'Reading file',
      toolCalls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      usage: makeUsage(),
      finishReason: 'stop',
    };
    const chatFn = createChatFn([
      responseWithStopAndTools,
      finalResponse('Read complete'),
    ]);

    const result = await harness.run('Read file', chatFn);

    expect(result.content).toBe('Read complete');
    expect(result.loopState.totalToolCalls).toBe(1);
  });

  it('执行型任务首轮未调用工具时会自动继续执行', async () => {
    const tools = [makeTool('edit_file'), makeTool('read_file'), makeTool('run_command')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      finalResponse('我会先修改这个问题。'),
      toolCallResponse([{ id: 'tc1', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc2', name: 'run_command', args: { command: 'npm test' } }]),
      toolCallResponse([{ id: 'tc3', name: 'read_file', args: { path: 'src/a.ts' } }]),
      finalResponse('已修复'),
    ], finalResponse('已修复'));

    const result = await harness.run('修复这个失败用例', chatFn);

    expect(result.content).toBe('已修复');
    expect(result.loopState.totalToolCalls).toBe(3);
    expect(chatFn).toHaveBeenCalledTimes(5);
    expect(result.messages.some(m =>
      m.role === 'user'
      && typeof m.content === 'string'
      && m.content.includes('did not invoke tools')
    )).toBe(true);
  });

  it('修改代码后读确认允许完成（不要求跑测）', async () => {
    const tools = [makeTool('edit_file'), makeTool('read_file'), makeTool('run_command')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc2', name: 'read_file', args: { path: 'src/a.ts' } }]),
      stepReviewLlmStub(),
      finalResponse('已修复'),
    ], finalResponse('已修复'));

    const result = await harness.run('修复失败用例', chatFn);

    expect(result.content).toBe('已修复');
    expect(result.loopState.totalToolCalls).toBe(2);
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('修改代码后读确认与跑测均允许完成', async () => {
    const tools = [makeTool('edit_file'), makeTool('read_file'), makeTool('run_command')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc2', name: 'read_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc3', name: 'run_command', args: { command: 'npm test' } }]),
      finalResponse('已修复并验证'),
    ], finalResponse('已修复并验证'));

    const result = await harness.run('修复失败用例', chatFn);

    expect(result.content).toBe('已修复并验证');
    expect(result.loopState.totalToolCalls).toBe(3);
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('工具执行后注入 Runtime State 和 Repo Context', async () => {
    const tools = [makeTool('read_file'), makeTool('edit_file'), makeTool('run_command')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc2', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc3', name: 'run_command', args: { command: 'npm test' } }]),
      finalResponse('done'),
    ]);

    const result = await harness.run('修复 src/a.ts', chatFn);
    const runtimeStateMessage = result.messages.find(m =>
      m.role === 'user'
      && typeof m.content === 'string'
      && m.content.startsWith('[System Runtime State]')
    );

    expect(runtimeStateMessage?.content).toContain('# Runtime State');
    expect(runtimeStateMessage?.content).toContain('# Repo Context');
    expect(runtimeStateMessage?.content).toContain('src/a.ts');
    expect(runtimeStateMessage?.content).toContain('npm test');
  });

  it('一轮工具调用后返回最终回复', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      finalResponse('File content is X'),
    ]);

    const result = await harness.run('Read the file', chatFn);

    expect(result.content).toBe('File content is X');
    expect(result.loopState.totalToolCalls).toBe(1);
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('多轮工具调用正确累计', async () => {
    const tools = [makeTool('read_file'), makeTool('write_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      toolCallResponse([{ id: 'tc2', name: 'write_file' }]),
      finalResponse('All done'),
    ]);

    const result = await harness.run('Do stuff', chatFn);

    expect(result.content).toBe('All done');
    expect(result.loopState.totalToolCalls).toBe(2);
  });

  it('单轮多个工具调用', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([
        { id: 'tc1', name: 'read_file', args: { path: 'a.txt' } },
        { id: 'tc2', name: 'read_file', args: { path: 'b.txt' } },
      ]),
      finalResponse('Both files read'),
    ]);

    const result = await harness.run('Read both', chatFn);

    expect(result.content).toBe('Both files read');
    expect(result.loopState.totalToolCalls).toBe(2);
  });

  it('工具执行失败时错误信息传递给 LLM', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools, async () => ({
      success: false,
      output: '',
      error: 'File not found',
    }));
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      stepReviewLlmStub(),
      finalResponse('File does not exist'),
    ]);

    const result = await harness.run('Read file', chatFn);

    expect(result.content).toBe('File does not exist');
    // 消息中应该包含工具错误
    const toolMsg = result.messages.find(m => m.role === 'tool' && typeof m.content === 'string' && (m.content as string).includes('工具执行错误'));
    expect(toolMsg).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. max_rounds 停止
// ═══════════════════════════════════════════════════════════════
describe('Harness - max_rounds 停止', () => {
  it('达到 maxRounds 时停止并请求总结', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 2 },
    }), executor);

    // 第 1 轮：正常 LLM 调用 → 工具调用
    // 第 2 轮：advanceRound → round=2 >= maxRounds=2 → max_rounds 停止
    // handleStop 请求总结
    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      finalResponse('Summary after max rounds'),
    ]);

    const result = await harness.run('Do work', chatFn);

    expect(result.loopState.stopReason).toBe('max_rounds');
    expect(result.content).toBe('Summary after max rounds');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3b. token_budget 停止
// ═══════════════════════════════════════════════════════════════
describe('Harness - token_budget 停止', () => {
  it('预算耗尽时直接返回暂停说明，不再请求最终总结', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, tokenBudget: 100 },
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
    ]);

    const result = await harness.run('Do work', chatFn);

    expect(result.loopState.stopReason).toBe('token_budget');
    expect(result.content).toContain('token 预算耗尽而暂停');
    expect(chatFn).toHaveBeenCalledTimes(1);
  });
});


// ═══════════════════════════════════════════════════════════════
// 4. max-output-tokens 恢复
// ═══════════════════════════════════════════════════════════════
describe('Harness - max-output-tokens 恢复', () => {
  it('finishReason=length 时注入继续消息并恢复', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      lengthResponse('Partial output...'),
      finalResponse('Complete output'),
    ]);

    const result = await harness.run('Generate long text', chatFn);

    expect(result.content).toBe('Complete output');
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('恢复次数用完后以 max_output_tokens 停止', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    // 连续 4 次 length（超过 MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3）
    const chatFn = createChatFn([
      lengthResponse('Part 1'),
      lengthResponse('Part 2'),
      lengthResponse('Part 3'),
      lengthResponse('Part 4'),
    ]);

    const result = await harness.run('Very long text', chatFn);

    expect(result.loopState.stopReason).toBe('max_output_tokens');
  });
});

describe('Harness - write 工具截断恢复', () => {
  it('output 顶满且 write_file 缺 path 时跳过执行并注入恢复提示', async () => {
    const tools = [makeTool('write_file'), makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 10, maxOutputTokens: 16384 },
    }), executor);

    const chatFn = createChatFn([
      toolCallResponseAtOutputCeiling([
        { id: 'w1', name: 'write_file', args: { content: 'x'.repeat(600) } },
      ]),
      finalResponse('will retry smaller'),
    ]);

    const result = await harness.run('Write doc', chatFn);

    expect(result.messages.some(m =>
      m.role === 'tool'
      && typeof m.content === 'string'
      && m.content.includes('[Tool skipped]')
    )).toBe(true);
    expect(result.messages.some(m =>
      m.role === 'user'
      && typeof m.content === 'string'
      && m.content.includes('Continue NOW with a smaller strategy')
    )).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. LLM 错误重试
// ═══════════════════════════════════════════════════════════════
describe('Harness - LLM 错误重试', () => {
  it('可重试错误自动重试后成功', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    let callCount = 0;
    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('429 too many requests');
      return finalResponse('Recovered');
    });

    const result = await harness.run('test', chatFn);

    expect(result.content).toBe('Recovered');
    expect(result.loopState.stopReason).toBe('model_done');
    // 重试不算新轮次
    expect(result.loopState.currentRound).toBe(1);
  }, 30000);

  it('不可重试错误直接返回错误', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn: ChatFunction = vi.fn().mockRejectedValue(new Error('Invalid API key'));

    const result = await harness.run('test', chatFn);

    expect(result.content).toContain('LLM 调用错误');
    expect(result.content).toContain('Invalid API key');
    expect(result.loopState.stopReason).toBe('error');
  });

  it('可重试错误重试次数用完后返回错误', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn: ChatFunction = vi.fn().mockRejectedValue(new Error('timeout'));

    const result = await harness.run('test', chatFn);

    expect(result.loopState.stopReason).toBe('error');
    expect(result.content).toContain('timeout');
    // LLM_MAX_RETRIES=1, 所以 1 初始 + 1 重试 = 2 次
    expect(chatFn).toHaveBeenCalledTimes(2);
  }, 60000);

  it('各种可重试错误类型都能识别', async () => {
    const retryableErrors = [
      'Connection timeout',
      'ECONNRESET by peer',
      'ECONNREFUSED',
      'fetch failed',
      'network error',
      'rate limit exceeded',
      '429 Too Many Requests',
      'too many requests',
      '500 Internal Server Error',
      '502 Bad Gateway',
      '503 Service Unavailable',
      'server overloaded',
    ];

    for (const errMsg of retryableErrors) {
      const tools = [makeTool('read_file')];
      const executor = createToolExecutor(tools);
      const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

      let callCount = 0;
      const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error(errMsg);
        return finalResponse('ok');
      });

      const result = await harness.run('test', chatFn);
      expect(result.content).toBe('ok');
      callCount = 0;
    }
  }, 120000);

  it('非 Error 对象的 LLM 错误被正确处理', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn: ChatFunction = vi.fn().mockRejectedValue('string error');

    const result = await harness.run('test', chatFn);

    expect(result.loopState.stopReason).toBe('error');
    expect(result.content).toContain('string error');
  });
});


// ═══════════════════════════════════════════════════════════════
// 6. 停止钩子
// ═══════════════════════════════════════════════════════════════
describe('Harness - 停止钩子', () => {
  it('钩子要求继续时注入消息并继续循环', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    let hookCalled = false;
    harness.getStopHookManager().register(async () => {
      if (!hookCalled) {
        hookCalled = true;
        return { shouldContinue: true, message: 'Please check tests', hookName: 'test_check' };
      }
      return { shouldContinue: false, hookName: 'test_check' };
    });

    const chatFn = createChatFn([
      finalResponse('I think I am done'),
      finalResponse('Tests pass, truly done'),
    ]);

    // goal 必须是工程意图，否则状态门控会跳过 hook（详见 harness-round-no-tools.ts）
    const result = await harness.run('实现登录功能', chatFn);

    expect(result.content).toBe('Tests pass, truly done');
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('钩子不要求继续时正常停止', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    harness.getStopHookManager().register(async () => ({
      shouldContinue: false,
      hookName: 'noop_hook',
    }));

    const chatFn = createChatFn([finalResponse('Done')]);
    const result = await harness.run('test', chatFn);

    expect(result.content).toBe('Done');
    expect(result.loopState.stopReason).toBe('model_done');
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. 模型响应行为
// ═══════════════════════════════════════════════════════════════
describe('Harness - 模型响应行为', () => {
  it('模型纯文本响应时直接停止', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, tokenBudget: 1000000 },
    }), executor);

    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      return finalResponse('Here is the summary.', { input: 100, output: 50 });
    });

    const result = await harness.run('Summarize the project', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  it('模型通过 tool_calls 自然地连续执行多步任务', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, tokenBudget: 1000000 },
    }), executor);

    let callCount = 0;
    const chatFn: ChatFunction = vi.fn().mockImplementation(async (msgs) => {
      callCount++;
      if (callCount < 3) {
        return toolCallResponse([{ id: `tc_${callCount}`, name: 'read_file', args: { path: '/file.txt' } }], 'Reading file...');
      }
      return finalResponse('All done.', { input: 100, output: 50 });
    });

    const result = await harness.run('Multi-step task', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
    // 2 次 tool call + 1 次 final = 3 次
    expect(chatFn).toHaveBeenCalledTimes(3);
  });

  it('模型无工具调用的纯文本响应直接停止', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, tokenBudget: 1000000 },
    }), executor);

    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      return finalResponse('Done, no tool calls.', { input: 100, output: 50 });
    });

    const result = await harness.run('Quick question', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
    expect(chatFn).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. 破坏性工具权限确认
// ═══════════════════════════════════════════════════════════════
describe('Harness - 破坏性工具权限确认', () => {
  it('permissions=deny 时拒绝匹配工具且不执行 handler', async () => {
    const tools = [makeTool('read_file')];
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'read' });
    const executor = createToolExecutor(tools, handler);
    // const harness = new Harness(minConfig({
    //   context: { systemPrompt: 'test', tools },
    //   permissions: [{ pattern: 'read_file', permission: 'deny', reason: 'readonly disabled' }],
    // }));
    // minConfig 会被完整 overrides 覆盖不了 executor，所以使用独立实例保持 handler 可观察
    const harnessWithExecutor = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      permissions: [{ pattern: 'read_file', permission: 'deny', reason: 'readonly disabled' }],
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      finalResponse('Cannot read'),
    ]);

    const result = await harnessWithExecutor.run('Read file', chatFn);

    expect(result.content).toBe('Cannot read');
    expect(handler).not.toHaveBeenCalled();
    expect(result.messages.some(m =>
      m.role === 'tool'
      && typeof m.content === 'string'
      && m.content.includes('denied by policy')
    )).toBe(true);
  });

  it('permissions=confirm 时对非破坏性工具也触发确认', async () => {
    const tools = [makeTool('read_file')];
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'read' });
    const executor = createToolExecutor(tools, handler);
    const onConfirm = vi.fn().mockResolvedValue(false);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      permissions: [{ pattern: 'read_*', permission: 'confirm', reason: 'confirm reads' }],
      onConfirm,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      finalResponse('User declined'),
    ]);

    const result = await harness.run('Read file', chatFn);

    expect(result.content).toBe('User declined');
    expect(onConfirm).toHaveBeenCalledWith('read_file', {});
    expect(handler).not.toHaveBeenCalled();
  });

  it('permissions=confirm 但没有 onConfirm 时默认拒绝而不是静默执行', async () => {
    const tools = [makeTool('read_file')];
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'read' });
    const executor = createToolExecutor(tools, handler);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      permissions: [{ pattern: 'read_file', permission: 'confirm', reason: 'confirm callback missing' }],
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      finalResponse('Need confirmation'),
    ]);

    const result = await harness.run('Read file', chatFn);

    expect(result.content).toBe('Need confirmation');
    expect(handler).not.toHaveBeenCalled();
    expect(result.messages.some(m =>
      m.role === 'tool'
      && typeof m.content === 'string'
      && m.content.includes('requires confirmation')
    )).toBe(true);
  });

  it('skipPermissionChecks=true 时跳过 deny/confirm 并直接执行', async () => {
    const tools = [makeTool('read_file')];
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'read' });
    const executor = createToolExecutor(tools, handler);
    const onConfirm = vi.fn().mockResolvedValue(false);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      permissions: [{ pattern: 'read_file', permission: 'deny', reason: 'readonly disabled' }],
      skipPermissionChecks: true,
      onConfirm,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      finalResponse('Done'),
    ]);

    const result = await harness.run('Read file', chatFn);

    expect(result.content).toBe('Done');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('用户允许时正常执行破坏性工具', async () => {
    const tools = [makeTool('fs_operation')];
    const executor = createToolExecutor(tools, async () => ({ success: true, output: 'Deleted' }));
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      onConfirm: async () => true,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'fs_operation', args: { operation: 'delete', path: 'temp.txt' } }]),
      finalResponse('File deleted'),
    ]);

    const result = await harness.run('Delete temp.txt', chatFn);

    expect(result.content).toBe('File deleted');
    expect(result.loopState.totalToolCalls).toBe(1);
  });

  it('用户拒绝时跳过工具并通知 LLM', async () => {
    const tools = [makeTool('fs_operation')];
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'Deleted' });
    const executor = createToolExecutor(tools, handler);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      onConfirm: async () => false,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'fs_operation', args: { operation: 'delete', path: 'important.txt' } }]),
      finalResponse('OK, I will not delete it'),
    ]);

    const result = await harness.run('Delete important.txt', chatFn);

    expect(result.content).toBe('OK, I will not delete it');
    expect(handler).not.toHaveBeenCalled();
    const toolMsg = result.messages.find(m => m.role === 'tool' && typeof m.content === 'string' && (m.content as string).includes('User denied'));
    expect(toolMsg).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. 用户中断（AbortSignal）
// ═══════════════════════════════════════════════════════════════
describe('Harness - 用户中断', () => {
  it('AbortSignal 在 LLM 调用前触发时停止', async () => {
    const ac = new AbortController();
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, signal: ac.signal },
    }), executor);

    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      ac.abort();
      return toolCallResponse([{ id: 'tc1', name: 'read_file' }]);
    });

    const result = await harness.run('Do work', chatFn);

    expect(result.loopState.stopReason).toBe('user_abort');
  });

  it('中断时为未完成的 tool_use 补齐 tool_result', async () => {
    const ac = new AbortController();
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools, async () => {
      ac.abort();
      return { success: true, output: 'ok' };
    });
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, signal: ac.signal },
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([
        { id: 'tc1', name: 'read_file' },
        { id: 'tc2', name: 'read_file' },
      ]),
    ]);

    const result = await harness.run('Read files', chatFn);

    expect(result.loopState.stopReason).toBe('user_abort');
    const assistantMsg = result.messages.find(m => m.role === 'assistant' && m.toolCalls);
    if (assistantMsg?.toolCalls) {
      for (const tc of assistantMsg.toolCalls) {
        const hasResult = result.messages.some(m => m.role === 'tool' && m.toolCallId === tc.id);
        expect(hasResult).toBe(true);
      }
    }
  });
});


// ═══════════════════════════════════════════════════════════════
// 10. onStep 回调事件
// ═══════════════════════════════════════════════════════════════
describe('Harness - onStep 回调', () => {
  it('正常完成时触发 final 事件', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([finalResponse('Done')]);
    const events: HarnessStepEvent[] = [];
    await harness.run('test', chatFn, (e) => events.push(e));

    const finalEvent = events.find(e => e.type === 'final');
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.stopReason).toBe('model_done');
    expect(finalEvent!.content).toBe('Done');
  });

  it('工具调用时触发 thinking + tool_call + tool_result 事件', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }], 'Let me read'),
      finalResponse('Got it'),
    ]);

    const events: HarnessStepEvent[] = [];
    await harness.run('Read', chatFn, (e) => events.push(e));

    const types = events.map(e => e.type);
    expect(types).toContain('thinking');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_progress');
    expect(types).toContain('tool_result');
    expect(types).toContain('final');

    const toolCallEvent = events.find(e => e.type === 'tool_call');
    expect(toolCallEvent!.toolName).toBe('read_file');

    const toolResultEvent = events.find(e => e.type === 'tool_result');
    expect(toolResultEvent!.toolSuccess).toBe(true);
  });

  it('破坏性工具拒绝时触发 tool_confirm + tool_denied 事件', async () => {
    const tools = [makeTool('fs_operation')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      onConfirm: async () => false,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'fs_operation', args: { operation: 'delete', path: 'test.txt' } }]),
      finalResponse('OK'),
    ]);

    const events: HarnessStepEvent[] = [];
    await harness.run('Delete', chatFn, (e) => events.push(e));

    const types = events.map(e => e.type);
    expect(types).toContain('tool_confirm');
    expect(types).toContain('tool_denied');
  });

  it('LLM 错误时 final 事件包含 error stopReason', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn: ChatFunction = vi.fn().mockRejectedValue(new Error('Invalid key'));

    const events: HarnessStepEvent[] = [];
    await harness.run('test', chatFn, (e) => events.push(e));

    const finalEvent = events.find(e => e.type === 'final');
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.stopReason).toBe('error');
  });

  it('max_output_tokens 停止时 final 事件包含正确 stopReason', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      lengthResponse('P1'),
      lengthResponse('P2'),
      lengthResponse('P3'),
      lengthResponse('P4'),
    ]);

    const events: HarnessStepEvent[] = [];
    await harness.run('test', chatFn, (e) => events.push(e));

    const finalEvent = events.find(e => e.type === 'final');
    expect(finalEvent!.stopReason).toBe('max_output_tokens');
    expect(finalEvent!.tokenUsage).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. 已有消息历史（existingMessages）
// ═══════════════════════════════════════════════════════════════
describe('Harness - 已有消息历史', () => {
  it('传入 existingMessages 时追加用户消息而非重建', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const existingMessages: UnifiedMessage[] = [
      { role: 'system', content: 'Previous system prompt' },
      { role: 'user', content: 'Previous question' },
      { role: 'assistant', content: 'Previous answer' },
    ];

    const chatFn = createChatFn([finalResponse('Follow-up answer')]);
    const result = await harness.run('Follow-up question', chatFn, undefined, existingMessages);

    expect(result.content).toBe('Follow-up answer');
    // 应该保留之前的 system 消息
    expect(result.messages[0].content).toBe('Previous system prompt');
    // 应该包含新的用户消息
    const hasFollowUp = result.messages.some(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes('Follow-up question'),
    );
    expect(hasFollowUp).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. handleStop 最终总结失败回退
// ═══════════════════════════════════════════════════════════════
describe('Harness - handleStop 总结失败回退', () => {
  it('最终总结 LLM 调用失败时回退到最后一条 assistant 消息', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 2 },
    }), executor);

    let callCount = 0;
    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return toolCallResponse([{ id: 'tc1', name: 'read_file' }], 'Working on it');
      }
      // handleStop 的总结调用失败
      throw new Error('Summary LLM failed');
    });

    const result = await harness.run('Do work', chatFn);

    expect(result.loopState.stopReason).toBe('max_rounds');
    // 回退到最后一条 assistant 消息的内容
    expect(result.content).toBe('Working on it');
  });
});

// ═══════════════════════════════════════════════════════════════
// 15. ContextCompactor 微压缩
// ═══════════════════════════════════════════════════════════════
describe('ContextCompactor - 微压缩', () => {
  it('达到 tokenThreshold 时触发硬压缩，不再等到上下文几乎耗尽', () => {
    const compactor = new ContextCompactor({ tokenThreshold: 100 });
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x'.repeat(600) },
    ];

    expect(compactor.needsCompaction(messages)).toBe(true);
  });

  it('微压缩保留全部短 user，并对过时白名单工具结果清空正文（B）', () => {
    const compactor = new ContextCompactor();
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ok' },
    ];
    for (let i = 1; i <= 7; i++) {
      messages.push(
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `tc${i}`, name: 'run_command', arguments: {} }],
        },
        {
          role: 'tool',
          toolCallId: `tc${i}`,
          content: i === 1 ? 'VERYLONGOUTPUT'.repeat(100) : `KEEPTHIS${i}`.repeat(20),
        },
      );
    }
    messages.push({ role: 'user', content: '跑测试' });

    const compacted = compactor.doLightCompact(messages);

    expect(compacted.some(m => m.role === 'user' && m.content === 'ok')).toBe(true);
    expect(compacted.some(m => m.role === 'user' && m.content === '跑测试')).toBe(true);
    const t1 = compacted.find(m => m.role === 'tool' && m.toolCallId === 'tc1');
    const t6 = compacted.find(m => m.role === 'tool' && m.toolCallId === 'tc6');
    expect((t1!.content as string).startsWith('[Old tool result cleared for context]')).toBe(true);
    expect(t6!.content).toContain('KEEPTHIS6');
  });

  it('微压缩不清空 read_file 结果（即便轮次很旧）', () => {
    const compactor = new ContextCompactor();
    const oldBody = 'FILEBODY'.repeat(200);
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'r1', content: oldBody },
    ];
    for (let i = 2; i <= 7; i++) {
      messages.push(
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `tc${i}`, name: 'run_command', arguments: {} }],
        },
        { role: 'tool', toolCallId: `tc${i}`, content: 'x' },
      );
    }
    const compacted = compactor.doLightCompact(messages);
    expect(compacted.find(m => m.toolCallId === 'r1')!.content).toBe(oldBody);
  });

  it('保留最近的短用户执行指令（微压缩不再删短 user）', () => {
    const compactor = new ContextCompactor();
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: '跑测试' },
    ];

    const compacted = compactor.doLightCompact(messages);

    expect(compacted.some(m => m.role === 'user' && m.content === '跑测试')).toBe(true);
    expect(compacted.some(m => m.role === 'user' && m.content === 'ok')).toBe(true);
  });

  it('保留中文导航与盘符路径短句（微压缩保留全部短 user）', () => {
    const compactor = new ContextCompactor();
    const messages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '嗯' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: '进入D盘' },
      { role: 'user', content: 'D:\\\\work' },
    ];
    const compacted = compactor.doLightCompact(messages);
    expect(compacted.some(m => m.role === 'user' && m.content === '进入D盘')).toBe(true);
    expect(compacted.some(m => m.role === 'user' && m.content === 'D:\\\\work')).toBe(true);
    expect(compacted.some(m => m.role === 'user' && m.content === '嗯')).toBe(true);
  });

  it('构建压缩恢复 Runtime State，保留目标、改动文件和验证命令', () => {
    const compactor = new ContextCompactor();
    const taskState = new TaskState('修复失败用例');
    const repoContext = new RepoContext();

    taskState.recordToolResult(
      { id: 'edit1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'edited' },
    );
    taskState.recordToolResult(
      { id: 'test1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'passed' },
    );
    repoContext.recordToolResult(
      { id: 'edit1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'edited' },
    );
    repoContext.recordToolResult(
      { id: 'test1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'passed' },
    );

    const message = compactor.buildRuntimeRecoveryContext(taskState.snapshot(), repoContext.snapshot());

    expect(message.content).toContain('修复失败用例');
    expect(message.content).toContain('src/a.ts');
    expect(message.content).toContain('npm test');
    expect(message.content).toContain('<runtime-recovery-context>');
  });
});

// ═══════════════════════════════════════════════════════════════
// 15b. Harness token budget config
// ═══════════════════════════════════════════════════════════════
describe('Harness token budget config', () => {
  const originalMaxRounds = process.env.ICE_HARNESS_MAX_ROUNDS;

  afterEach(() => {
    if (originalMaxRounds === undefined) {
      delete process.env.ICE_HARNESS_MAX_ROUNDS;
    } else {
      process.env.ICE_HARNESS_MAX_ROUNDS = originalMaxRounds;
    }
  });

  it('累计 token 预算为硬编码常数；不再读取 ICE_HARNESS_TOKEN_BUDGET', () => {
    delete process.env.ICE_HARNESS_TOKEN_BUDGET;
    expect(getHarnessTokenBudget()).toBe(DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL);
    process.env.ICE_HARNESS_TOKEN_BUDGET = 'off';
    expect(getHarnessTokenBudget()).toBe(DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL);
    process.env.ICE_HARNESS_TOKEN_BUDGET = '1200000';
    expect(getHarnessTokenBudget()).toBe(DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL);
  });

  it('墙钟超时硬编码 24h；maxRounds 仍可由 ICE_HARNESS_MAX_ROUNDS 覆盖', () => {
    delete process.env.ICE_HARNESS_TIMEOUT_HOURS;
    delete process.env.ICE_HARNESS_TIMEOUT_MS;
    delete process.env.ICE_HARNESS_MAX_ROUNDS;

    expect(getHarnessTimeoutMsFromEnv()).toBe(24 * 60 * 60 * 1000);
    expect(getHarnessTimeoutMsFromEnv()).toBe(DEFAULT_LONG_RUNNING_TIMEOUT_MS);
    expect(getHarnessMaxRoundsFromEnv()).toBe(DEFAULT_LONG_RUNNING_MAX_ROUNDS);

    process.env.ICE_HARNESS_TIMEOUT_HOURS = '6';
    process.env.ICE_HARNESS_TIMEOUT_MS = '7200000';
    expect(getHarnessTimeoutMsFromEnv()).toBe(DEFAULT_LONG_RUNNING_TIMEOUT_MS);

    process.env.ICE_HARNESS_MAX_ROUNDS = '9000';
    expect(getHarnessMaxRoundsFromEnv()).toBe(9000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 13. 工具输出截断
// ═══════════════════════════════════════════════════════════════
describe('Harness - 工具输出截断', () => {
  it('超长工具输出被截断到 MAX_TOOL_OUTPUT', async () => {
    const tools = [makeTool('read_file')];
    const hugeOutput = 'A'.repeat(50000);
    const executor = createToolExecutor(tools, async () => ({ success: true, output: hugeOutput }));
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      finalResponse('Done'),
    ]);

    const result = await harness.run('Read big file', chatFn);

    // read_file 的 maxResultSizeChars 是 Infinity，所以用 MAX_TOOL_OUTPUT=30000
    const toolMsg = result.messages.find(m => m.role === 'tool' && m.toolCallId === 'tc1');
    expect(toolMsg).toBeDefined();
    const content = toolMsg!.content as string;
    expect(content.length).toBeLessThan(hugeOutput.length);
    expect(content).toContain('输出已截断');
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. 公共方法
// ═══════════════════════════════════════════════════════════════
describe('Harness - 公共方法', () => {
  it('getLoopState 返回初始状态', () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const state = harness.getLoopState();
    expect(state.currentRound).toBe(0);
    expect(state.totalToolCalls).toBe(0);
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
  });

  it('getStopHookManager 返回可用的管理器', () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const manager = harness.getStopHookManager();
    expect(manager).toBeDefined();
    expect(manager.count).toBe(0);

    manager.register(async () => ({ shouldContinue: false, hookName: 'test' }));
    expect(manager.count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 15. 状态重置
// ═══════════════════════════════════════════════════════════════
describe('Harness - 状态重置', () => {
  it('工具调用成功后 maxOutputTokensRecoveryCount 重置', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      // 第 1 轮：length 恢复
      lengthResponse('Partial'),
      // 第 2 轮：恢复后调用工具（重置计数）
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      // 第 3 轮：又 length（计数已重置，可以再恢复）
      lengthResponse('Partial again'),
      // 第 4 轮：正常完成
      finalResponse('All done'),
    ]);

    const result = await harness.run('test', chatFn);

    expect(result.content).toBe('All done');
    expect(result.loopState.stopReason).toBe('model_done');
  });
});

// ═══════════════════════════════════════════════════════════════
// 16. 边界情况
// ═══════════════════════════════════════════════════════════════
describe('Harness - 边界情况', () => {
  it('LLM 返回空内容时重试后报错', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    // 3 次空响应（初始 + 2 次重试），触发 error
    const chatFn = createChatFn([finalResponse(''), finalResponse(''), finalResponse('')]);
    const result = await harness.run('test', chatFn);

    expect(result.content).toBe('LLM returned empty response, please retry.');
    expect(result.loopState.stopReason).toBe('error');
  });

  it('LLM 空响应重试后成功', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    // 第 1 次空响应，第 2 次正常回复
    const chatFn = createChatFn([finalResponse(''), finalResponse('recovered')]);
    const result = await harness.run('test', chatFn);

    expect(result.content).toBe('recovered');
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('工具调用带 reasoningContent 时不写入会话历史', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const responseWithThinking: LLMResponse = {
      content: 'Let me think...',
      toolCalls: [{ id: 'tc1', name: 'read_file', arguments: {} }],
      usage: makeUsage(),
      finishReason: 'tool_calls',
      reasoningContent: 'I need to read the file first',
    };

    const chatFn = createChatFn([responseWithThinking, finalResponse('Done')]);

    const result = await harness.run('test', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
    const withReasoning = result.messages.filter(
      (m) => m.role === 'assistant' && (m as { reasoningContent?: string }).reasoningContent,
    );
    expect(withReasoning.length).toBe(0);
  });

  it('finishReason=stop 且有空 toolCalls 数组时视为无工具调用', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const response: LLMResponse = {
      content: 'No tools needed',
      toolCalls: [],
      usage: makeUsage(),
      finishReason: 'stop',
    };

    const chatFn = createChatFn([response]);
    const result = await harness.run('test', chatFn);

    expect(result.content).toBe('No tools needed');
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.loopState.totalToolCalls).toBe(0);
  });

  it('多轮会话中的最新执行指令未调用工具时也会触发一次恢复', async () => {
    const tools = [makeTool('run_command')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);
    const existingMessages: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前已经调用过工具', toolCalls: [{ id: 'old', name: 'run_command', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'old' },
      { role: 'assistant', content: '之前完成' },
    ];

    const chatFn = createChatFn([
      finalResponse('我会运行测试。'),
      toolCallResponse([{ id: 'tc1', name: 'run_command' }]),
      finalResponse('测试完成'),
    ]);

    const result = await harness.run('运行测试', chatFn, undefined, existingMessages);

    expect(result.content).toBe('测试完成');
    expect(result.loopState.totalToolCalls).toBe(1);
    expect(result.messages.some(m =>
      m.role === 'user'
      && typeof m.content === 'string'
      && m.content.includes('did not invoke tools')
    )).toBe(true);
  });

  it('token 使用量跨多轮正确累计', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      { ...toolCallResponse([{ id: 'tc1', name: 'read_file' }]), usage: makeUsage(100, 50) },
      { ...finalResponse('Done'), usage: makeUsage(200, 80) },
    ]);

    const result = await harness.run('test', chatFn);

    // 第 1 轮 100+50, 第 2 轮 200+80
    expect(result.loopState.totalInputTokens).toBe(300);
    expect(result.loopState.totalOutputTokens).toBe(130);
    expect(result.loopState.lastInputTokens).toBe(200);
    expect(result.loopState.lastOutputTokens).toBe(80);
  });

  it('工具结果预算裁剪对旧的长结果生效', async () => {
    const tools = [makeTool('read_file')];
    const longOutput = 'x'.repeat(5000);
    const executor = createToolExecutor(tools, async () => ({ success: true, output: longOutput }));
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    let callCount = 0;
    let lastSentMessages: any[] = [];
    const chatFn: ChatFunction = vi.fn().mockImplementation(async (msgs: any[]) => {
      callCount++;
      lastSentMessages = msgs;
      if (callCount <= 8) {
        return toolCallResponse([{ id: `tc${callCount}`, name: 'read_file' }]);
      }
      return finalResponse('Done');
    });

    const result = await harness.run('Read many files', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
    const toolMsgs = result.messages.filter(m => m.role === 'tool');
    // 至少有一些 tool 消息
    expect(toolMsgs.length).toBeGreaterThan(0);

    // 原始消息保持完整（缓存友好 — 不就地修改已有消息）
    // 裁剪只发生在发送给 LLM 的副本上
    const sentToolMsgs = lastSentMessages.filter((m: any) => m.role === 'tool');
    if (sentToolMsgs.length > 6) {
      const firstSentContent = sentToolMsgs[0].content as string;
      expect(firstSentContent.length).toBeLessThan(longOutput.length);
      expect(firstSentContent).toContain('工具结果已裁剪');
    }
  });

  it('log 包含结构化日志条目', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      finalResponse('Done'),
    ]);

    const result = await harness.run('test', chatFn);

    expect(result.log.length).toBeGreaterThan(0);
    const events = result.log.map(e => e.event);
    expect(events).toContain('loop_start');
    expect(events).toContain('round_start');
    expect(events).toContain('llm_call');
    expect(events).toContain('llm_response');
    expect(events).toContain('tool_call');
    expect(events).toContain('tool_result');
    expect(events).toContain('loop_stop');
  });
});

// ═══════════════════════════════════════════════════════════════
// 17. 连续工具失败熔断
// ═══════════════════════════════════════════════════════════════
describe('Harness - 连续工具失败熔断', () => {
  it('连续 3 轮工具全部失败后注入策略调整提示', async () => {
    const tools = [makeTool('read_file')];
    const failHandler = async () => ({ success: false, output: '', error: 'tool failed' }) as ToolResult;
    const executor = createToolExecutor(tools, failHandler);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    // 3 轮工具调用（全部失败）+ 1 次最终总结
    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'tc2', name: 'read_file' }]),
      toolCallResponse([{ id: 'tc3', name: 'read_file' }]),
      finalResponse('summary'),
    ]);
    const result = await harness.run('test', chatFn);

    // 熔断改为渐进式干预：3 轮失败后注入提示并继续，模型可正常回复
    expect(result.loopState.stopReason).toBe('model_done');
    expect(result.content).toBe('summary');
  });

  it('重复同参工具失败时注入换策略提示', async () => {
    const tools = [makeTool('read_file')];
    const failHandler = async () => ({ success: false, output: '', error: 'not found' }) as ToolResult;
    const executor = createToolExecutor(tools, failHandler);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file', args: { path: 'missing.ts' } }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'tc2', name: 'read_file', args: { path: 'missing.ts' } }]),
      finalResponse('blocked'),
    ]);

    const result = await harness.run('Read missing file', chatFn);

    expect(result.messages.some(m =>
      m.role === 'user'
      && typeof m.content === 'string'
      && m.content.includes('Repeated failed tool call detected')
    )).toBe(true);
  });

  it('写文件成功后重置熔断计数', async () => {
    const tools = [makeTool('edit_file'), makeTool('read_file'), makeTool('run_command')];
    let fails = 0;
    const handler = async () => {
      fails++;
      if (fails <= 2) return { success: false, output: '', error: 'fail' } as ToolResult;
      return { success: true, output: 'written' } as ToolResult;
    };
    const executor = createToolExecutor(tools, handler);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc2', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc3', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      toolCallResponse([{ id: 'tc4', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'tc5', name: 'read_file', args: { path: 'src/a.ts' } }]),
      stepReviewLlmStub(),
      finalResponse('done'),
    ]);
    const result = await harness.run('test', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('连续 5 轮工具全部失败后注入失败证据包', async () => {
    const tools = [makeTool('read_file')];
    const failHandler = async () => ({ success: false, output: '', error: 'tool failed' }) as ToolResult;
    const executor = createToolExecutor(tools, failHandler);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'tc2', name: 'read_file' }]),
      toolCallResponse([{ id: 'tc3', name: 'read_file' }]),
      toolCallResponse([{ id: 'tc4', name: 'read_file' }]),
      toolCallResponse([{ id: 'tc5', name: 'read_file' }]),
      finalResponse('summary'),
    ]);
    const result = await harness.run('test', chatFn);

    expect(result.messages.some(m =>
      m.role === 'user'
      && typeof m.content === 'string'
      && m.content.includes('[Failure Evidence — 5 consecutive')
      && m.content.includes('Do NOT repeat')
    )).toBe(true);
    expect(result.messages.some(m =>
      typeof m.content === 'string'
      && m.content.includes('[System / Rebuild Escalation]')
    )).toBe(false);
  });

  it('adaptive L2 开启时 non_critical 连续失败仍注入证据包（不受 suppressInject）', async () => {
    const tools = [makeTool('read_file')];
    const failHandler = async () => ({ success: false, output: '', error: 'path is required' }) as ToolResult;
    const executor = createToolExecutor(tools, failHandler);
    const supervisorConfig = resolveSupervisorConfig({ mode: 'adaptive' }, {});
    const bridge = createSupervisorRuntimeBridge(supervisorConfig, { memoryOnly: true });

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
      supervisorBridge: bridge,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file' }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'tc2', name: 'read_file' }]),
      toolCallResponse([{ id: 'tc3', name: 'read_file' }]),
      toolCallResponse([{ id: 'tc4', name: 'read_file' }]),
      toolCallResponse([{ id: 'tc5', name: 'read_file' }]),
      finalResponse('summary'),
    ]);

    const result = await harness.run(
      '整理 Ant Design 文档成 md 放到桌面',
      chatFn,
    );

    expect(bridge.getSupervisorPhase()).toBe('free');
    expect(result.messages.some(m =>
      m.role === 'user'
      && typeof m.content === 'string'
      && m.content.includes('[Failure Evidence — 5 consecutive')
    )).toBe(true);
  });

  it('adaptive takeover 后 runRecoveryMainPath 重建 TaskGraph', async () => {
    const tools = [makeTool('edit_file')];
    const failHandler = async () => ({ success: false, output: '', error: 'compile error' }) as ToolResult;
    const executor = createToolExecutor(tools, failHandler);
    const supervisorConfig = resolveSupervisorConfig({
      mode: 'adaptive',
      snapshotConfidence: { templateGraphMin: 0.5 },
    }, {});
    const bridge = createSupervisorRuntimeBridge(supervisorConfig, { memoryOnly: true });

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
      supervisorBridge: bridge,
    }), executor);

    const sameArgs = { path: 'src/login.ts', content: 'fix' };
    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'edit_file', args: sameArgs }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'tc2', name: 'edit_file', args: sameArgs }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'tc3', name: 'edit_file', args: sameArgs }]),
      stepReviewLlmStub(),
      finalResponse('recovery'),
    ]);

    await harness.run('fix failing unit tests in src/login.ts', chatFn);

    expect(bridge.getSupervisorPhase()).toBe('takeover');
    expect(bridge.eventTimeline.getRecentEvents().some(
      e => e.event === 'recover' && e.reason?.includes('template_graph'),
    )).toBe(true);
  });

  it('实质进展后移除 ephemeral 失败恢复消息', async () => {
    const tools = [makeTool('write_file')];
    let calls = 0;
    const handler = async () => {
      calls++;
      if (calls <= 4) return { success: false, output: '', error: 'fail' } as ToolResult;
      return { success: true, output: 'ok' } as ToolResult;
    };
    const executor = createToolExecutor(tools, handler);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'a.ts', content: 'x' } }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'w2', name: 'write_file', args: { path: 'b.ts', content: 'x' } }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'w3', name: 'write_file', args: { path: 'c.ts', content: 'x' } }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'w4', name: 'write_file', args: { path: 'd.ts', content: 'x' } }]),
      stepReviewLlmStub(),
      toolCallResponse([{ id: 'w5', name: 'write_file', args: { path: 'e.ts', content: 'x' } }]),
      finalResponse('done'),
    ]);
    const result = await harness.run('test', chatFn);

    expect(result.messages.some(m => m.ephemeralFailureRecovery === 'evidence')).toBe(false);
    expect(result.messages.some(m =>
      typeof m.content === 'string' && m.content.includes('[Failure Evidence —')
    )).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 18. 停止钩子连续干预上限
// ═══════════════════════════════════════════════════════════════
describe('Harness - 停止钩子连续干预上限', () => {
  it('停止钩子连续干预超过 5 次后强制停止', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    // 注册一个总是要求继续的钩子
    harness.getStopHookManager().register(async () => ({
      shouldContinue: true,
      message: '请继续工作。',
      hookName: 'always_continue',
    }));

    // 模型每次都回复 "done"，但钩子要求继续
    // 6 次 finalResponse：初始 + 5 次钩子注入后 → 第 6 次钩子超限
    const chatFn = createChatFn([
      finalResponse('done 1'),
      finalResponse('done 2'),
      finalResponse('done 3'),
      finalResponse('done 4'),
      finalResponse('done 5'),
      finalResponse('done 6'),
      finalResponse('summary'),
    ]);
    // goal 必须是工程意图，否则状态门控会跳过 hook
    const result = await harness.run('实现登录功能', chatFn);

    expect(result.loopState.stopReason).toBe('stop_hook');
  });

  it('停止钩子偶尔干预不会触发上限', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    let hookCalls = 0;
    // 前 2 次要求继续，之后放行
    harness.getStopHookManager().register(async () => {
      hookCalls++;
      return {
        shouldContinue: hookCalls <= 2,
        message: hookCalls <= 2 ? '请继续。' : undefined,
        hookName: 'conditional',
      };
    });

    const chatFn = createChatFn([
      finalResponse('done 1'),   // hook says continue (1/3)
      finalResponse('done 2'),   // hook says continue (2/3)
      finalResponse('done 3'),   // hook says stop → model_done
      finalResponse('summary'),
    ]);
    const result = await harness.run('实现登录功能', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('有文件变更时跳过 stop hook，读确认后正常收尾', async () => {
    const tools = [makeTool('write_file'), makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    harness.getStopHookManager().register(async () => ({
      shouldContinue: true,
      message: '请继续。',
      hookName: 'always_continue',
    }));

    const writeRound = () => toolCallResponse([
      { id: 'w', name: 'write_file', args: { path: 'src/game/scene.ts', content: 'export {}' } },
    ]);
    const readRound = () => toolCallResponse([
      { id: 'r', name: 'read_file', args: { path: 'src/game/scene.ts' } },
    ]);

    // 写前 stop hook 可累计；write+read 后 filesChanged>0 → 跳过 stop hook → model_done
    const chatFn = createChatFn([
      finalResponse('next step'),
      finalResponse('next step'),
      writeRound(),
      readRound(),
      finalResponse('done'),
    ], finalResponse('done'));
    const result = await harness.run('实现登录功能', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
  });
});

// ═══════════════════════════════════════════════════════════════
// 19. Task checkpoint
// ═══════════════════════════════════════════════════════════════
describe('Harness - task checkpoint', () => {
  it('工具执行后保存 running checkpoint，完成后标记 completed', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-checkpoint-'));
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'read_file', args: { path: 'src/a.ts' } }]),
      finalResponse('done'),
    ]);

    const result = await harness.run('Read src/a.ts', chatFn);
    const raw = await fs.readFile(path.join(sessionDir, 'default.checkpoint.json'), 'utf-8');
    const checkpoint = JSON.parse(raw) as TaskCheckpoint;

    expect(result.loopState.stopReason).toBe('model_done');
    expect(checkpoint.status).toBe('completed');
    expect(checkpoint.userGoal).toBe('Read src/a.ts');
    expect(checkpoint.taskState.filesRead).toContain('src/a.ts');
  });

  it('恢复时注入 active checkpoint', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-checkpoint-'));
    await fs.writeFile(
      path.join(sessionDir, 'default.checkpoint.json'),
      JSON.stringify({
        version: 1,
        taskId: 'task-1',
        status: 'paused',
        userGoal: 'Fix TypeScript errors',
        phase: 'verification',
        taskState: {
          goal: 'Fix TypeScript errors',
          intent: 'debug',
          phase: 'verification',
          filesRead: [],
          filesChanged: ['src/a.ts'],
          commandsRun: ['npx tsc --noEmit'],
          verificationRequired: true,
          verificationStatus: 'failed',
        },
        repoContext: {
          filesRead: [],
          filesChanged: ['src/a.ts'],
          commandsRun: ['npx tsc --noEmit'],
          testCommands: ['npx tsc --noEmit'],
          recentDiagnostics: ['tsc failed'],
        },
        failedToolCalls: [],
        messageCount: 12,
        loop: {
          currentRound: 3,
          totalToolCalls: 3,
          totalInputTokens: 100,
          totalOutputTokens: 20,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } satisfies TaskCheckpoint),
      'utf-8',
    );

    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
    }), executor);

    const chatFn: ChatFunction = vi.fn().mockImplementation(async (messages: UnifiedMessage[]) => {
      expect(messages.some(m =>
        m.role === 'user'
        && typeof m.content === 'string'
        && m.content.includes('<resume-checkpoint>')
        && m.content.includes('Fix TypeScript errors')
      )).toBe(true);
      expect(messages.every(m =>
        typeof m.content !== 'string' || !m.content.includes('"version": 1'),
      )).toBe(true);
      return finalResponse('resumed');
    });

    const result = await harness.run('继续', chatFn);
    expect(result.content).toBe('resumed');
  });
});
