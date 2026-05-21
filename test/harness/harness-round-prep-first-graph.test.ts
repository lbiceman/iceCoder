/**
 * P2-4 — `harness-round-prep.ts` 真实接入 `shouldInitTaskGraphAtFirstRound` 路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import { prepareHarnessRound } from '../../src/harness/harness-round-prep.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { createSupervisorRuntimeBridge } from '../../src/harness/supervisor/supervisor-bridge.js';
import { resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import { TaskState } from '../../src/harness/task-state.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { ChatFunction } from '../../src/harness/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

function makeState(goal: string): HarnessRunState {
  return {
    messages: [{ role: 'user', content: goal }],
    tools: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    consecutiveToolFailures: 0,
    consecutiveReadOnlyRounds: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: new TaskState(goal),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    stepReviewedThisRound: false,
    supervisorPhase: 'free',
  };
}

const chatFn: ChatFunction = async () => ({
  content: 'done',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
  finishReason: 'stop',
});

describe('harness-round-prep · firstRoundGraph integration (P2-4)', () => {
  beforeEach(() => {
    delete process.env.ICE_SUPERVISOR_MODE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('strict + edit intent: initGraph + task_graph_init step event', async () => {
    const supervisorConfig = resolveSupervisorConfig({ mode: 'strict' }, {});
    const bridge = createSupervisorRuntimeBridge(supervisorConfig, { memoryOnly: true });
    const graphExecutor = new GraphExecutor();
    const events: { type: string; graphIntent?: string }[] = [];
    const state = makeState('新增一个 logger 工具');

    await prepareHarnessRound(
      {
        loopController: new LoopController({ maxRounds: 3 }),
        memoryIntegration: new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' }),
        graphExecutor,
        contextCompactor: new ContextCompactor({ threshold: 9999 }),
        supervisorBridge: bridge,
        stopHookManager: { run: async () => ({ action: 'continue' }) } as never,
        checkpointManager: undefined,
        enqueueCheckpointPersist: async task => task(),
        resilienceV2Enabled: false,
        checkpointEngine: undefined,
        toolExecutor: new ToolExecutor(new ToolRegistry(), {
          maxRetries: 0,
          retryBaseDelay: 0,
          retryMaxDelay: 0,
          toolTimeout: 5000,
        }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
        executionModeConfig: supervisorConfig.executionMode,
        executionModeDecisionEnabled: true,
        abortSignal: undefined,
      },
      {
        state,
        userMessage: '新增一个 logger 工具',
        chatFn,
        logger: new HarnessLogger(),
        onStep: event => events.push(event),
      },
    );

    expect(graphExecutor.hasGraph()).toBe(true);
    expect(events.filter(e => e.type === 'task_graph_init')).toHaveLength(1);
    expect(events[0]?.graphIntent).toBe('edit');
  });

  it('adaptive + edit intent: §I3 skip first-round init', async () => {
    const supervisorConfig = resolveSupervisorConfig({ mode: 'adaptive' }, {});
    const bridge = createSupervisorRuntimeBridge(supervisorConfig, { memoryOnly: true });
    const graphExecutor = new GraphExecutor();
    const events: { type: string }[] = [];
    const state = makeState('新增一个 logger 工具');

    await prepareHarnessRound(
      {
        loopController: new LoopController({ maxRounds: 3 }),
        memoryIntegration: new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' }),
        graphExecutor,
        contextCompactor: new ContextCompactor({ threshold: 9999 }),
        supervisorBridge: bridge,
        stopHookManager: { run: async () => ({ action: 'continue' }) } as never,
        checkpointManager: undefined,
        enqueueCheckpointPersist: async task => task(),
        resilienceV2Enabled: false,
        checkpointEngine: undefined,
        toolExecutor: new ToolExecutor(new ToolRegistry(), {
          maxRetries: 0,
          retryBaseDelay: 0,
          retryMaxDelay: 0,
          toolTimeout: 5000,
        }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
        executionModeConfig: supervisorConfig.executionMode,
        executionModeDecisionEnabled: true,
        abortSignal: undefined,
      },
      {
        state,
        userMessage: '新增一个 logger 工具',
        chatFn,
        logger: new HarnessLogger(),
        onStep: event => events.push(event),
      },
    );

    expect(graphExecutor.hasGraph()).toBe(false);
    expect(events.filter(e => e.type === 'task_graph_init')).toHaveLength(0);
  });
});
