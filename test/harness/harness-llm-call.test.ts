import { describe, expect, it, vi } from 'vitest';

import { buildCheckpointResumeSummary } from '../../src/harness/checkpoint-resume-compact.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { callHarnessLlm } from '../../src/harness/harness-llm-call.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function longMessages(count: number): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < count; i++) {
    msgs.push(
      { role: 'user', content: `task chunk ${i}: ${'a'.repeat(200)}` },
      { role: 'assistant', content: `reply ${i}: ${'b'.repeat(200)}` },
    );
  }
  return msgs;
}

function buildState(messages: UnifiedMessage[], overrides: Partial<HarnessRunState> = {}): HarnessRunState {
  return {
    messages,
    tools: [],
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
    taskState: new TaskState('implement survivors with npm test'),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    rebuildEscalationInjections: 0,
    rebuildEscalationInjectedThisRound: false,
    parallelBudgetBlockHintInjected: false,
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

describe('callHarnessLlm · context window emergency fork', () => {
  it('applies aggressive fork and returns retry on first context window error', async () => {
    const messages = longMessages(80);
    const state = buildState(messages, {
      activeCheckpointResumeSummary: {
        role: 'user',
        content: buildCheckpointResumeSummary({
          version: 1,
          taskId: 't1',
          status: 'paused',
          userGoal: 'fix build',
          phase: 'verification',
          taskState: {
            goal: 'fix build errors in survivors game',
            intent: 'debug',
            phase: 'verification',
            filesRead: [],
            filesChanged: ['src/a.ts'],
            commandsRun: ['npm run build'],
            verificationRequired: true,
            verificationStatus: 'failed',
          },
          repoContext: {
            filesRead: [],
            filesChanged: ['src/a.ts'],
            commandsRun: ['npm run build'],
            testCommands: ['npm run build'],
            recentDiagnostics: ['build failed'],
          },
          failedToolCalls: [],
          messageCount: 80,
          loop: {
            currentRound: 10,
            totalToolCalls: 5,
            totalInputTokens: 100,
            totalOutputTokens: 20,
          },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
        preserveOnCompaction: true,
      },
    });
    const loopController = new LoopController({ maxRounds: 5 });
    loopController.advanceRound();
    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 20,
      keepRecentMinTokens: 100,
      keepRecentMaxTokens: 50_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
      maxToolResultLength: 500,
    });
    const recordCompaction = vi.fn();
    const beforeCount = state.messages.length;

    const chatFn = vi.fn().mockRejectedValue(
      new Error('OpenAI API Error [400]: context window exceeds limit (2013)'),
    );

    const result = await callHarnessLlm(
      {
        loopController,
        contextCompactor: compactor,
        runtimeTelemetry: { recordCompaction } as never,
      },
      {
        state,
        normalizedMsgs: [...state.messages],
        currentTools: [],
        round: 1,
        chatFn,
        logger: new HarnessLogger(),
      },
    );

    expect(result.action).toBe('retry');
    expect(state.contextEmergencyCompactUsed).toBe(true);
    expect(state.checkpointResumeForkApplied).toBe(true);
    expect(state.transition).toBe('compaction_retry');
    expect(state.turnCount).toBe(0);
    expect(state.messages.length).toBeLessThan(beforeCount);
    expect(recordCompaction).toHaveBeenCalledOnce();
    expect(
      state.messages.some(m =>
        typeof m.content === 'string'
        && m.content.includes('<resume-checkpoint>')
        && m.content.includes('Emergency: provider rejected prompt size'),
      ),
    ).toBe(true);
  });

  it('does not emergency fork twice; second context error stops with error', async () => {
    const state = buildState(longMessages(40), { contextEmergencyCompactUsed: true });
    const loopController = new LoopController({ maxRounds: 3 });
    const chatFn = vi.fn().mockRejectedValue(
      new Error('context_length_exceeded: max 128000'),
    );

    const result = await callHarnessLlm(
      {
        loopController,
        contextCompactor: new ContextCompactor({ threshold: 9999 }),
      },
      {
        state,
        normalizedMsgs: state.messages,
        currentTools: [],
        round: 1,
        chatFn,
        logger: new HarnessLogger(),
      },
    );

    expect(result.action).toBe('error');
    if (result.action === 'error') {
      expect(result.result.loopState.stopReason).toBe('error');
    }
  });

  it('skips emergency fork when contextCompactor is unavailable', async () => {
    const state = buildState(longMessages(10));
    const loopController = new LoopController({ maxRounds: 3 });
    const chatFn = vi.fn().mockRejectedValue(
      new Error('Prompt is too long: tokens exceed the limit'),
    );

    const result = await callHarnessLlm(
      { loopController },
      {
        state,
        normalizedMsgs: state.messages,
        currentTools: [],
        round: 1,
        chatFn,
        logger: new HarnessLogger(),
      },
    );

    expect(result.action).toBe('error');
    expect(state.contextEmergencyCompactUsed).toBe(false);
  });
});
