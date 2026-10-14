/**
 * Harness 审计 P4 的端到端 eval（脚本驱动 LLM，不打真实 API）。
 * #85：沿用旧任务只判断一次，新问题不恢复 V3，续聊会恢复。
 * #87：adaptive 不建任务图，forced 时工具门不按步骤拦；strict 的工程任务会建图并拦住不合步骤的工具。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import { resolveGlobalPolicy, resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import {
  SUPERVISOR_MODE_CONTRACT,
  supervisorModeBuildsTaskGraph,
} from '../../src/harness/supervisor/supervisor-mode-contract.js';
import {
  buildHarnessToolGateContext,
  executeToolCallsThroughGate,
} from '../../src/harness/supervisor/tool-gate.js';
import type { ChatFunction, HarnessConfig, HarnessStepEvent } from '../../src/harness/types.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { LLMResponse, ToolCall, ToolDefinition } from '../../src/llm/types.js';
import type { SupervisorMode } from '../../src/types/supervisor.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolHandler } from '../../src/tools/types.js';

function makeTool(name: string): ToolDefinition {
  return { name, description: `eval ${name}`, parameters: { type: 'object', properties: {} } };
}

function usage(): LLMResponse['usage'] {
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
    executor: new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5_000 }),
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
  vi.spyOn(mem.memoryDream, 'recordSession').mockResolvedValue(undefined);
}

function modeConfig(mode: SupervisorMode): Pick<HarnessConfig, 'supervisorConfig' | 'globalPolicy'> {
  const supervisorConfig = resolveSupervisorConfig({ mode });
  return { supervisorConfig, globalPolicy: supervisorConfig.globalPolicy };
}

const EDIT_GOAL = '修改 src/app.ts 的标题';
const V3_HYDRATE = '已从 V3 checkpoint 恢复执行与完成状态';

describe('eval: harness audit P4 #85 #87', () => {
  let workDir: string;

  beforeEach(async () => {
    process.env.ICE_EVAL_MODE = '1';
    workDir = await fs.mkdtemp(path.join(tmpdir(), 'ice-eval-p4b-'));
  });

  afterEach(async () => {
    delete process.env.ICE_EVAL_MODE;
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('keeps supervisor mode capabilities aligned with the global policy', async () => {
    const modes: SupervisorMode[] = ['off', 'adaptive', 'strict'];
    for (const mode of modes) {
      const contract = SUPERVISOR_MODE_CONTRACT[mode];
      const policy = resolveGlobalPolicy({ mode });
      expect(policy.modeDecisionEngineEnabled).toBe(contract.usesExecutionMode);
      expect(supervisorModeBuildsTaskGraph(mode)).toBe(contract.buildsTaskGraph);
      expect(contract.buildsTaskGraph).toBe(mode === 'strict');
    }

    const welcome = await fs.readFile(path.join('src', 'public', 'js', 'chat-welcome.ts'), 'utf8');
    const sidebar = await fs.readFile(path.join('src', 'public', 'js', 'chat-session-sidebar.ts'), 'utf8');
    for (const contract of Object.values(SUPERVISOR_MODE_CONTRACT)) {
      expect(welcome).toContain(contract.summary);
      expect(sidebar).toContain(contract.summary);
    }
  });

  it('builds a task graph only in strict, and adaptive forced does not block tools by step', async () => {
    const steps: HarnessStepEvent[] = [];
    const writes: string[] = [];
    const { executor, tools } = createToolExecutor({
      write_file: async (args) => {
        writes.push(String(args.path ?? ''));
        return { success: true, output: 'wrote' };
      },
    });
    const harness = new Harness(minConfig({
      tools,
      workspaceRoot: workDir,
      ...modeConfig('adaptive'),
    }), executor);
    stubMemoryPersist(harness);
    let round = 0;
    const chatFn: ChatFunction = async () => {
      round += 1;
      if (round === 1) {
        return toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'src/app.ts', content: 'title' } }]);
      }
      return finalResponse('标题已改。');
    };
    const adaptive = await harness.run(EDIT_GOAL, chatFn, (event) => steps.push(event));
    expect(adaptive.loopState.stopReason).toBe('model_done');
    expect(writes).toEqual(['src/app.ts']);
    expect(steps.some(event => event.type === 'task_graph_init')).toBe(false);

    const strictSteps: HarnessStepEvent[] = [];
    const strictTools = createToolExecutor({
      write_file: async () => ({ success: true, output: 'wrote' }),
    });
    const strictHarness = new Harness(minConfig({
      tools: strictTools.tools,
      workspaceRoot: workDir,
      ...modeConfig('strict'),
    }), strictTools.executor);
    stubMemoryPersist(strictHarness);
    const strictResult = await strictHarness.run(EDIT_GOAL, async () => finalResponse('看过了。'), (event) => {
      strictSteps.push(event);
    });
    expect(strictResult.loopState.stopReason).toBe('model_done');
    expect(strictSteps.some(event => event.type === 'task_graph_init')).toBe(true);

    const questionSteps: HarnessStepEvent[] = [];
    const questionTools = createToolExecutor({
      read_file: async () => ({ success: true, output: 'body' }),
    });
    const questionHarness = new Harness(minConfig({
      tools: questionTools.tools,
      workspaceRoot: workDir,
      ...modeConfig('strict'),
    }), questionTools.executor);
    stubMemoryPersist(questionHarness);
    await questionHarness.run('为什么我今天这么困', async () => finalResponse('先休息一下。'), (event) => {
      questionSteps.push(event);
    });
    expect(questionSteps.some(event => event.type === 'task_graph_init')).toBe(false);

    const graph = new GraphExecutor();
    graph.initGraph({ goal: EDIT_GOAL, intent: 'edit' });
    const forced = { executionMode: 'forced' } as HarnessRunState;
    const remove: ToolCall = { id: 'd1', name: 'delete_file', arguments: { path: 'src/app.ts' } };
    const blocked = executeToolCallsThroughGate({
      toolCalls: [remove],
      messages: [],
      ctx: buildHarnessToolGateContext(graph, [remove], forced),
    });
    expect(blocked.executableToolCalls).toEqual([]);

    const passthrough = executeToolCallsThroughGate({
      toolCalls: [remove],
      messages: [],
      ctx: buildHarnessToolGateContext(undefined, [remove], forced),
    });
    expect(passthrough.executableToolCalls.map(call => call.id)).toEqual(['d1']);
  });

  it('restores the previous task on continue and leaves it behind for a fresh question', async () => {
    const sessionDir = path.join(workDir, 'session');
    await fs.mkdir(sessionDir);
    const { executor, tools } = createToolExecutor({
      write_file: async () => ({ success: true, output: 'wrote' }),
    });
    const seed = new Harness(minConfig({
      tools,
      workspaceRoot: workDir,
      sessionDir,
    }), executor);
    stubMemoryPersist(seed);
    let round = 0;
    const seeded = await seed.run(EDIT_GOAL, async () => {
      round += 1;
      if (round === 1) {
        return toolCallResponse([{ id: 'w1', name: 'write_file', args: { path: 'src/app.ts', content: 'title' } }]);
      }
      return finalResponse('标题已改。');
    });
    expect(seeded.loopState.stopReason).toBe('model_done');
    const checkpointPath = path.join(sessionDir, 'default.checkpoint.json');
    const checkpoint = await fs.readFile(checkpointPath);

    const continueDir = path.join(workDir, 'continue');
    const freshDir = path.join(workDir, 'fresh');
    await fs.mkdir(continueDir);
    await fs.mkdir(freshDir);
    await fs.writeFile(path.join(continueDir, 'default.checkpoint.json'), checkpoint);
    await fs.writeFile(path.join(freshDir, 'default.checkpoint.json'), checkpoint);

    async function followUp(dir: string, message: string): Promise<HarnessStepEvent[]> {
      const events: HarnessStepEvent[] = [];
      const nextTools = createToolExecutor({
        read_file: async () => ({ success: true, output: 'body' }),
      });
      const harness = new Harness(minConfig({
        tools: nextTools.tools,
        workspaceRoot: workDir,
        sessionDir: dir,
      }), nextTools.executor);
      stubMemoryPersist(harness);
      const result = await harness.run(message, async () => finalResponse('好。'), (event) => events.push(event));
      expect(result.loopState.stopReason).toBe('model_done');
      return events;
    }

    const continued = await followUp(continueDir, '继续');
    const fresh = await followUp(freshDir, '为什么我今天这么困');
    expect(continued.some(event => event.type === 'memory_event' && event.memoryDetail === V3_HYDRATE)).toBe(true);
    expect(fresh.some(event => event.type === 'memory_event' && event.memoryDetail === V3_HYDRATE)).toBe(false);
  });
});
