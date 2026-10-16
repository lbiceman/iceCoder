/**
 * harness.run() 每次用户发送时的门控 / 上下文 / 实例状态归零（集成）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';
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

function toolCallResponse(calls: { id: string; name: string; args?: Record<string, unknown> }[]): LLMResponse {
  return {
    content: '',
    toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    usage: makeUsage(),
    finishReason: 'tool_calls',
  };
}

function createToolExecutor(
  tools: ToolDefinition[],
  handler: (name: string, args: Record<string, unknown>) => Promise<ToolResult> = async () => ({
    success: true,
    output: 'ok',
  }),
): ToolExecutor {
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register({
      definition: tool,
      handler: async (args) => handler(tool.name, args),
    });
  }
  return new ToolExecutor(registry, { maxRetries: 0, retryBaseDelay: 0, retryMaxDelay: 0, toolTimeout: 5000 });
}

function minConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  const tools = overrides.context?.tools ?? [makeTool('read_file')];
  return {
    context: { systemPrompt: 'test', tools },
    loop: { maxRounds: overrides.loop?.maxRounds ?? 10 },
    compactionThreshold: 9999,
    compactionTokenThreshold: 999999,
    memoryDir: '__test_nonexistent_memory_dir__',
    ...overrides,
  };
}

async function tempSessionDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-run-reset-'));
}

function buildRunningCheckpoint(): TaskCheckpoint {
  return {
    version: 1,
    taskId: 'reset-task',
    status: 'running',
    userGoal: 'old goal',
    phase: 'editing',
    taskState: {
      goal: 'old goal',
      intent: 'question',
      phase: 'editing',
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
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
      currentRound: 99,
      totalToolCalls: 50,
      totalInputTokens: 9999,
      totalOutputTokens: 8888,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function seedStaleCheckpoint(sessionDir: string): Promise<void> {
  const runtimeV2 = emptyRuntimeCheckpointV2('verification_failed') as ReturnType<typeof emptyRuntimeCheckpointV2>
    & Record<string, unknown>;
  // 旧版本写入的写次数、执行档与 recovery signal：新版本必须照常打开并忽略。
  runtimeV2.branchBudget = {
    fileEdits: { 'src/stale.ts': 4 },
    commandRetries: { 'npm test': 3 },
    errorRepeats: { boom: 4 },
    recoverTriggers: 7,
    writeBypassPaths: ['src/stale.ts'],
    commandRetryBypassKeys: ['npm test'],
  };
  runtimeV2.rebuildEscalationInjections = 3;
  runtimeV2.parallelBudgetBlockHintInjected = true;
  runtimeV2.verificationOutputTail = [{
    command: 'npm test',
    outputBody: 'FAIL stale.test.ts — should not appear',
    at: Date.now(),
  }];
  runtimeV2.acceptanceGate = {
    active: true,
    commands: [
      { key: 'npm ci', label: 'npm ci', status: 'passed' },
      { key: 'npm test', label: 'npm test', status: 'pending' },
    ],
  };
  runtimeV2.recoverySignals = [{
    source: 'branch_budget',
    message: '[System / BranchBudget] stale cross-run warning',
    at: 1,
    consumed: false,
  }];
  runtimeV2.executionModeState = {
    executionMode: 'forced',
    executionModeLockRemaining: 0,
    executionModeEnteredBy: ['tool_failure'],
    executionModeEnteredByPrimary: 'tool_failure',
    executionModeEnteredAtRound: 8,
    pendingModeSignals: [],
    forcedTaskBearingRoundsSinceEntry: 3,
  };

  await fs.writeFile(
    path.join(sessionDir, 'default.checkpoint.json'),
    JSON.stringify({ ...buildRunningCheckpoint(), runtimeV2 }, null, 2),
    'utf-8',
  );
}

function createChatFn(responses: LLMResponse[]): ChatFunction {
  const queue = [...responses];
  return vi.fn().mockImplementation(async () => (
    queue.length > 0 ? queue.shift()! : finalResponse('done')
  ));
}

function sessionHarness(sessionDir: string, tools: ToolDefinition[], handler?: Parameters<typeof createToolExecutor>[1]) {
  const harness = new Harness(minConfig({
    context: { systemPrompt: 'test', tools },
    sessionDir,
  }), createToolExecutor(tools, handler));
  return { harness };
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe('harness.run() per-user-message reset', () => {
  it('clears stale verification buffer and recovery signals', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    await seedStaleCheckpoint(sessionDir);
    const { harness } = sessionHarness(sessionDir, tools);

    const result = await harness.run('brand new task', createChatFn([finalResponse('ok')]));

    const userText = result.messages
      .filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(result.loopState.stopReason).toBe('model_done');
    expect(userText).not.toContain('stale cross-run warning');
    expect(userText).not.toContain('stale.test.ts');
    expect(result.loopState).not.toHaveProperty('executionMode');
  });

  it('does not inherit acceptanceGate progress from checkpoint', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    await seedStaleCheckpoint(sessionDir);
    const { harness } = sessionHarness(sessionDir, tools);

    const longGoal = [
      'Implement full benchmark pipeline:',
      '1. run npm ci',
      '2. run npm test',
      '3. run npm run build',
      '4. run npm run test:e2e',
    ].join('\n');

    const result = await harness.run(longGoal, createChatFn([finalResponse('starting')]));

    expect(result.loopState.stopReason).toBe('model_done');
    expect(harness.getLoopState()).not.toHaveProperty('executionMode');
  });

  it('resets loop round counter on each run (same harness instance)', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
    }), createToolExecutor(tools));

    await seedStaleCheckpoint(sessionDir);

    const first = await harness.run(
      'first message',
      createChatFn([
        toolCallResponse([{ id: 't1', name: 'read_file' }]),
        finalResponse('first done'),
      ]),
    );
    expect(first.loopState.currentRound).toBe(2);

    const second = await harness.run(
      'second message',
      createChatFn([finalResponse('second done')]),
      undefined,
      [...first.messages],
    );
    expect(second.loopState.currentRound).toBe(1);
    expect(second.loopState.totalInputTokens).toBeLessThan(first.loopState.totalInputTokens + 5000);
  });

  it('allows file edits after an old checkpoint had exhausted write counters', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('edit_file')];
    let editAttempts = 0;
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
    }), createToolExecutor(tools, async (name) => {
      if (name === 'edit_file') editAttempts += 1;
      return { success: true, output: 'ok' };
    }));

    await seedStaleCheckpoint(sessionDir);

    const blocked: string[] = [];
    await harness.run(
      'fix src/stale.ts',
      createChatFn([
        toolCallResponse([{ id: 'e1', name: 'edit_file', args: { path: 'src/stale.ts', content: 'a' } }]),
        finalResponse('done'),
      ]),
      (e) => {
        const text = [e.toolOutput, e.toolError, e.content]
          .filter((value): value is string => typeof value === 'string')
          .join('\n');
        if (e.type === 'tool_result' && text.includes('[BranchBudget / Blocked]')) {
          blocked.push(text);
        }
      },
    );

    expect(editAttempts).toBe(1);
    expect(blocked).toHaveLength(0);
  });

  it('runs every same-path edit_file across tool rounds without a per-file cap', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('edit_file')];
    let editAttempts = 0;
    const blocked: string[] = [];
    const harness = new Harness(minConfig({
      context: { systemPrompt: 'test', tools },
      sessionDir,
    }), createToolExecutor(tools, async (name) => {
      if (name === 'edit_file') editAttempts += 1;
      return { success: true, output: 'ok' };
    }));

    await harness.run(
      'fix package.json',
      createChatFn([
        toolCallResponse([{ id: 'e1', name: 'edit_file', args: { path: 'package.json', content: 'a' } }]),
        toolCallResponse([{ id: 'e2', name: 'edit_file', args: { path: 'package.json', content: 'b' } }]),
        toolCallResponse([{ id: 'e3', name: 'edit_file', args: { path: 'package.json', content: 'c' } }]),
        toolCallResponse([{ id: 'e4', name: 'edit_file', args: { path: 'package.json', content: 'd' } }]),
        finalResponse('done'),
      ]),
      (e) => {
        const text = [e.toolOutput, e.toolError, e.content]
          .filter((value): value is string => typeof value === 'string')
          .join('\n');
        if (e.type === 'tool_result' && text.includes('[BranchBudget / Blocked]')) {
          blocked.push(text);
        }
      },
    );

    expect(editAttempts).toBe(4);
    expect(blocked).toHaveLength(0);
  });

  it('emits execution_plan_clear at run start so the workbench resets', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    const { harness } = sessionHarness(sessionDir, tools);

    const events: HarnessStepEvent[] = [];
    await harness.run('new work', createChatFn([finalResponse('ok')]), e => events.push(e));

    expect(events[0]?.type).toBe('execution_plan_clear');
    expect(events.some(e => String(e.type).startsWith('task_graph'))).toBe(false);
    expect(events.some(e => String(e.type).startsWith('execution_mode'))).toBe(false);
  });
});
