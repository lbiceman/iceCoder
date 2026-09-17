import { describe, expect, it, vi } from 'vitest';

import { handleHarnessStop } from '../../src/harness/harness-stop-handler.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { HarnessStepEvent } from '../../src/harness/types.js';
import { TaskState } from '../../src/harness/task-state.js';
import { RepoContext } from '../../src/harness/repo-context.js';

function makeDeps() {
  const loopController = new LoopController({ maxRounds: 10 });
  return {
    loopController,
    enqueueCheckpointPersist: async <T>(task: () => Promise<T>) => task(),
    resilienceV2Enabled: false,
  };
}

function makeLogger() {
  return {
    loopStop: vi.fn(),
    llmCall: vi.fn(),
    llmResponseFinal: vi.fn(),
    error: vi.fn(),
    getEntries: vi.fn(() => []),
  };
}

describe('handleHarnessStop user_checkpoint', () => {
  it('返回固定暂停说明，不再请求 LLM 最终总结', async () => {
    const deps = makeDeps();
    const chatFn = vi.fn();
    const events: HarnessStepEvent[] = [];
    const logger = makeLogger();

    const result = await handleHarnessStop(deps, {
      reason: 'user_checkpoint',
      messages: [{ role: 'user', content: 'fix tests' }],
      chatFn,
      tools: [],
      logger: logger as any,
      onStep: (event) => events.push(event),
    });

    expect(chatFn).not.toHaveBeenCalled();
    expect(logger.llmCall).not.toHaveBeenCalled();
    expect(result.content).toContain('Supervisor 已暂停自动恢复');
    expect(result.loopState.stopReason).toBe('user_checkpoint');
    expect(result.completionStatus).toBe('paused');
    expect(result.completionReason).toBe('user_checkpoint');

    const finalEvent = events.find((e) => e.type === 'final');
    expect(finalEvent?.stopReason).toBe('user_checkpoint');
    expect(finalEvent?.content).toContain('paused');
    expect(finalEvent?.completionStatus).toBe('paused');
    expect(finalEvent?.completionReason).toBe('user_checkpoint');
  });

  it('does not reuse a restored completed status for a new resource stop', async () => {
    const deps = makeDeps();
    const result = await handleHarnessStop(deps, {
      reason: 'token_budget',
      messages: [{ role: 'user', content: '继续' }],
      chatFn: vi.fn(),
      tools: [],
      logger: makeLogger() as any,
      runtimeState: {
        completionStatus: 'completed',
        completionReason: 'verification_passed',
        taskState: new TaskState('实现功能'),
        repoContext: new RepoContext(),
        failedToolCallSignatures: new Map(),
      } as any,
    });

    expect(result.completionStatus).toBe('interrupted');
    expect(result.completionReason).toBe('token_budget');
  });
});
