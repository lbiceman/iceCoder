import { describe, expect, it, vi } from 'vitest';

import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { resilienceRecordToolCalls } from '../../src/harness/harness-resilience.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import type { ToolCall } from '../../src/llm/types.js';

function minimalState(): HarnessRunState {
  return {
    messages: [],
    tools: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    consecutiveToolFailures: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: undefined as never,
    repoContext: undefined as never,
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
  } as unknown as HarnessRunState;
}

function engineStub() {
  return {
    save: vi.fn(async () => undefined),
    stage: vi.fn(() => undefined),
    shouldPersistOnTrigger: () => false,
  };
}

describe('harness resilience checkpoint recording', () => {
  it('stages successful tool calls without writing to disk', async () => {
    const engine = engineStub();
    const tc: ToolCall = { id: 'tc-write', name: 'write_file', arguments: { path: 'src/a.ts', content: 'x' } };

    await resilienceRecordToolCalls(
      { checkpointEngine: engine as never, enqueueCheckpointPersist: async task => task() },
      [tc, tc, tc, tc],
      new Set(),
      minimalState(),
    );

    expect(engine.stage).toHaveBeenCalledTimes(4);
    expect(engine.save).not.toHaveBeenCalled();
    expect(engine.stage.mock.calls[0]![0]).not.toHaveProperty('branchBudget');
  });

  it('persists a tool_failed snapshot for each failed call', async () => {
    const engine = engineStub();
    const tc: ToolCall = { id: 'tc-build', name: 'run_command', arguments: { command: 'npm run build 2>&1' } };

    await resilienceRecordToolCalls(
      { checkpointEngine: engine as never, enqueueCheckpointPersist: async task => task() },
      [tc],
      new Set([toolCallSignature(tc)]),
      minimalState(),
    );

    expect(engine.save).toHaveBeenCalledOnce();
    expect(engine.save.mock.calls[0]![0]).toMatchObject({
      trigger: 'tool_failed',
      appendFailure: { signature: toolCallSignature(tc), count: 1 },
    });
  });
});
