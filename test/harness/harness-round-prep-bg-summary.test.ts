/**
 * P0-B — `prepareHarnessRound` 接入后台摘要注入，避免模型对长任务失忆。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import { prepareHarnessRound } from '../../src/harness/harness-round-prep.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { ChatFunction } from '../../src/harness/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import {
  __resetBackgroundTaskManagers,
  getBackgroundTaskManagerFor,
} from '../../src/tools/background-task-manager.js';

const isWindows = process.platform === 'win32';
const SLEEP_CMD = isWindows ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';

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
    verificationDigestInjectedThisRound: false,
    stepReviewedThisRound: false,
    supervisorPhase: 'free',
  };
}

const chatFn: ChatFunction = async () => ({
  content: 'noop',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
  finishReason: 'stop',
});

function buildDeps(sessionId: string, workspaceRoot: string) {
  return {
    loopController: new LoopController({ maxRounds: 3 }),
    memoryIntegration: new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' }),
    graphExecutor: new GraphExecutor(),
    contextCompactor: new ContextCompactor({ threshold: 9999 }),
    stopHookManager: { run: async () => ({ action: 'continue' }) } as never,
    checkpointManager: undefined,
    enqueueCheckpointPersist: async (task: () => Promise<unknown>) => task(),
    resilienceV2Enabled: false,
    checkpointEngine: undefined,
    toolExecutor: new ToolExecutor(new ToolRegistry(), {
      maxRetries: 0,
      retryBaseDelay: 0,
      retryMaxDelay: 0,
      toolTimeout: 5000,
    }),
    permissionRules: [],
    workspaceRoot,
    sessionId,
    abortSignal: undefined,
  };
}

describe('harness-round-prep · bg-summary injection (P0-B)', () => {
  let workDir: string;
  const sessionId = 'p0b-bg-test';

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-p0b-'));
    __resetBackgroundTaskManagers();
  });

  afterEach(() => {
    __resetBackgroundTaskManagers();
  });

  it('injects [Background Task Status] when a running task is due', async () => {
    const mgr = getBackgroundTaskManagerFor(sessionId, workDir);
    const spawn = mgr.spawn(SLEEP_CMD, 30_000, 'pending-build');
    expect(spawn.taskId).toBeTruthy();

    const state = makeState('long task');
    await prepareHarnessRound(buildDeps(sessionId, workDir), {
      state,
      userMessage: 'long task',
      chatFn,
      logger: new HarnessLogger(),
    });

    const injected = state.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('[Background Task Status]'),
    );
    expect(injected, 'bg-summary user message should be appended').toBeTruthy();
    expect(injected!.content).toMatch(/pending-build/);
  });

  it('does NOT inject when there is no running task', async () => {
    const state = makeState('quick task');
    await prepareHarnessRound(buildDeps(sessionId, workDir), {
      state,
      userMessage: 'quick task',
      chatFn,
      logger: new HarnessLogger(),
    });

    const injected = state.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('[Background Task Status]'),
    );
    expect(injected).toBeUndefined();
  });

  it('throttles: second consecutive prepare round does NOT re-inject', async () => {
    const mgr = getBackgroundTaskManagerFor(sessionId, workDir);
    mgr.spawn(SLEEP_CMD, 30_000, 'throttle-job');

    const state = makeState('long task');
    const deps = buildDeps(sessionId, workDir);

    await prepareHarnessRound(deps, {
      state,
      userMessage: 'long task',
      chatFn,
      logger: new HarnessLogger(),
    });
    const firstCount = state.messages.filter(
      (m) => typeof m.content === 'string' && m.content.includes('[Background Task Status]'),
    ).length;
    expect(firstCount).toBe(1);

    await prepareHarnessRound(deps, {
      state,
      userMessage: 'long task',
      chatFn,
      logger: new HarnessLogger(),
    });
    const secondCount = state.messages.filter(
      (m) => typeof m.content === 'string' && m.content.includes('[Background Task Status]'),
    ).length;
    expect(secondCount).toBe(1);
  });
});
