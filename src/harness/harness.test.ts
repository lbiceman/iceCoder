/**
 * Harness 核心循环引擎单元测试。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Harness } from './harness.js';
import type { HarnessConfig, HarnessStepEvent, ChatFunction } from './types.js';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../llm/types.js';
import type { ToolResult } from '../tools/types.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutor } from '../tools/tool-executor.js';

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

function toolCallResponse(calls: { id: string; name: string; args?: Record<string, any> }[], content = ''): LLMResponse {
  return {
    content,
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: makeUsage(),
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
    // LLM_MAX_RETRIES=3, 所以 1 初始 + 3 重试 = 4 次
    expect(chatFn).toHaveBeenCalledTimes(4);
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

    const result = await harness.run('Do work', chatFn);

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
// 7. Token 预算继续
// ═══════════════════════════════════════════════════════════════
describe('Harness - Token 预算继续', () => {
  it('模型声明 complete 时不继续，即使预算充足', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, tokenBudget: 1000000 },
    }), executor);

    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      return finalResponse('Here is the summary.\n<status>complete</status>', { input: 100, output: 50 });
    });

    const result = await harness.run('Summarize the project', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
    // complete 标记 → 只调用 1 次
    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  it('模型声明 incomplete 时继续，直到 complete', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, tokenBudget: 1000000 },
    }), executor);

    let callCount = 0;
    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return finalResponse(`Part ${callCount}\n<status>incomplete</status>`, { input: 100, output: 50 });
      }
      return finalResponse(`Final part\n<status>complete</status>`, { input: 100, output: 50 });
    });

    const result = await harness.run('Long task', chatFn);

    expect(result.loopState.stopReason).toBe('model_done');
    // 2 次 incomplete + 1 次 complete = 3 次
    expect(chatFn).toHaveBeenCalledTimes(3);
  });

  it('无 status 标记时直接停止（兼容旧行为）', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      loop: { maxRounds: 100, tokenBudget: 1000000 },
    }), executor);

    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      return finalResponse('Done, no status tag.', { input: 100, output: 50 });
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
  it('用户允许时正常执行破坏性工具', async () => {
    const tools = [makeTool('delete_file')];
    const executor = createToolExecutor(tools, async () => ({ success: true, output: 'Deleted' }));
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      onConfirm: async () => true,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'delete_file', args: { path: 'temp.txt' } }]),
      finalResponse('File deleted'),
    ]);

    const result = await harness.run('Delete temp.txt', chatFn);

    expect(result.content).toBe('File deleted');
    expect(result.loopState.totalToolCalls).toBe(1);
  });

  it('用户拒绝时跳过工具并通知 LLM', async () => {
    const tools = [makeTool('delete_file')];
    const handler = vi.fn().mockResolvedValue({ success: true, output: 'Deleted' });
    const executor = createToolExecutor(tools, handler);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      onConfirm: async () => false,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'delete_file', args: { path: 'important.txt' } }]),
      finalResponse('OK, I will not delete it'),
    ]);

    const result = await harness.run('Delete important.txt', chatFn);

    expect(result.content).toBe('OK, I will not delete it');
    expect(handler).not.toHaveBeenCalled();
    const toolMsg = result.messages.find(m => m.role === 'tool' && typeof m.content === 'string' && (m.content as string).includes('用户拒绝'));
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
    expect(types).toContain('tool_result');
    expect(types).toContain('final');

    const toolCallEvent = events.find(e => e.type === 'tool_call');
    expect(toolCallEvent!.toolName).toBe('read_file');

    const toolResultEvent = events.find(e => e.type === 'tool_result');
    expect(toolResultEvent!.toolSuccess).toBe(true);
  });

  it('破坏性工具拒绝时触发 tool_confirm + tool_denied 事件', async () => {
    const tools = [makeTool('delete_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      onConfirm: async () => false,
    }), executor);

    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'delete_file' }]),
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
  it('LLM 返回空内容时正常处理', async () => {
    const tools = [makeTool('read_file')];
    const executor = createToolExecutor(tools);
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), executor);

    const chatFn = createChatFn([finalResponse('')]);
    const result = await harness.run('test', chatFn);

    expect(result.content).toBe('');
    expect(result.loopState.stopReason).toBe('model_done');
  });

  it('工具调用带 reasoningContent 时正确保存到消息', async () => {
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
    const assistantMsg = result.messages.find(m => m.role === 'assistant' && m.reasoningContent);
    expect(assistantMsg?.reasoningContent).toBe('I need to read the file first');
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
    const chatFn: ChatFunction = vi.fn().mockImplementation(async () => {
      callCount++;
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
    // 前面的旧 tool 消息应该被裁剪
    const firstToolMsg = toolMsgs[0];
    const firstContent = firstToolMsg.content as string;
    // 如果有超过 6 条 tool 消息，前面的应该被裁剪
    if (toolMsgs.length > 6) {
      expect(firstContent.length).toBeLessThan(longOutput.length);
      expect(firstContent).toContain('工具结果已裁剪');
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
