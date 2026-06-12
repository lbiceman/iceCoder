import { describe, expect, it, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMResponse, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import type { ChatFunction } from '../../src/harness/types.js';
import { Harness } from '../../src/harness/harness.js';
import { SubAgentRunner, clearSubAgentCacheForTests } from '../../src/harness/sub-agent-runner.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import type { ToolResult } from '../../src/tools/types.js';

function usage() {
  return { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'test' };
}

function tool(name: string, parameters: Record<string, any> = { type: 'object', properties: {} }): ToolDefinition {
  return { name, description: `Tool ${name}`, parameters };
}

function response(content: string, toolCalls?: LLMResponse['toolCalls']): LLMResponse {
  return {
    content,
    toolCalls,
    usage: usage(),
    finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
  };
}

function executorFor(
  definitions: ToolDefinition[],
  handler: (name: string, args: Record<string, any>) => Promise<ToolResult>,
): ToolExecutor {
  const registry = new ToolRegistry();
  for (const definition of definitions) {
    registry.register({
      definition,
      handler: (args) => handler(definition.name, args),
    });
  }
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 1000 });
}

const readFileTool = tool('read_file', {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
});

const grepTool = tool('grep', {
  type: 'object',
  properties: { pattern: { type: 'string' } },
  required: ['pattern'],
});

const fsTool = tool('fs_operation', {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['list', 'create_dir', 'delete'] },
    path: { type: 'string' },
  },
  required: ['operation', 'path'],
});

describe('SubAgentRunner', () => {
  afterEach(() => {
    clearSubAgentCacheForTests();
    vi.unstubAllEnvs?.();
  });

  it('runs a read-only exploration loop and returns a structured result', async () => {
    const definitions = [readFileTool, grepTool, fsTool];
    const executor = executorFor(definitions, async (name, args) => ({
      success: true,
      output: `${name} ok: ${args.path ?? args.pattern ?? ''}`,
    }));
    const chatFn = vi.fn<ChatFunction>()
      .mockResolvedValueOnce(response('reading', [
        { id: 'read-1', name: 'read_file', arguments: { path: 'src/index.ts' } },
      ]))
      .mockResolvedValueOnce(response('Core findings: index wires startup logic.'));

    const runner = new SubAgentRunner({ toolExecutor: executor, toolDefinitions: definitions, chatFn });
    const result = await runner.run({ task: 'Explore startup flow' });

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('startup logic');
    expect(result.filesRead).toEqual(['src/index.ts']);
    expect(result.toolCallCount).toBe(1);
    expect(result.tokensUsed).toBe(30);
  });

  it('rejects tools outside the read-only whitelist without executing them', async () => {
    const definitions = [readFileTool, tool('write_file')];
    const handler = vi.fn(async () => ({ success: true, output: 'should not run' }));
    const executor = executorFor(definitions, handler);
    const chatFn = vi.fn<ChatFunction>()
      .mockResolvedValueOnce(response('trying write', [
        { id: 'write-1', name: 'write_file', arguments: { path: 'x.ts', content: 'x' } },
      ]))
      .mockResolvedValueOnce(response('Coverage gaps: write was rejected.'));

    const runner = new SubAgentRunner({ toolExecutor: executor, toolDefinitions: definitions, chatFn });
    const result = await runner.run({ task: 'Try an invalid tool' });

    expect(result.status).toBe('completed');
    expect(handler).not.toHaveBeenCalled();
    const secondMessages = chatFn.mock.calls[1][0] as UnifiedMessage[];
    expect(secondMessages.some(m => m.role === 'tool' && String(m.content).includes('不允许调用 write_file'))).toBe(true);
  });

  it('only allows fs_operation list in sub-agents', async () => {
    const definitions = [fsTool];
    const handler = vi.fn(async () => ({ success: true, output: 'should not run' }));
    const executor = executorFor(definitions, handler);
    const chatFn = vi.fn<ChatFunction>()
      .mockResolvedValueOnce(response('creating dir', [
        { id: 'fs-1', name: 'fs_operation', arguments: { operation: 'create_dir', path: 'tmp' } },
      ]))
      .mockResolvedValueOnce(response('Coverage gaps: create_dir was rejected.'));

    const runner = new SubAgentRunner({ toolExecutor: executor, toolDefinitions: definitions, chatFn });
    const result = await runner.run({ task: 'List files only' });

    expect(result.status).toBe('completed');
    expect(handler).not.toHaveBeenCalled();
    const secondMessages = chatFn.mock.calls[1][0] as UnifiedMessage[];
    expect(secondMessages.some(m => m.role === 'tool' && String(m.content).includes('只允许 fs_operation 的 list 操作'))).toBe(true);
  });

  it('truncates large read_file and grep outputs inside the sub-agent context', async () => {
    const definitions = [readFileTool, grepTool];
    const executor = executorFor(definitions, async (name) => {
      if (name === 'read_file') {
        return { success: true, output: Array.from({ length: 260 }, (_, i) => `line ${i + 1}`).join('\n') };
      }
      return {
        success: true,
        output: Array.from({ length: 25 }, (_, i) => `file${i}.ts:1\n${'x'.repeat(650)}`).join('\n\n'),
      };
    });
    const chatFn = vi.fn<ChatFunction>()
      .mockResolvedValueOnce(response('read and search', [
        { id: 'read-1', name: 'read_file', arguments: { path: 'src/large.ts' } },
        { id: 'search-1', name: 'grep', arguments: { pattern: 'needle', maxResults: 100, output_mode: 'content' } },
      ]))
      .mockResolvedValueOnce(response('Core findings: truncated safely.'));

    const runner = new SubAgentRunner({ toolExecutor: executor, toolDefinitions: definitions, chatFn });
    await runner.run({ task: 'Check truncation behavior' });

    const secondMessages = chatFn.mock.calls[1][0] as UnifiedMessage[];
    const toolMessages = secondMessages.filter(m => m.role === 'tool').map(m => String(m.content));
    expect(toolMessages[0]).toContain('[... truncated by SubAgent: read_file output limited');
    expect(toolMessages[0]).not.toContain('line 260');
    expect(toolMessages[1]).toContain('[... truncated by SubAgent: grep output limited to 20 blocks ...]');
    expect(toolMessages[1]).not.toContain('file24.ts');
  });

  it('returns a cached result for the same task when read files are unchanged', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-subagent-cache-'));
    try {
      await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, 'src/cache.ts'), 'export const value = 1;\n');

      const definitions = [readFileTool];
      const handler = vi.fn(async () => ({ success: true, output: 'file contents' }));
      const executor = executorFor(definitions, handler);
      const chatFn = vi.fn<ChatFunction>()
        .mockResolvedValueOnce(response('reading', [
          { id: 'read-1', name: 'read_file', arguments: { path: 'src/cache.ts' } },
        ]))
        .mockResolvedValueOnce(response('Core findings: cached module.'));

      const runner = new SubAgentRunner({ toolExecutor: executor, toolDefinitions: definitions, chatFn, workspaceRoot });
      const first = await runner.run({ task: 'Unique cache task for cache.ts' });
      const second = await runner.run({ task: 'Unique cache task for cache.ts' });

      expect(first.status).toBe('completed');
      expect(second.summary).toContain('[SubAgent cache hit]');
      expect(chatFn).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('prunes global sub-agent cache by LRU when over ICE_SUBAGENT_CACHE_MAX_ENTRIES', async () => {
    vi.stubEnv('ICE_SUBAGENT_CACHE_MAX_ENTRIES', '2');
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-subagent-cache-lru-'));
    try {
      await fs.mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, 'src/cache.ts'), 'export const value = 1;\n');

      const definitions = [readFileTool];
      const handler = vi.fn(async () => ({ success: true, output: 'file contents' }));
      const executor = executorFor(definitions, handler);

      const queue: LLMResponse[] = [];
      const enqueueTwoStep = (tag: string) => {
        queue.push(response('reading', [
          { id: `read-${tag}`, name: 'read_file', arguments: { path: 'src/cache.ts' } },
        ]));
        queue.push(response(`Core findings: ${tag}.`));
      };
      enqueueTwoStep('A');
      enqueueTwoStep('B');
      enqueueTwoStep('C');
      enqueueTwoStep('A-retry');

      const chatFn = vi.fn<ChatFunction>().mockImplementation(async () => {
        const next = queue.shift();
        if (!next) throw new Error('unexpected LLM call (queue empty)');
        return next;
      });

      vi.useFakeTimers({ now: 10_000 });
      const runner = new SubAgentRunner({ toolExecutor: executor, toolDefinitions: definitions, chatFn, workspaceRoot });

      await runner.run({ task: 'task-a' });
      vi.setSystemTime(20_000);
      await runner.run({ task: 'task-b' });
      vi.setSystemTime(30_000);
      await runner.run({ task: 'task-c' });

      vi.setSystemTime(40_000);
      const againA = await runner.run({ task: 'task-a' });
      expect(againA.summary).not.toContain('[SubAgent cache hit]');

      vi.setSystemTime(50_000);
      const againC = await runner.run({ task: 'task-c' });
      expect(againC.summary).toContain('[SubAgent cache hit]');
      expect(againC.summary).toContain('Core findings: C');

      expect(handler).toHaveBeenCalledTimes(4);
      expect(chatFn).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe('Harness delegate_to_subagent integration', () => {
  it('exposes delegate_to_subagent and injects the sub-agent result as one tool result', async () => {
    const definitions = [readFileTool];
    const executor = executorFor(definitions, async () => ({ success: true, output: 'file contents' }));
    const harness = new Harness({
      context: { systemPrompt: 'test', tools: definitions },
      loop: { maxRounds: 5 },
      compactionThreshold: 999,
      compactionTokenThreshold: 999_999,
      memoryDir: '__test_nonexistent_memory_dir__',
    }, executor);

    const chatFn = vi.fn<ChatFunction>(async (messages, options) => {
      const hasSubAgentSystem = messages.some(m =>
        m.role === 'system' && typeof m.content === 'string' && m.content.includes('read-only exploration sub-agent'),
      );
      if (hasSubAgentSystem) {
        return response('Core findings: delegated summary.');
      }
      if (chatFn.mock.calls.length === 1) {
        expect(options.tools.some(t => t.name === 'delegate_to_subagent')).toBe(true);
        return response('delegating', [
          { id: 'delegate-1', name: 'delegate_to_subagent', arguments: { task: 'Explore docs' } },
        ]);
      }
      return response('Done with delegated summary.');
    });

    const result = await harness.run('Explore docs', chatFn);

    expect(result.content).toBe('Done with delegated summary.');
    expect(result.loopState.totalToolCalls).toBe(1);
    expect(result.messages.some(m =>
      m.role === 'tool'
      && m.toolCallId === 'delegate-1'
      && typeof m.content === 'string'
      && m.content.includes('[SubAgent Result]')
      && m.content.includes('delegated summary'),
    )).toBe(true);
  });

  it('does not expose delegate_to_subagent when runtime tools are disabled', async () => {
    const executor = executorFor([], async () => ({ success: true, output: 'unused' }));
    const harness = new Harness({
      context: { systemPrompt: 'test', tools: [] },
      loop: { maxRounds: 1 },
      compactionThreshold: 999,
      compactionTokenThreshold: 999_999,
      memoryDir: '__test_nonexistent_memory_dir__',
    }, executor);

    const chatFn = vi.fn<ChatFunction>(async (_messages, options) => {
      expect(options.tools).toEqual([]);
      return response('No tools available.');
    });

    await harness.run('Just answer', chatFn);
    expect(chatFn).toHaveBeenCalledTimes(1);
  });

  it('truncates sub-agent summaries older than the latest six results before LLM calls', async () => {
    const definitions = [readFileTool];
    const executor = executorFor(definitions, async () => ({ success: true, output: 'unused' }));
    const harness = new Harness({
      context: { systemPrompt: 'test', tools: definitions },
      loop: { maxRounds: 1 },
      compactionThreshold: 999,
      compactionTokenThreshold: 999_999,
      memoryDir: '__test_nonexistent_memory_dir__',
    }, executor);
    const existingMessages: UnifiedMessage[] = [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'previous task' },
    ];
    for (let i = 0; i < 7; i++) {
      existingMessages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `delegate-${i}`, name: 'delegate_to_subagent', arguments: { task: `task ${i}` } }],
      });
      existingMessages.push({
        role: 'tool',
        toolCallId: `delegate-${i}`,
        content: `[SubAgent Result]\nstatus: completed\nsummary:\nsummary-${i}-${'x'.repeat(500)}`,
      });
    }

    const chatFn = vi.fn<ChatFunction>(async (messages) => {
      const subAgentResults = messages.filter(m =>
        m.role === 'tool'
        && typeof m.content === 'string'
        && m.content.startsWith('[SubAgent Result]'),
      );
      expect(String(subAgentResults[0].content)).toContain('旧子代理摘要已裁剪');
      expect(String(subAgentResults[6].content)).not.toContain('旧子代理摘要已裁剪');
      return response('Done.');
    });

    await harness.run('Continue', chatFn, undefined, existingMessages);
  });
});
