import { describe, expect, it, vi } from 'vitest';

import {
  executeStopVerificationPlan,
  type VerificationToolCallResult,
} from '../../src/harness/harness-stop-verification.js';
import {
  buildVerificationPlan,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type VerificationPlan,
  type VerificationPlanCommand,
} from '../../src/harness/verification-plan.js';
import {
  createVerificationRuntimeState,
  isVerificationFresh,
} from '../../src/harness/verification-state.js';
import { TaskState } from '../../src/harness/task-state.js';
import type { ToolCall } from '../../src/llm/types.js';

function makePlan(
  commands: Array<string | VerificationPlanCommand>,
): VerificationPlan {
  return buildVerificationPlan({
    source: 'user',
    commands,
    workspaceRoot: process.cwd(),
  })!;
}

function foreground(
  command: string,
  success = true,
  output = success ? 'ok' : 'Tool execution error: Command failed (exit code: 1)',
): VerificationToolCallResult {
  return {
    classification: {
      kind: 'foreground',
      command,
      foregroundSuccess: success,
    },
    output,
    evidenceRef: `evidence:${command}`,
  };
}

describe('executeStopVerificationPlan', () => {
  it('executes multiple commands strictly in order and marks the plan passed only after all finish', async () => {
    const plan = makePlan([
      { command: 'npm test', required: true, timeoutMs: 111 },
      { command: 'npm run lint', required: true, timeoutMs: 222 },
    ]);
    const taskState = new TaskState('edit');
    taskState.recordCommandWorkspaceMutation(['src/a.ts']);
    const verificationState = createVerificationRuntimeState();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const executeToolCall = vi.fn(async (toolCall: ToolCall) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(String(toolCall.arguments.command));
      await Promise.resolve();
      active -= 1;
      return foreground(String(toolCall.arguments.command));
    });

    const result = await executeStopVerificationPlan({
      plan,
      taskState,
      verificationState,
      executeToolCall,
    });

    expect(result).toEqual({
      status: 'passed',
      evidenceRef: 'evidence:npm run lint',
    });
    expect(order).toEqual(['npm test', 'npm run lint']);
    expect(maxActive).toBe(1);
    expect(executeToolCall.mock.calls.map(([toolCall]) => toolCall.arguments.timeout))
      .toEqual([111, 222]);
    expect(isVerificationFresh(verificationState, plan.fingerprint)).toBe(true);
  });

  it('stops at the second foreground failure and returns bounded failure evidence', async () => {
    const plan = makePlan(['npm test', 'npm run lint', 'npm run e2e']);
    const taskState = new TaskState('edit');
    const verificationState = createVerificationRuntimeState();
    const executeToolCall = vi.fn(async (toolCall: ToolCall) => {
      const command = String(toolCall.arguments.command);
      if (command === 'npm run lint') {
        return foreground(
          command,
          false,
          `Tool execution error: Command failed (exit code: 2)\n\n${'x'.repeat(3_000)}TAIL`,
        );
      }
      return foreground(command);
    });

    const result = await executeStopVerificationPlan({
      plan,
      taskState,
      verificationState,
      executeToolCall,
      outputTailChars: 200,
    });

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'failed',
      failedCommand: 'npm run lint',
      exitCode: 2,
      evidenceRef: 'evidence:npm run lint',
    });
    expect(result.outputTail).toHaveLength(200);
    expect(result.outputTail).toMatch(/TAIL$/);
    expect(verificationState.lastResult?.status).toBe('failed');
    expect(isVerificationFresh(verificationState, plan.fingerprint)).toBe(false);
  });

  it('polls a background command through run_command check until completed', async () => {
    const plan = makePlan([
      { command: 'npm test', required: true, timeoutMs: 500 },
    ]);
    const taskState = new TaskState('edit');
    const verificationState = createVerificationRuntimeState();
    const wait = vi.fn(async () => {});
    let checkCount = 0;
    const executeToolCall = vi.fn(async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
      if (!toolCall.arguments.action) {
        return {
          classification: { kind: 'background_start', command: 'npm test' },
          output: JSON.stringify({ mode: 'background', taskId: 'bg-1', status: 'started' }),
          evidenceRef: toolCall.id,
        };
      }
      checkCount += 1;
      if (checkCount === 1) {
        return {
          classification: { kind: 'background_running', command: 'npm test' },
          output: JSON.stringify({ status: 'running', taskId: 'bg-1', cursor: 4 }),
          evidenceRef: toolCall.id,
        };
      }
      return {
        classification: {
          kind: 'background_completed',
          command: 'npm test',
          exitCode: 0,
        },
        output: JSON.stringify({
          status: 'completed',
          taskId: 'bg-1',
          exitCode: 0,
          output: 'all green',
        }),
        evidenceRef: toolCall.id,
      };
    });

    const result = await executeStopVerificationPlan({
      plan,
      taskState,
      verificationState,
      executeToolCall,
      pollIntervalMs: 1,
      wait,
    });

    expect(result.status).toBe('passed');
    expect(executeToolCall.mock.calls.map(([toolCall]) => toolCall.arguments)).toEqual([
      { command: 'npm test', timeout: 500 },
      { action: 'check', task_id: 'bg-1', since: 0 },
      { action: 'check', task_id: 'bg-1', since: 4 },
    ]);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('treats a completed background task with a nonzero exit as failed', async () => {
    const plan = makePlan(['npm test']);
    const taskState = new TaskState('edit');
    const verificationState = createVerificationRuntimeState();
    const executeToolCall = vi.fn()
      .mockResolvedValueOnce({
        classification: { kind: 'background_start', command: 'npm test' },
        output: JSON.stringify({ taskId: 'bg-2', status: 'started' }),
        evidenceRef: 'start',
      })
      .mockResolvedValueOnce({
        classification: {
          kind: 'background_failed',
          command: 'npm test',
          exitCode: 7,
          statusLabel: 'completed_nonzero',
        },
        output: JSON.stringify({
          taskId: 'bg-2',
          status: 'completed',
          exitCode: 7,
          output: 'suite failed',
        }),
        evidenceRef: 'check',
      });

    const result = await executeStopVerificationPlan({
      plan,
      taskState,
      verificationState,
      executeToolCall,
      wait: async () => {},
    });

    expect(result).toMatchObject({
      status: 'failed',
      failedCommand: 'npm test',
      exitCode: 7,
      evidenceRef: 'check',
      outputTail: 'suite failed',
    });
  });

  it('uses structured background timeout status without stopping an already terminal task', async () => {
    const executeToolCall = vi.fn()
      .mockResolvedValueOnce({
        classification: { kind: 'background_start', command: 'npm test' },
        output: JSON.stringify({ taskId: 'bg-structured-timeout', status: 'started' }),
        evidenceRef: 'start',
      })
      .mockResolvedValueOnce({
        classification: {
          kind: 'background_failed',
          command: 'npm test',
          statusLabel: 'timeout',
        },
        output: JSON.stringify({
          command: 'npm test',
          taskId: 'bg-structured-timeout',
          status: 'timeout',
        }),
        evidenceRef: 'terminal-timeout',
      });

    const result = await executeStopVerificationPlan({
      plan: makePlan(['npm test']),
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall,
      pollIntervalMs: 1,
      wait: async () => {},
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
      evidenceRef: 'terminal-timeout',
    });
    expect(executeToolCall).toHaveBeenCalledTimes(2);
  });

  it('maps a ToolGate or approval block to unavailable without running later commands', async () => {
    const plan = makePlan(['npm test', 'npm run lint']);
    const verificationState = createVerificationRuntimeState();
    const executeToolCall = vi.fn(async (): Promise<VerificationToolCallResult> => ({
      classification: null,
      output: '[ToolGate] command blocked',
      evidenceRef: 'blocked-call',
      blocked: true,
    }));

    const result = await executeStopVerificationPlan({
      plan,
      taskState: new TaskState('edit'),
      verificationState,
      executeToolCall,
    });

    expect(executeToolCall).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'blocked',
      failedCommand: 'npm test',
      evidenceRef: 'blocked-call',
    });
    expect(verificationState.lastResult?.status).toBe('unavailable');
  });

  it('bounds background polling by the plan command timeout', async () => {
    const plan = makePlan([
      { command: 'npm test', required: true, timeoutMs: 20 },
    ]);
    const verificationState = createVerificationRuntimeState();
    let clock = 0;
    const executeToolCall = vi.fn(async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
      if (toolCall.arguments.action === 'stop') {
        return {
          classification: null,
          operationStatus: 'completed',
          output: 'stopped',
          evidenceRef: toolCall.id,
        };
      }
      return toolCall.arguments.action
        ? {
            classification: { kind: 'background_running', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-timeout', status: 'running' }),
            evidenceRef: toolCall.id,
          }
        : {
            classification: { kind: 'background_start', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-timeout', status: 'started' }),
            evidenceRef: toolCall.id,
          };
    });

    const result = await executeStopVerificationPlan({
      plan,
      taskState: new TaskState('edit'),
      verificationState,
      executeToolCall,
      pollIntervalMs: 10,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
      failedCommand: 'npm test',
    });
    expect(executeToolCall).toHaveBeenCalledTimes(3);
    expect(executeToolCall.mock.calls.at(-1)?.[0].arguments).toEqual({
      action: 'stop',
      task_id: 'bg-timeout',
    });
    expect(verificationState.lastResult?.status).toBe('unavailable');
  });

  it('uses bounded exponential polling and carries the output cursor forward', async () => {
    const plan = makePlan([
      { command: 'npm test', required: true, timeoutMs: 20_000 },
    ]);
    const waits: number[] = [];
    let check = 0;
    const executeToolCall = vi.fn(async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
      if (!toolCall.arguments.action) {
        return {
          classification: { kind: 'background_start', command: 'npm test' },
          output: JSON.stringify({ taskId: 'bg-backoff', status: 'started' }),
          evidenceRef: toolCall.id,
        };
      }
      check += 1;
      if (check <= 4) {
        return {
          classification: { kind: 'background_running', command: 'npm test' },
          output: JSON.stringify({
            taskId: 'bg-backoff',
            status: 'running',
            cursor: check * 10,
          }),
          evidenceRef: toolCall.id,
        };
      }
      return {
        classification: { kind: 'background_completed', command: 'npm test', exitCode: 0 },
        output: JSON.stringify({ taskId: 'bg-backoff', status: 'completed', exitCode: 0 }),
        evidenceRef: toolCall.id,
      };
    });

    const result = await executeStopVerificationPlan({
      plan,
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall,
      wait: async ms => {
        waits.push(ms);
      },
    });

    expect(result.status).toBe('passed');
    expect(waits).toEqual([500, 1_000, 2_000, 2_000, 2_000]);
    expect(executeToolCall.mock.calls.slice(1).map(([call]) => call.arguments.since))
      .toEqual([0, 10, 20, 30, 40]);
  });

  it('stops a background task when the maximum poll count is exhausted', async () => {
    const plan = makePlan([
      { command: 'npm test', required: true, timeoutMs: 60_000 },
    ]);
    const executeToolCall = vi.fn(async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
      if (toolCall.arguments.action === 'stop') {
        return {
          classification: null,
          operationStatus: 'completed',
          output: 'stopped',
          evidenceRef: toolCall.id,
        };
      }
      return toolCall.arguments.action === 'check'
        ? {
            classification: { kind: 'background_running', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-poll-limit', status: 'running', cursor: 1 }),
            evidenceRef: toolCall.id,
          }
        : {
            classification: { kind: 'background_start', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-poll-limit', status: 'started' }),
            evidenceRef: toolCall.id,
          };
    });

    const result = await executeStopVerificationPlan({
      plan,
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall,
      maxPollAttempts: 3,
      wait: async () => {},
    });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(executeToolCall).toHaveBeenCalledTimes(5);
    expect(executeToolCall.mock.calls.at(-1)?.[0].arguments.action).toBe('stop');
  });

  it('returns explicit cleanup failure evidence when stop is not acknowledged', async () => {
    const executeToolCall = vi.fn(async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
      if (toolCall.arguments.action === 'stop') {
        return {
          classification: null,
          operationStatus: 'failed',
          output: 'Task could not be stopped',
          evidenceRef: 'stop-failed',
        };
      }
      return toolCall.arguments.action === 'check'
        ? {
            classification: { kind: 'background_running', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-cleanup-fail', status: 'running' }),
            evidenceRef: toolCall.id,
          }
        : {
            classification: { kind: 'background_start', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-cleanup-fail', status: 'started' }),
            evidenceRef: toolCall.id,
          };
    });

    const result = await executeStopVerificationPlan({
      plan: makePlan([{ command: 'npm test', required: true, timeoutMs: 10 }]),
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall,
      pollIntervalMs: 10,
      wait: async () => {},
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'cleanup_failed',
      evidenceRef: 'stop-failed',
      outputTail: 'Task could not be stopped',
    });
  });

  it('stops a running background task after abort and returns cleanup evidence', async () => {
    const plan = makePlan(['npm test']);
    const abortController = new AbortController();
    const executeToolCall = vi.fn(async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
      if (toolCall.arguments.action === 'stop') {
        return {
          classification: null,
          operationStatus: 'completed',
          output: 'terminated',
          evidenceRef: 'stop-evidence',
        };
      }
      return toolCall.arguments.action === 'check'
        ? {
            classification: { kind: 'background_running', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-abort', status: 'running', cursor: 2 }),
            evidenceRef: toolCall.id,
          }
        : {
            classification: { kind: 'background_start', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-abort', status: 'started' }),
            evidenceRef: toolCall.id,
          };
    });

    const result = await executeStopVerificationPlan({
      plan,
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall,
      abortSignal: abortController.signal,
      wait: async () => {
        abortController.abort();
      },
    });

    expect(result).toMatchObject({
      status: 'aborted',
      reason: 'aborted',
      evidenceRef: 'stop-evidence',
    });
    expect(executeToolCall.mock.calls.at(-1)?.[0].arguments.action).toBe('stop');
  });

  it('returns aborted and records a non-passing state when tool execution aborts', async () => {
    const plan = makePlan(['npm test']);
    const verificationState = createVerificationRuntimeState();

    const result = await executeStopVerificationPlan({
      plan,
      taskState: new TaskState('edit'),
      verificationState,
      executeToolCall: async () => ({
        classification: null,
        output: 'Tool execution was interrupted.',
        evidenceRef: 'aborted-call',
        aborted: true,
      }),
    });

    expect(result).toMatchObject({
      status: 'aborted',
      failedCommand: 'npm test',
      evidenceRef: 'aborted-call',
    });
    expect(verificationState.lastResult?.status).toBe('unavailable');
  });

  it('does not mark a green plan fresh when its command mutates the workspace', async () => {
    const plan = makePlan(['npm test']);
    const taskState = new TaskState('edit');
    taskState.recordCommandWorkspaceMutation(['src/before.ts']);
    const verificationState = createVerificationRuntimeState();

    const result = await executeStopVerificationPlan({
      plan,
      taskState,
      verificationState,
      executeToolCall: async () => {
        taskState.recordCommandWorkspaceMutation(['generated/report.json']);
        return foreground('npm test');
      },
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'workspace_mutated',
      failedCommand: 'npm test',
    });
    expect(verificationState.workspaceMutationVersion).toBe(2);
    expect(verificationState.lastResult?.status).toBe('unavailable');
    expect(isVerificationFresh(verificationState, plan.fingerprint)).toBe(false);
  });

  it('records an optional command failure and continues to required commands', async () => {
    const plan = makePlan([
      { command: 'npm run optional', required: false, timeoutMs: 1_000 },
      { command: 'npm test', required: true, timeoutMs: 1_000 },
    ]);
    const executeToolCall = vi.fn(async (toolCall: ToolCall) =>
      toolCall.arguments.command === 'npm run optional'
        ? foreground('npm run optional', false)
        : foreground('npm test'),
    );
    const verificationState = createVerificationRuntimeState();

    const result = await executeStopVerificationPlan({
      plan,
      taskState: new TaskState('edit'),
      verificationState,
      executeToolCall,
    });

    expect(result.status).toBe('passed');
    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(verificationState.lastResult?.status).toBe('passed');
  });

  it('uses the shared default timeout for an invalid command timeout', async () => {
    const plan = {
      ...makePlan(['npm test']),
      commands: [{
        command: 'npm test',
        required: true,
        timeoutMs: Number.NaN,
      }],
    };
    const executeToolCall = vi.fn(async () => foreground('npm test'));

    await executeStopVerificationPlan({
      plan,
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall,
    });

    expect(executeToolCall.mock.calls[0]?.[0].arguments.timeout)
      .toBe(DEFAULT_VERIFICATION_TIMEOUT_MS);
  });

  it('classifies the shell short-command cap as unavailable timeout', async () => {
    const result = await executeStopVerificationPlan({
      plan: makePlan(['npm test']),
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall: async () => foreground(
        'npm test',
        false,
        'Tool execution error: Command timed out (10000ms)',
      ),
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
      failedCommand: 'npm test',
    });
  });

  it.each([
    'FAIL test/api.test.ts > retries\nError: Test timed out in 5000ms',
    'AssertionError: expected connection timeout message',
  ])('does not confuse ordinary test output with a Harness timeout: %s', async (output) => {
    const result = await executeStopVerificationPlan({
      plan: makePlan(['npm test']),
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall: async () => foreground('npm test', false, output),
    });

    expect(result).toMatchObject({
      status: 'failed',
      failedCommand: 'npm test',
    });
    expect(result).not.toHaveProperty('reason', 'timeout');
  });

  it('treats an already completed task as successful cleanup receipt', async () => {
    const executeToolCall = vi.fn(async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
      if (toolCall.arguments.action === 'stop') {
        return {
          classification: null,
          operationStatus: 'failed',
          output: 'Tool execution error: Task bg-natural is not running (status: completed)',
          evidenceRef: 'natural-terminal',
        };
      }
      return {
        classification: { kind: 'background_start', command: 'npm test' },
        output: JSON.stringify({ taskId: 'bg-natural', status: 'started' }),
        evidenceRef: toolCall.id,
      };
    });

    const result = await executeStopVerificationPlan({
      plan: makePlan([{ command: 'npm test', required: true, timeoutMs: 10 }]),
      taskState: new TaskState('edit'),
      verificationState: createVerificationRuntimeState(),
      executeToolCall,
      pollIntervalMs: 10,
      now: () => 0,
      wait: async () => {},
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
      evidenceRef: 'natural-terminal',
    });
  });

  it('keeps synthetic tool-call sequencing local to each plan execution', async () => {
    const ids: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const current: string[] = [];
      await executeStopVerificationPlan({
        plan: makePlan(['npm test']),
        taskState: new TaskState('edit'),
        verificationState: createVerificationRuntimeState(),
        executeToolCall: async (toolCall) => {
          current.push(toolCall.id);
          return foreground('npm test');
        },
      });
      ids.push(current);
    }

    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]?.[0]).toMatch(/:run:1$/);
  });

  it('fails closed when the verification mirror is ahead of TaskState', async () => {
    const verificationState = createVerificationRuntimeState();
    verificationState.workspaceMutationVersion = 5;
    const executeToolCall = vi.fn(async () => foreground('npm test'));

    const result = await executeStopVerificationPlan({
      plan: makePlan(['npm test']),
      taskState: new TaskState('restored older task'),
      verificationState,
      executeToolCall,
    });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid_result' });
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it('fails closed when TaskState mutation tracking is saturated', async () => {
    const taskState = new TaskState('saturated task');
    taskState.applySnapshot({
      ...taskState.snapshot(),
      workspaceMutationVersion: Number.MAX_SAFE_INTEGER,
    });
    const executeToolCall = vi.fn(async () => foreground('npm test'));

    const result = await executeStopVerificationPlan({
      plan: makePlan(['npm test']),
      taskState,
      verificationState: createVerificationRuntimeState(),
      executeToolCall,
    });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid_result' });
    expect(executeToolCall).not.toHaveBeenCalled();
  });
});
