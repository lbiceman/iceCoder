/**
 * Harness 全链路：任务图 done 强制 stop 闸门。
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { Harness } from '../../src/harness/harness.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import { resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import type { HarnessConfig, HarnessStepEvent, ChatFunction } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition } from '../../src/llm/types.js';
import type { ToolResult } from '../../src/tools/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

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

function finalResponse(content: string): LLMResponse {
  return { content, usage: makeUsage(), finishReason: 'stop' };
}

function toolCallResponse(calls: { id: string; name: string; args?: Record<string, unknown> }[]): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: makeUsage(),
    finishReason: 'tool_calls',
  };
}

function createToolExecutor(tools: ToolDefinition[], workspaceRoot = process.cwd()): ToolExecutor {
  const registry = new ToolRegistry();
  for (const t of tools) {
    registry.register({
      definition: t,
      handler: async (args) => {
        if (t.name === 'write_file') {
          const rel = String(args.path ?? '');
          const abs = join(workspaceRoot, rel);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, String(args.content ?? ''), 'utf8');
        }
        return { success: true, output: 'ok' } as ToolResult;
      },
    });
  }
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5000 });
}

function minConfig(overrides?: Partial<HarnessConfig>): HarnessConfig {
  return {
    context: {
      systemPrompt: 'test',
      tools: overrides?.context?.tools ?? [makeTool('read_file')],
    },
    loop: { maxRounds: overrides?.loop?.maxRounds ?? 20 },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999999,
    memoryDir: '__test_nonexistent_memory_dir__',
    sessionDir: '__test_nonexistent_session_dir__',
    ...overrides,
  };
}

function createChatFn(responses: LLMResponse[]): ChatFunction {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)];
}

function finishGraph(graphExecutor: GraphExecutor): void {
  graphExecutor.initGraph({ goal: 'run unit tests', intent: 'test' });
  markGraphDone(graphExecutor);
}

function markGraphDone(graphExecutor: GraphExecutor): void {
  for (let n = 0; n < 12; n++) {
    if (graphExecutor.advanceOrComplete().graphDone) break;
  }
}

function harnessGraph(harness: Harness): GraphExecutor {
  return (harness as unknown as { graphExecutor: GraphExecutor }).graphExecutor;
}

describe('Harness graph terminal stop (integration)', () => {
  it('图已 done 且无 pendingWork：首轮 prep 后即 model_done，不调 LLM', async () => {
    const tools = [makeTool('read_file')];
    const supervisorConfig = resolveSupervisorConfig({ mode: 'strict' }, {});
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
    }), createToolExecutor(tools));
    const ge = harnessGraph(harness);
    vi.spyOn(ge, 'initGraph').mockImplementation(function (this: GraphExecutor, opts) {
      GraphExecutor.prototype.initGraph.call(this, opts);
      markGraphDone(this);
    });

    const chatFn = vi.fn(createChatFn([
      toolCallResponse([{ id: 't1', name: 'read_file' }]),
    ]));
    const events: HarnessStepEvent[] = [];

    const result = await harness.run('implement auth module', chatFn, e => events.push(e));

    expect(chatFn).not.toHaveBeenCalled();
    expect(result.loopState.stopReason).toBe('model_done');
    expect(events.some(e => e.type === 'task_graph_done')).toBe(true);
    expect(events.some(e => e.type === 'final' && e.stopReason === 'model_done')).toBe(true);
  });

  it('工具轮结束后图变 done：强制 model_done，不再进入下一轮 LLM', async () => {
    const tools = [makeTool('read_file')];
    const harness = new Harness(minConfig({ context: { systemPrompt: 'test', tools } }), createToolExecutor(tools));
    const ge = harnessGraph(harness);
    ge.initGraph({ goal: 'run unit tests', intent: 'test' });
    expect(ge.isGraphDoneForHarnessStop()).toBe(false);

    const chatFn = vi.fn(createChatFn([
      toolCallResponse([{ id: 't1', name: 'read_file' }]),
      toolCallResponse([{ id: 't2', name: 'read_file' }]),
    ]));
    const events: HarnessStepEvent[] = [];

    const result = await harness.run('run unit tests', chatFn, (e) => {
      events.push(e);
      if (e.type === 'tool_result' && !ge.isGraphDoneForHarnessStop()) {
        finishGraph(ge);
      }
    });

    expect(chatFn).toHaveBeenCalledTimes(1);
    expect(result.loopState.stopReason).toBe('model_done');
    expect(events.filter(e => e.type === 'final')).toHaveLength(1);
  });

  it('图 done 但有 pendingWork：继续跑，不因闸门误停', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'ice-graph-stop-'));
    try {
      const tools = [makeTool('write_file')];
      const harness = new Harness(minConfig({
        context: { systemPrompt: 'test', tools },
        workspaceRoot,
      }), createToolExecutor(tools, workspaceRoot));
      const ge = harnessGraph(harness);
      ge.initGraph({ goal: 'run unit tests', intent: 'test' });

      const chatFn = vi.fn(createChatFn([
        toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'src/a.ts', content: 'x' } }]),
        finalResponse('continuing verification'),
      ]));

      const result = await harness.run('run unit tests and fix src/a.ts', chatFn, (e) => {
        if (e.type === 'tool_result' && !ge.isGraphDoneForHarnessStop()) {
          finishGraph(ge);
        }
      });

      expect(chatFn).toHaveBeenCalledTimes(2);
      expect(result.content).toContain('continuing verification');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
