import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';
import { resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import type { ChatFunction, HarnessConfig, HarnessStepEvent } from '../../src/harness/types.js';
import type { LLMResponse, ToolDefinition } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { ToolResult } from '../../src/tools/types.js';
import { emptyRuntimeCheckpointV2 } from '../../src/types/runtime-checkpoint.js';

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

function toolCallResponse(calls: { id: string; name: string; args?: Record<string, any> }[]): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: makeUsage(),
    finishReason: 'tool_calls',
  };
}

function createToolExecutor(
  tools: ToolDefinition[],
  handler: (args: Record<string, any>) => Promise<ToolResult> = async () => ({ success: true, output: 'ok' }),
): ToolExecutor {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register({ definition: tool, handler });
  }
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5000 });
}

function createChatFn(responses: LLMResponse[], onCall?: () => void): ChatFunction {
  const queue = [...responses];
  return vi.fn().mockImplementation(async () => {
    onCall?.();
    return queue.length > 0 ? queue.shift()! : finalResponse('fallback');
  });
}

function minConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const tools = overrides.context?.tools ?? [makeTool('read_file')];
  return {
    context: {
      systemPrompt: 'You are a test assistant.',
      tools,
    },
    loop: {
      maxRounds: overrides.loop?.maxRounds ?? 10,
      tokenBudget: overrides.loop?.tokenBudget,
      timeout: overrides.loop?.timeout,
      signal: overrides.loop?.signal,
    },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999999,
    memoryDir: '__test_nonexistent_memory_dir__',
    ...overrides,
  };
}

async function tempSessionDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-exec-mode-'));
}

function buildRunningCheckpoint(): TaskCheckpoint {
  return {
    version: 1,
    taskId: 'resume-task',
    status: 'running',
    userGoal: 'resume implementation',
    phase: 'editing',
    taskState: {
      goal: 'resume implementation',
      intent: 'question',
      phase: 'editing',
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
      verificationRequired: false,
      verificationStatus: 'not_required',
    },
    repoContext: {
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
      testCommands: [],
      recentDiagnostics: [],
    },
    failedToolCalls: [],
    messageCount: 1,
    loop: {
      currentRound: 3,
      totalToolCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const originalSupervisorEnv = process.env.ICE_SUPERVISOR_MODE;

beforeEach(() => {
  delete process.env.ICE_SUPERVISOR_MODE;
});

afterEach(() => {
  if (originalSupervisorEnv === undefined) {
    delete process.env.ICE_SUPERVISOR_MODE;
  } else {
    process.env.ICE_SUPERVISOR_MODE = originalSupervisorEnv;
  }
  vi.restoreAllMocks();
});

describe('Harness execution mode integration - Batch 3', () => {
  it('defaults to off when no supervisorConfig is provided and ICE_SUPERVISOR_MODE is unset', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('edit_file'), makeTool('write_file')];
    const events: HarnessStepEvent[] = [];

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
    }), createToolExecutor(tools));

    const result = await harness.run(
      'modify two files',
      createChatFn([finalResponse('done')]),
      event => events.push(event),
    );

    expect(events.some(event => event.type === 'execution_mode_enter')).toBe(false);
    expect(events.some(event => event.type === 'execution_mode_exit')).toBe(false);
    expect(result.loopState.executionMode).toBe('free');
  });

  it('evaluates execution mode after round prep and before the first LLM call', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('edit_file'), makeTool('write_file')];
    const events: HarnessStepEvent[] = [];
    let eventCountAtFirstLlm = -1;
    const supervisorConfig = resolveSupervisorConfig({
      mode: 'adaptive',
      executionMode: {
        modeLockRounds: 0,
        writeTargetsEnterThreshold: 1,
        stableRoundsExitThreshold: 0,
      },
    }, {});

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
    }), createToolExecutor(tools));
    const chatFn = createChatFn([finalResponse('done')], () => {
      eventCountAtFirstLlm = events.length;
    });

    const result = await harness.run('modify two files', chatFn, event => events.push(event));

    const enterEventIndex = events.findIndex(event => event.type === 'execution_mode_enter');
    expect(enterEventIndex).toBeGreaterThanOrEqual(0);
    expect(enterEventIndex).toBeLessThan(eventCountAtFirstLlm);
    expect(events[enterEventIndex]).toMatchObject({
      type: 'execution_mode_enter',
      executionMode: {
        executionMode: 'forced',
        enteredBy: ['task_graph_active', 'pending_steps', 'explicit_impl'],
        enteredByPrimary: 'task_graph_active',
        primaryReasonHuman: 'forced because task_graph_active + pending_steps + explicit_impl',
        round: 1,
      },
    });
    expect(result.loopState.executionMode).toBe('forced');
    expect(result.loopState.executionModeEnteredByPrimary).toBe('task_graph_active');
  });

  it('does not enter forced just because many write-capable tools are available', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('edit_file'), makeTool('write_file'), makeTool('run_command')];
    const events: HarnessStepEvent[] = [];
    const supervisorConfig = resolveSupervisorConfig({
      mode: 'adaptive',
      executionMode: {
        writeTargetsEnterThreshold: 0,
      },
    }, {});

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
    }), createToolExecutor(tools));

    const result = await harness.run('hello', createChatFn([finalResponse('done')]), event => events.push(event));

    expect(events.some(event => event.type === 'execution_mode_enter')).toBe(false);
    expect(result.loopState.executionMode).toBe('free');
  });

  it('keeps off mode compatible by skipping forced entry and telemetry', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('edit_file'), makeTool('write_file')];
    const events: HarnessStepEvent[] = [];
    const supervisorConfig = resolveSupervisorConfig({
      mode: 'off',
      executionMode: {
        writeTargetsEnterThreshold: 1,
      },
    }, {});

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
    }), createToolExecutor(tools));

    const result = await harness.run('change two files', createChatFn([finalResponse('done')]), event => events.push(event));

    expect(events.some(event => event.type === 'execution_mode_enter')).toBe(false);
    expect(result.loopState.executionMode).toBe('free');
  });

  it('submits checkpoint_resumed on v2 restore without directly restoring executionMode', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    const events: HarnessStepEvent[] = [];
    const runtimeV2 = emptyRuntimeCheckpointV2('manual');
    runtimeV2.supervisorState = {
      executionMode: 'forced',
      executionModeLockRemaining: 2,
      executionModeEnteredBy: ['tool_failure'],
      executionModeEnteredByPrimary: 'tool_failure',
      executionModeEnteredAtRound: 3,
      pendingModeSignals: [],
      forcedTaskBearingRoundsSinceEntry: 1,
    };
    await fs.writeFile(
      path.join(sessionDir, 'default.checkpoint.json'),
      JSON.stringify({ ...buildRunningCheckpoint(), runtimeV2 }, null, 2),
      'utf-8',
    );
    const supervisorConfig = resolveSupervisorConfig({
      mode: 'adaptive',
      executionMode: {
        modeLockRounds: 0,
      },
    }, {});

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
    }), createToolExecutor(tools));

    const result = await harness.run('resume', createChatFn([finalResponse('done')]), event => events.push(event));

    const enterEvent = events.find(event => event.type === 'execution_mode_enter');
    expect(enterEvent).toMatchObject({
      executionMode: {
        executionMode: 'forced',
        enteredBy: ['checkpoint_resumed'],
        enteredByPrimary: 'checkpoint_resumed',
        primaryReasonHuman: 'forced because checkpoint_resumed',
        round: 1,
      },
    });
    expect(result.loopState.executionModeEnteredByPrimary).toBe('checkpoint_resumed');
  });

  it('records successful tool execution as task-bearing dwell before exiting forced mode', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('edit_file')];
    const events: HarnessStepEvent[] = [];
    const supervisorConfig = resolveSupervisorConfig({
      mode: 'strict',
      executionMode: {
        modeLockRounds: 0,
        forcedMinDwellRounds: 1,
        writeTargetsEnterThreshold: 0,
        stableRoundsExitThreshold: 0,
      },
    }, {});

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
    }), createToolExecutor(tools));
    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      finalResponse('done'),
    ]);

    const result = await harness.run('hello', chatFn, event => events.push(event));

    expect(events.map(event => event.type)).toContain('execution_mode_enter');
    expect(events.map(event => event.type)).toContain('execution_mode_exit');
    expect(result.loopState.executionMode).toBe('free');
    expect(result.loopState.forcedTaskBearingRoundsSinceEntry).toBe(0);
  });

  it('does not count denied tool calls as task-bearing dwell', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('edit_file')];
    const events: HarnessStepEvent[] = [];
    const supervisorConfig = resolveSupervisorConfig({
      mode: 'strict',
      executionMode: {
        modeLockRounds: 0,
        forcedMinDwellRounds: 1,
        stableRoundsExitThreshold: 0,
      },
    }, {});

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      permissions: [{ pattern: 'edit_file', permission: 'deny', reason: 'test deny' }],
      sessionDir,
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
    }), createToolExecutor(tools));
    const chatFn = createChatFn([
      toolCallResponse([{ id: 'tc1', name: 'edit_file', args: { path: 'src/a.ts' } }]),
      finalResponse('done'),
    ]);

    const result = await harness.run('hello', chatFn, event => events.push(event));

    expect(events.map(event => event.type)).toContain('execution_mode_enter');
    expect(events.map(event => event.type)).not.toContain('execution_mode_exit');
    expect(result.loopState.executionMode).toBe('forced');
    expect(result.loopState.forcedTaskBearingRoundsSinceEntry).toBe(0);
  });

  it('enters strict floor through decision telemetry instead of initial state', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    const events: HarnessStepEvent[] = [];
    let eventCountAtFirstLlm = -1;
    const supervisorConfig = resolveSupervisorConfig({
      mode: 'strict',
      executionMode: {
        modeLockRounds: 0,
      },
    }, {});

    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
      supervisorConfig,
      globalPolicy: supervisorConfig.globalPolicy,
    }), createToolExecutor(tools));
    const chatFn = createChatFn([finalResponse('done')], () => {
      eventCountAtFirstLlm = events.length;
    });

    const result = await harness.run('hello', chatFn, event => events.push(event));

    expect(eventCountAtFirstLlm).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      type: 'execution_mode_enter',
      executionMode: {
        executionMode: 'forced',
        enteredByPrimary: 'explicit_impl',
        primaryReasonHuman: 'forced because explicit_impl',
        round: 1,
      },
    });
    expect(result.loopState.executionMode).toBe('forced');
  });
});
