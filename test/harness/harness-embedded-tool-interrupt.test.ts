import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { handleNoToolCalls } from '../../src/harness/harness-round-no-tools.js';
import { resolveSalvagedLlmResponse } from '../../src/harness/text-tool-call-salvage.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import type { LLMResponse } from '../../src/llm/types.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { TaskState } from '../../src/harness/task-state.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { StopHookManager } from '../../src/harness/stop-hooks.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';

const CHANNEL_SAMPLE = `[调用工具: run_command]]<]minimax[>[<task_id>bg_46rq7i]<]minimax[>[</task_id>]<]minimax[>[<action>check]<]minimax[>[</action>]<]minimax[>[<since>0]<]minimax[>[</since>]<]minimax[>[</invoke>]<]minimax[>[</tool_call>`;

function makeState(): HarnessRunState {
  return {
    messages: [
      { role: 'user', content: '继续完成 selfStudy 项目并跑 npm install/build 验收'.padEnd(90, '.') },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-0', name: 'run_command', arguments: { task_id: 'bg_old', action: 'check' } }],
      },
      { role: 'tool', toolCallId: 'tc-0', content: '工具执行错误: Task bg_old not found' },
    ],
    tools: [{ name: 'run_command', description: 'x', parameters: { type: 'object', properties: {} } }],
    taskState: new TaskState('继续完成 selfStudy 项目并跑 npm install/build 验收'),
    repoContext: new RepoContext(),
    turnCount: 1,
    consecutiveNoToolRounds: 0,
    noToolExecutionRecoveryCount: 0,
    stopHookContinuationCount: 0,
    verificationGateContinuationCount: 0,
    prematureCompletionRecoveryCount: 0,
    emptyResponseRetryCount: 0,
    reasoningOnlyRecoveryCount: 0,
    maxOutputTokensRecoveryCount: 0,
    consecutiveToolFailures: 0,
    stableRoundsSinceLastFailure: 0,
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskSwitchInjected: false,
    transition: 'idle',
  } as HarnessRunState;
}

describe('resolveSalvagedLlmResponse', () => {
  it('parses embedded bracket tool text into toolCalls', () => {
    const raw: LLMResponse = {
      content: CHANNEL_SAMPLE,
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
    };
    const out = resolveSalvagedLlmResponse(raw);
    expect(out.toolCalls?.length).toBeGreaterThanOrEqual(1);
    expect(out.toolCalls?.[0]?.name).toBe('run_command');
    expect(out.content).toBe('');
  });
});

describe('handleNoToolCalls · embedded text after API tools', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('continues instead of model_done when raw has embedded tools but parse failed', async () => {
    const state = makeState();
    const deps = {
      loopController: new LoopController({ maxRounds: 10 }),
      memoryIntegration: { getSessionMemoryForCompact: async () => null, injectMemoryContext: async () => {} },
      stopHookManager: new StopHookManager(),
      graphExecutor: new GraphExecutor(),
      sessionDir: undefined,
      checkpointManager: undefined,
      checkpointEngine: undefined,
      resilienceV2Enabled: false,
      runtimeTelemetry: undefined,
      supervisorObserverSuppressInject: true,
    };

    const result = await handleNoToolCalls(deps as any, {
      state,
      response: {
        content: '',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
      },
      rawAssistantContent: 'not parseable [<action>only',
      userMessage: '继续',
      currentTools: state.tools as any,
      tokenUsage: { input: 1, output: 1 },
      logger: { loopStop: vi.fn(), getEntries: () => [] } as any,
    });

    expect(result.action).toBe('continue');
    expect(state.noToolExecutionRecoveryCount).toBe(1);
  });
});
