import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { maybeCompact } from '../../src/harness/harness-compaction.js';
import { callHarnessLlm } from '../../src/harness/harness-llm-call.js';
import { HarnessMemoryIntegration } from '../../src/harness/harness-memory.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { HarnessLogger } from '../../src/harness/logger.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

/** 58de6014 现场：窗口 500K，主动收缩线 465K，最后一次 API prompt 491,369。 */
const CONTEXT_WINDOW = 500_000;
const STALE_API_PROMPT = 491_369;

function smallHistory(): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 6; i++) {
    msgs.push(
      { role: 'user', content: `step ${i}: ${'x'.repeat(200)}` },
      { role: 'assistant', content: `ok ${i}` },
    );
  }
  return msgs;
}

function buildState(messages: UnifiedMessage[], overrides: Partial<HarnessRunState> = {}): HarnessRunState {
  return {
    messages,
    tools: [],
    turnCount: 5,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    reasoningOnlyRecoveryCount: 0,
    completionGateContinuationCount: 0,
    consecutiveToolFailures: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: new TaskState('add cooldowns to spin skills'),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    segmentRenewalCount: 0,
    checkpointResumeForkApplied: false,
    contextEmergencyCompactUsed: false,
    ...overrides,
  } as HarnessRunState;
}

function compactor(): ContextCompactor {
  return new ContextCompactor({
    threshold: 9999,
    keepRecent: 4,
    keepRecentMinTokens: 50,
    keepRecentMaxTokens: 10_000,
    keepRecentMinMessages: 2,
    enableLLMSummary: false,
    maxReinjectFiles: 0,
    maxReinjectTokens: 0,
    maxToolResultLength: 200,
  });
}

function compactionDeps(loopController: LoopController, contextCompactor: ContextCompactor) {
  const memoryIntegration = new HarnessMemoryIntegration({ memoryDir: '__test_nonexistent__' });
  vi.spyOn(memoryIntegration, 'getSessionMemoryForCompact').mockResolvedValue('# session notes\n- cooldown work');
  return {
    loopController,
    memoryIntegration,
    contextCompactor,
    enqueueCheckpointPersist: async <T>(task: () => Promise<T>) => task(),
  };
}

const okResponse = {
  content: 'continuing',
  usage: { inputTokens: 30_000, outputTokens: 100, totalTokens: 30_100, provider: 'test' },
  finishReason: 'stop',
};

describe('压缩后旧 API prompt 不得驱动无限空转', () => {
  const origWindow = process.env.ICE_CONTEXT_WINDOW;

  beforeEach(() => {
    process.env.ICE_CONTEXT_WINDOW = String(CONTEXT_WINDOW);
  });

  afterEach(() => {
    if (origWindow === undefined) delete process.env.ICE_CONTEXT_WINDOW;
    else process.env.ICE_CONTEXT_WINDOW = origWindow;
    vi.restoreAllMocks();
  });

  it('本地压缩后两轮内一定真正调用模型', async () => {
    const loopController = new LoopController({ maxRounds: 100 });
    loopController.recordTokenUsage(STALE_API_PROMPT, 2_146);
    const contextCompactor = compactor();
    const deps = compactionDeps(loopController, contextCompactor);
    const state = buildState(smallHistory());
    const chatFn = vi.fn().mockResolvedValue(okResponse);
    const logger = new HarnessLogger();

    let sent = false;
    for (let cycle = 0; cycle < 2 && !sent; cycle++) {
      loopController.advanceRound();
      await maybeCompact(deps as never, {
        messages: state.messages,
        chatFn,
        logger,
        state,
        lastApiPromptTokens: loopController.getLiveApiPromptTokens(),
        tools: [],
      });
      const result = await callHarnessLlm(
        { loopController, contextCompactor },
        {
          state,
          normalizedMsgs: [...state.messages],
          currentTools: [],
          round: loopController.getState().currentRound,
          chatFn,
          logger,
        },
      );
      sent = result.action === 'response';
    }

    expect(sent).toBe(true);
    expect(chatFn).toHaveBeenCalledOnce();
  });

  it('本地改写历史后 live prompt 归零，真实响应后恢复', () => {
    const loopController = new LoopController({ maxRounds: 10 });
    loopController.recordTokenUsage(STALE_API_PROMPT, 10);
    expect(loopController.getLiveApiPromptTokens()).toBe(STALE_API_PROMPT);

    loopController.markPromptTokensStale();
    expect(loopController.getLiveApiPromptTokens()).toBe(0);
    expect(loopController.getState().lastInputTokens).toBe(STALE_API_PROMPT);

    loopController.recordTokenUsage(40_000, 10);
    expect(loopController.getLiveApiPromptTokens()).toBe(40_000);
  });

  it('硬压缩后的配额返还要等到真正调用过模型', async () => {
    const loopController = new LoopController({ maxRounds: 10 });
    loopController.recordTokenUsage(STALE_API_PROMPT, 10);
    const contextCompactor = compactor();
    const deps = compactionDeps(loopController, contextCompactor);
    const state = buildState(smallHistory(), { contextEmergencyCompactCount: 1 });
    const chatFn = vi.fn().mockResolvedValue(okResponse);

    await maybeCompact(deps as never, {
      messages: state.messages,
      chatFn,
      logger: new HarnessLogger(),
      state,
      lastApiPromptTokens: loopController.getLiveApiPromptTokens(),
      tools: [],
    });
    expect(state.contextEmergencyCompactCount).toBe(1);
    expect(loopController.getLiveApiPromptTokens()).toBe(0);

    loopController.advanceRound();
    const result = await callHarnessLlm(
      { loopController, contextCompactor },
      {
        state,
        normalizedMsgs: [...state.messages],
        currentTools: [],
        round: 1,
        chatFn,
        logger: new HarnessLogger(),
      },
    );
    expect(result.action).toBe('response');
    expect(state.contextEmergencyCompactCount).toBe(0);
  });

  it('压缩没省下来时，连续 2 次压缩重试后直接发送', async () => {
    const loopController = new LoopController({ maxRounds: 10 });
    const stubCompactor = {
      compactForCheckpointResume: (msgs: UnifiedMessage[]) => msgs.slice(),
      getEstimatedTokens: () => 480_000,
    } as unknown as ContextCompactor;
    const huge: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '字'.repeat(480_000) },
    ];
    const state = buildState(huge);
    const chatFn = vi.fn().mockResolvedValue(okResponse);
    const actions: string[] = [];

    for (let i = 0; i < 3; i++) {
      loopController.advanceRound();
      const result = await callHarnessLlm(
        { loopController, contextCompactor: stubCompactor },
        {
          state,
          normalizedMsgs: [...state.messages],
          currentTools: [],
          round: loopController.getState().currentRound,
          chatFn,
          logger: new HarnessLogger(),
        },
      );
      actions.push(result.action);
      if (result.action === 'response') break;
    }

    expect(actions).toEqual(['retry', 'retry', 'response']);
    expect(chatFn).toHaveBeenCalledOnce();
  });
});

describe('LoopController · 无模型进展看门狗', () => {
  it('连续空转达到上限判定停滞，真实响应会清零', () => {
    const lc = new LoopController({ maxRounds: 100 });
    for (let i = 0; i < 19; i++) lc.noteLoopIteration();
    expect(lc.isStalled()).toBe(false);
    lc.noteLoopIteration();
    expect(lc.isStalled()).toBe(true);

    lc.recordTokenUsage(1, 1);
    expect(lc.isStalled()).toBe(false);
  });

  it('新一次 run 清零空转计数', () => {
    const lc = new LoopController({ maxRounds: 100 });
    for (let i = 0; i < 20; i++) lc.noteLoopIteration();
    lc.resetForNewRun();
    expect(lc.isStalled()).toBe(false);
  });
});
