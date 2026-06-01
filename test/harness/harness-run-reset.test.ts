/**
 * harness.run() 每次用户发送时的门控 / 上下文 / 实例状态归零（集成）。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Harness } from '../../src/harness/harness.js';
import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';
import { DEFAULT_BRANCH_BUDGET } from '../../src/harness/branch-budget.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import { MAX_REBUILD_ESCALATIONS_PER_RUN } from '../../src/harness/harness-constants.js';
import { resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import { createSupervisorRuntimeBridge } from '../../src/harness/supervisor/supervisor-bridge.js';
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
  const runtimeV2 = emptyRuntimeCheckpointV2('verification_failed');
  runtimeV2.branchBudget = {
    fileEdits: { 'src/stale.ts': DEFAULT_BRANCH_BUDGET.fileEditMax + 1 },
    commandRetries: { 'npm test': DEFAULT_BRANCH_BUDGET.commandRetryMax + 1 },
    errorRepeats: { boom: DEFAULT_BRANCH_BUDGET.errorRepeatMax + 1 },
    recoverTriggers: 7,
    writeBypassPaths: ['src/stale.ts'],
    commandRetryBypassKeys: ['npm test'],
  };
  runtimeV2.rebuildEscalationInjections = MAX_REBUILD_ESCALATIONS_PER_RUN;
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
  runtimeV2.supervisorState = {
    executionMode: 'forced',
    executionModeLockRemaining: 0,
    executionModeEnteredBy: ['tool_failure'],
    executionModeEnteredByPrimary: 'tool_failure',
    executionModeEnteredAtRound: 8,
    pendingModeSignals: [],
    forcedTaskBearingRoundsSinceEntry: 3,
    supervisorPhase: 'takeover',
    correctionBudgetUsed: 5,
    segmentRenewalCount: 2,
    recoverySupervisorSnapshot: {
      phase: 'takeover',
      takeoverStartRound: 4,
      stableRoundsInTakeover: 0,
      cooldownRemaining: 0,
    },
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

function adaptiveHarness(sessionDir: string, tools: ToolDefinition[], handler?: Parameters<typeof createToolExecutor>[1]) {
  const supervisorConfig = resolveSupervisorConfig({ mode: 'adaptive' }, {});
  const bridge = createSupervisorRuntimeBridge(supervisorConfig, { memoryOnly: true });
  const harness = new Harness(minConfig({
    context: { systemPrompt: 'test', tools },
    sessionDir,
    supervisorConfig,
    globalPolicy: supervisorConfig.globalPolicy,
    supervisorBridge: bridge,
  }), createToolExecutor(tools, handler));
  return { harness, bridge };
}

function harnessCheckpointEngine(harness: Harness) {
  return (harness as unknown as {
    checkpointEngine?: {
      loadV2(): Promise<unknown>;
      pendingRecoverySignals(): unknown[];
    };
  }).checkpointEngine;
}

const originalSupervisorEnv = process.env.ICE_SUPERVISOR_MODE;

beforeEach(() => {
  delete process.env.ICE_SUPERVISOR_MODE;
});

afterEach(async () => {
  if (originalSupervisorEnv === undefined) {
    delete process.env.ICE_SUPERVISOR_MODE;
  } else {
    process.env.ICE_SUPERVISOR_MODE = originalSupervisorEnv;
  }
  vi.restoreAllMocks();
});

describe('harness.run() per-user-message reset', () => {
  it('clears stale verification buffer, recovery signals, and keeps supervisor phase free', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    await seedStaleCheckpoint(sessionDir);
    const { harness, bridge } = adaptiveHarness(sessionDir, tools);

    const result = await harness.run('brand new task', createChatFn([finalResponse('ok')]));

    const userText = result.messages
      .filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(userText).not.toContain('stale cross-run warning');
    expect(userText).not.toContain('stale.test.ts');
    expect(result.loopState.executionMode).toBe('free');
    expect(result.loopState.supervisorPhase).toBe('free');
    expect(bridge.getCorrectionBudgetUsage().used).toBe(0);
    expect(bridge.getSegmentRenewalCount()).toBe(0);
  });

  it('does not inherit acceptanceGate progress from checkpoint', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    await seedStaleCheckpoint(sessionDir);
    const { harness, bridge } = adaptiveHarness(sessionDir, tools);

    const longGoal = [
      'Implement full benchmark pipeline:',
      '1. run npm ci',
      '2. run npm test',
      '3. run npm run build',
      '4. run npm run test:e2e',
    ].join('\n');

    await harness.run(longGoal, createChatFn([finalResponse('starting')]));

    expect(bridge.getSupervisorPhase()).toBe('free');
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

  it('allows file edits after checkpoint had exhausted branchBudget counters', async () => {
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
        if (e.type === 'tool_result' && typeof e.output === 'string' && e.output.includes('[BranchBudget / Blocked]')) {
          blocked.push(e.output);
        }
      },
    );

    expect(editAttempts).toBe(1);
    expect(blocked).toHaveLength(0);
  });

  it('resetGraph at run() clears graph seeded before run()', async () => {
    const sessionDir = await tempSessionDir();
    const tools = [makeTool('read_file')];
    const { harness } = adaptiveHarness(sessionDir, tools);
    const ge = (harness as unknown as { graphExecutor: GraphExecutor }).graphExecutor;
    ge.initGraph({ goal: 'stale graph goal', intent: 'edit' });
    expect(ge.hasGraph()).toBe(true);

    const events: HarnessStepEvent[] = [];
    await harness.run('new work', createChatFn([finalResponse('ok')]), e => events.push(e));

    expect(ge.hasGraph()).toBe(false);
    expect(events.some(e => e.type === 'task_graph_node')).toBe(false);
  });

  it('discardPendingRecoverySignals clears pending on harness checkpoint engine', async () => {
    const sessionDir = await tempSessionDir();
    await seedStaleCheckpoint(sessionDir);

    const tools = [makeTool('read_file')];
    const { harness } = adaptiveHarness(sessionDir, tools);
    const engine = harnessCheckpointEngine(harness)!;
    await engine.loadV2();
    expect(engine.pendingRecoverySignals().length).toBeGreaterThan(0);

    await harness.run('fresh', createChatFn([finalResponse('ok')]));
    expect(engine.pendingRecoverySignals()).toHaveLength(0);
  });
});
