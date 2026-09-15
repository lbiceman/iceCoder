import { describe, expect, it, vi } from 'vitest';

import {
  executeStopVerificationPlan,
  type VerificationToolCallResult,
} from '../../src/harness/harness-stop-verification.js';
import {
  buildVerificationPlan,
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
      { action: 'check', task_id: 'bg-1' },
      { action: 'check', task_id: 'bg-1' },
    ]);
    expect(wait).toHaveBeenCalledOnce();
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
    const executeToolCall = vi.fn(async (toolCall: ToolCall): Promise<VerificationToolCallResult> => (
      toolCall.arguments.action
        ? {
            classification: { kind: 'background_running', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-timeout', status: 'running' }),
            evidenceRef: toolCall.id,
          }
        : {
            classification: { kind: 'background_start', command: 'npm test' },
            output: JSON.stringify({ taskId: 'bg-timeout', status: 'started' }),
            evidenceRef: toolCall.id,
          }
    ));

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
    expect(verificationState.lastResult?.status).toBe('unavailable');
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
});
