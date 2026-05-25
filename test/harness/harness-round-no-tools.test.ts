import { describe, expect, it, vi } from 'vitest';

import { handleNoToolCalls } from '../../src/harness/harness-round-no-tools.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { StopHookManager } from '../../src/harness/stop-hooks.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function makeState(messages: UnifiedMessage[]): HarnessRunState {
  const loopController = new LoopController({ maxRounds: 10 });
  return {
    messages,
    tools: [{ name: 'run_command', description: 'run', parameters: { type: 'object', properties: {} } }],
    turnCount: 1,
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
    taskState: new TaskState('运行测试'),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    stepReviewedThisRound: false,
    executionMode: 'free',
    executionModeLockRemaining: 0,
    executionModeEnteredBy: [],
    pendingModeSignals: [],
    forcedTaskBearingRoundsSinceEntry: 0,
    supervisorPhase: 'free',
    recoveryPendingSticky: false,
    stableRoundsSinceLastFailure: 0,
    filesChangedAtRoundStart: 0,
    branchSwitchedThisRound: false,
  };
}

describe('handleNoToolCalls resume fixes', () => {
  it('recovers when latest user asks to run tests without tools', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前完成' },
      { role: 'user', content: '运行测试' },
    ];
    const state = makeState(messages);
    const loopController = new LoopController({ maxRounds: 10 });

    const result = await handleNoToolCalls(
      {
        loopController,
        stopHookManager: new StopHookManager(),
        memoryIntegration: { getSessionMemoryForCompact: async () => null } as any,
        graphExecutor: { hasGraph: () => false, advanceOrComplete: () => ({ graphDone: false }) } as any,
        enqueueCheckpointPersist: async (t) => t(),
      },
      {
        state,
        response: { content: '我会运行测试。', finishReason: 'stop' },
        userMessage: '运行测试',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: { loopStop: vi.fn() } as any,
      },
    );

    expect(result.action).toBe('continue');
    expect(state.noToolExecutionRecoveryCount).toBe(1);
  });
});
