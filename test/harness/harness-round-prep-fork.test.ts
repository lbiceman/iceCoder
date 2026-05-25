import { describe, expect, it, vi } from 'vitest';

import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { maybeCompact } from '../../src/harness/harness-compaction.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import { prepareHarnessRound } from '../../src/harness/harness-round-prep.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import type { ChatFunction } from '../../src/harness/types.js';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

function filler(count: number): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push(
      { role: 'user', content: `user ${i}: ${'x'.repeat(300)}` },
      { role: 'assistant', content: `assistant ${i}: ${'y'.repeat(300)}` },
    );
  }
  return msgs;
}

function baseState(messages: UnifiedMessage[], overrides: Partial<HarnessRunState> = {}): HarnessRunState {
  return {
    messages,
    tools: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    reasoningOnlyRecoveryCount: 0,
    prematureCompletionRecoveryCount: 0,
    consecutiveToolFailures: 0,
    consecutiveReadOnlyRounds: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: new TaskState('implement survivors benchmark with npm test and build'),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    rebuildEscalationInjected: false,
    segmentRenewalCount: 0,
    checkpointResumeForkApplied: false,
    contextEmergencyCompactUsed: false,
    stepReviewedThisRound: false,
    supervisorPhase: 'free',
    filesChangedAtRoundStart: 0,
    branchSwitchedThisRound: false,
    ...overrides,
  };
}

const chatFn: ChatFunction = async () => ({
  content: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
  finishReason: 'stop',
});

const baseDeps = {
  loopController: new LoopController({ maxRounds: 5 }),
  memoryIntegration: new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' }),
  graphExecutor: undefined,
  contextCompactor: new ContextCompactor({
    threshold: 5,
    tokenThreshold: 500,
    keepRecent: 4,
    keepRecentMinTokens: 50,
    keepRecentMaxTokens: 10_000,
    keepRecentMinMessages: 2,
    enableLLMSummary: false,
    maxReinjectFiles: 0,
    maxReinjectTokens: 0,
    maxToolResultLength: 200,
  }),
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
  workspaceRoot: process.cwd(),
  executionModeDecisionEnabled: false,
  abortSignal: undefined,
};

describe('maybeCompact · post-fork skip', () => {
  it('skips micro compaction when checkpointResumeForkApplied and turnCount is 0', async () => {
    const messages = filler(20);
    const before = messages.length;
    const state = baseState(messages, { checkpointResumeForkApplied: true, turnCount: 0 });
    const compactionEvents: string[] = [];

    await maybeCompact(baseDeps, {
      messages,
      chatFn,
      logger: new HarnessLogger(),
      onStep: event => {
        if (event.type === 'compaction') compactionEvents.push(event.content ?? '');
      },
      state,
    });

    expect(messages.length).toBe(before);
    expect(compactionEvents).toHaveLength(0);
  });
});

describe('prepareHarnessRound · post-fork skip', () => {
  it('skips injectMemoryContext on first round after checkpoint fork', async () => {
    const messages = filler(5);
    const state = baseState(messages, { checkpointResumeForkApplied: true, turnCount: 0 });
    const injectSpy = vi.spyOn(baseDeps.memoryIntegration, 'injectMemoryContext').mockResolvedValue();

    await prepareHarnessRound(baseDeps, {
      state,
      userMessage: '继续',
      chatFn,
      logger: new HarnessLogger(),
    });

    expect(state.turnCount).toBe(1);
    expect(injectSpy).not.toHaveBeenCalled();
    injectSpy.mockRestore();
  });

  it('runs injectMemoryContext on second round after fork', async () => {
    const messages = filler(5);
    const state = baseState(messages, { checkpointResumeForkApplied: true, turnCount: 1 });
    const injectSpy = vi.spyOn(baseDeps.memoryIntegration, 'injectMemoryContext').mockResolvedValue();

    await prepareHarnessRound(baseDeps, {
      state,
      userMessage: '继续',
      chatFn,
      logger: new HarnessLogger(),
    });

    expect(state.turnCount).toBe(2);
    expect(injectSpy).toHaveBeenCalledOnce();
    injectSpy.mockRestore();
  });
});
