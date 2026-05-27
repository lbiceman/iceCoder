import { describe, expect, it, vi } from 'vitest';

import { handleNoToolCalls } from '../../src/harness/harness-round-no-tools.js';
import { evaluateIncompleteTaskStopHook } from '../../src/harness/incomplete-task-stop-hook.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { StopHookManager } from '../../src/harness/stop-hooks.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function makeState(
  messages: UnifiedMessage[],
  goal = '运行测试',
): HarnessRunState {
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
    taskState: new TaskState(goal),
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

function withDefaultHook(manager: StopHookManager): StopHookManager {
  manager.register(async (messages, lastContent) =>
    evaluateIncompleteTaskStopHook(messages, lastContent),
  );
  return manager;
}

function makeDeps(stopHookManager: StopHookManager) {
  return {
    loopController: new LoopController({ maxRounds: 10 }),
    stopHookManager,
    memoryIntegration: { getSessionMemoryForCompact: async () => null } as any,
    graphExecutor: { hasGraph: () => false, advanceOrComplete: () => ({ graphDone: false }) } as any,
    enqueueCheckpointPersist: async (t: () => Promise<void>) => t(),
  };
}

function makeLogger() {
  return {
    loopStop: vi.fn(),
    getEntries: vi.fn(() => []),
  } as any;
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

// ═══════════════════════════════════════════════════════════════
// stop hook 状态门控：question / docs / 已完成工程任务直接 model_done
// ═══════════════════════════════════════════════════════════════
describe('handleNoToolCalls — stop hook 状态门控', () => {
  it('question 意图即使回复含「I will fix」也跳过 hook 直接 model_done', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '为什么测试失败' },
    ];
    const state = makeState(messages, '为什么测试失败');
    expect(state.taskState.snapshot().intent).toBe('question');

    const result = await handleNoToolCalls(
      makeDeps(withDefaultHook(new StopHookManager())),
      {
        state,
        response: { content: '原因 A 和 B。I will fix it later.', finishReason: 'stop' },
        userMessage: '为什么测试失败',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.stopHookContinuationCount).toBe(0);
    expect(state.noToolExecutionRecoveryCount).toBe(0);
  });

  it('docs 意图即使回复含未完成关键词也跳过 hook 直接 model_done', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '帮我写 readme 文档' },
    ];
    const state = makeState(messages, '帮我写 readme 文档');
    expect(state.taskState.snapshot().intent).toBe('docs');

    const result = await handleNoToolCalls(
      makeDeps(withDefaultHook(new StopHookManager())),
      {
        state,
        response: {
          content: '# README\n\n项目简介… still need to add 部署章节。',
          finishReason: 'stop',
        },
        userMessage: '帮我写 readme 文档',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.stopHookContinuationCount).toBe(0);
  });

  it('工程任务已动过工具且 verification 通过 → 跳过 hook 直接 model_done', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '修复登录 bug' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'run_command', arguments: { command: 'npm test' } }] },
      { role: 'tool', content: 'pass', toolCallId: 't1' },
    ];
    const state = makeState(messages, '修复登录 bug');
    state.taskState.markVerificationPassed();

    const summary = '修复完成。npm test 全过，manifest 与 colorVariance 审计通过。';
    const result = await handleNoToolCalls(
      makeDeps(withDefaultHook(new StopHookManager())),
      {
        state,
        response: { content: summary, finishReason: 'stop' },
        userMessage: '修复登录 bug',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('return');
    if (result.action === 'return') {
      expect(result.result.loopState.stopReason).toBe('model_done');
    }
    expect(state.stopHookContinuationCount).toBe(0);
  });

  it('工程任务无工具 + 模型自承未完成 → hook 拦截要求继续', async () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '实现登录功能' },
    ];
    const state = makeState(messages, '实现登录功能');
    expect(state.taskState.snapshot().intent).toBe('edit');

    const result = await handleNoToolCalls(
      makeDeps(withDefaultHook(new StopHookManager())),
      {
        state,
        response: { content: '接下来我会实现登录逻辑。', finishReason: 'stop' },
        userMessage: '实现登录功能',
        currentTools: state.tools,
        tokenUsage: { input: 1, output: 1 },
        logger: makeLogger(),
      },
    );

    expect(result.action).toBe('continue');
    expect(state.stopHookContinuationCount).toBe(1);
  });
});
