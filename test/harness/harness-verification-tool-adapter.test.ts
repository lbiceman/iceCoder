import { describe, expect, it, vi } from 'vitest';

import {
  createHarnessVerificationToolAdapter,
} from '../../src/harness/harness-verification-tool-adapter.js';
import { executeStopVerificationPlan } from '../../src/harness/harness-stop-verification.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { OperationOutcomeLedger } from '../../src/harness/operation-outcome.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { VerificationOutputBuffer } from '../../src/harness/verification-output-buffer.js';
import type { ToolCall, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';
import { buildVerificationPlan } from '../../src/harness/verification-plan.js';
import { createVerificationRuntimeState } from '../../src/harness/verification-state.js';

const runCommandDefinition: ToolDefinition = {
  name: 'run_command',
  description: 'run',
  parameters: { type: 'object', properties: {} },
};

function adapterState(messages: UnifiedMessage[] = []): HarnessRunState {
  return {
    messages,
    taskState: new TaskState('edit'),
    repoContext: new RepoContext(),
    operationOutcomes: new OperationOutcomeLedger(),
    shellMandatoryConfirmDenials: new Set(),
    verificationOutputBuffer: new VerificationOutputBuffer(),
    executionMode: 'free',
  } as HarnessRunState;
}

describe('Harness verification tool adapter', () => {
  it('puts synthetic calls in history and reuses normal execution events, telemetry, and outcomes', async () => {
    const state = adapterState();
    const executeTool = vi.fn(async () => ({ success: true, output: 'all green' }));
    const recordTool = vi.fn();
    const onStep = vi.fn();
    const adapter = createHarnessVerificationToolAdapter({
      deps: {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
        runtimeTelemetry: { recordTool } as never,
      },
      state,
      currentTools: [runCommandDefinition],
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
      onStep,
    });
    const toolCall: ToolCall = {
      id: 'verify-1',
      name: 'run_command',
      arguments: { command: 'npm test', timeout: 321 },
    };

    const result = await adapter(toolCall);

    expect(executeTool).toHaveBeenCalledWith(toolCall, expect.any(Function));
    expect(result).toMatchObject({
      classification: {
        kind: 'foreground',
        command: 'npm test',
        foregroundSuccess: true,
      },
      output: 'all green',
      evidenceRef: 'verify-1',
    });
    expect(state.messages[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [toolCall],
    });
    expect(state.messages[1]).toEqual({
      role: 'tool',
      content: 'all green',
      toolCallId: 'verify-1',
    });
    expect(state.operationOutcomes?.getByToolCallId('verify-1')).toMatchObject({
      status: 'completed',
      disposition: 'executed',
    });
    expect(state.taskState.snapshot().commandsRun).toContain('npm test');
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_call' }));
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result' }));
    expect(recordTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'run_command',
      success: true,
    }));
  });

  it('maps mandatory-confirm denial from the shared permission chain to blocked', async () => {
    const state = adapterState();
    const executeTool = vi.fn();
    const onShellMandatoryConfirm = vi.fn(async () => false);
    const recordTool = vi.fn();
    const onStep = vi.fn();
    const adapter = createHarnessVerificationToolAdapter({
      deps: {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
        sessionId: 'verification-confirm',
        onShellMandatoryConfirm,
        runtimeTelemetry: { recordTool } as never,
      },
      state,
      currentTools: [runCommandDefinition],
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
      onStep,
    });

    const result = await adapter({
      id: 'verify-denied',
      name: 'run_command',
      arguments: { command: 'git reset --hard', timeout: 1000 },
    });

    expect(onShellMandatoryConfirm).toHaveBeenCalledOnce();
    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      classification: null,
      evidenceRef: 'verify-denied',
      blocked: true,
    });
    expect(state.operationOutcomes?.getByToolCallId('verify-denied')).toMatchObject({
      status: 'failed',
      disposition: 'user_denied',
    });
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      toolCallId: 'verify-denied',
      toolOutcome: 'policy_block',
    }));
    expect(recordTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'run_command',
      success: false,
      outcome: 'policy_block',
    }));
  });

  it('reuses ToolGate and never submits a forced-step block to the executor', async () => {
    const state = adapterState();
    state.executionMode = 'forced';
    const executeTool = vi.fn();
    const checkToolCall = vi.fn(() => ({
      action: 'block' as const,
      message: 'verification command is outside the active step',
    }));
    const adapter = createHarnessVerificationToolAdapter({
      deps: {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
      },
      state,
      currentTools: [runCommandDefinition],
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
      graphExecutor: {
        hasGraph: () => true,
        checkToolCall,
        recordToolResult: vi.fn(),
      } as never,
    });

    const result = await adapter({
      id: 'verify-gated',
      name: 'run_command',
      arguments: { command: 'npm test', timeout: 1000 },
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      classification: null,
      evidenceRef: 'verify-gated',
      blocked: true,
    });
    expect(state.operationOutcomes?.getByToolCallId('verify-gated')).toMatchObject({
      status: 'failed',
      disposition: 'policy_block',
    });
    expect(checkToolCall).toHaveBeenCalledWith('run_command', { track: false });
    expect(checkToolCall).not.toHaveBeenCalledWith('run_command', { track: true });
  });

  it('tracks an allowed forced-graph call exactly like a regular tool round', async () => {
    const state = adapterState();
    state.executionMode = 'forced';
    const checkToolCall = vi.fn(() => ({ action: 'allow' as const }));
    const executeTool = vi.fn(async () => ({ success: true, output: 'ok' }));
    const adapter = createHarnessVerificationToolAdapter({
      deps: {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 2 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
      },
      state,
      currentTools: [runCommandDefinition],
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
      graphExecutor: {
        hasGraph: () => true,
        checkToolCall,
        recordToolResult: vi.fn(),
      } as never,
    });

    const result = await adapter({
      id: 'verify-forced-allowed',
      name: 'run_command',
      arguments: { command: 'npm test', timeout: 1_000 },
    });

    expect(result.blocked).not.toBe(true);
    expect(checkToolCall.mock.calls).toEqual([
      ['run_command', { track: false }],
      ['run_command', { track: true }],
    ]);
  });

  it.each([
    ['BranchBudget', false],
    ['preflight', true],
  ])('maps a %s block from the shared executor to unavailable', async (_label, preflight) => {
    const state = adapterState();
    state.buildDiagnosticGateActive = preflight;
    state.branchBudget = {
      bindWorkspaceRoot: vi.fn(),
      hasWriteBypass: () => false,
      wouldBlockCommandRetry: () => preflight,
      checkToolBlock: () => preflight
        ? { blocked: false }
        : {
            blocked: true,
            dimension: 'command_retry',
            key: 'npm test',
            message: '[BranchBudget / Blocked] retry cap',
          },
    } as never;
    const executeTool = vi.fn();
    const adapter = createHarnessVerificationToolAdapter({
      deps: {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 2 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
      },
      state,
      currentTools: [runCommandDefinition],
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
    });

    const result = await adapter({
      id: `verify-${preflight ? 'preflight' : 'budget'}`,
      name: 'run_command',
      arguments: { command: 'npm test', timeout: 1_000 },
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ classification: null, blocked: true });
    expect(state.operationOutcomes?.getByToolCallId(
      `verify-${preflight ? 'preflight' : 'budget'}`,
    )).toMatchObject({ disposition: 'policy_block' });
  });

  it('collapses intermediate background poll pairs after a terminal result', async () => {
    const state = adapterState();
    let check = 0;
    const executeTool = vi.fn(async (toolCall: ToolCall) => {
      if (!toolCall.arguments.action) {
        return {
          success: true,
          output: JSON.stringify({
            mode: 'background',
            taskId: 'bg-collapse',
            status: 'started',
          }),
        };
      }
      check += 1;
      return {
        success: true,
        output: JSON.stringify(check < 3
          ? {
              command: 'npm test',
              taskId: 'bg-collapse',
              status: 'running',
              cursor: check,
            }
          : {
              command: 'npm test',
              taskId: 'bg-collapse',
              status: 'completed',
              exitCode: 0,
              cursor: check,
            }),
      };
    });
    const adapter = createHarnessVerificationToolAdapter({
      deps: {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 6 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
      },
      state,
      currentTools: [runCommandDefinition],
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
    });

    await adapter({
      id: 'verify-start',
      name: 'run_command',
      arguments: { command: 'npm test', timeout: 10_000 },
    });
    await adapter({
      id: 'verify-running-1',
      name: 'run_command',
      arguments: { action: 'check', task_id: 'bg-collapse', since: 0 },
    });
    await adapter({
      id: 'verify-running-2',
      name: 'run_command',
      arguments: { action: 'check', task_id: 'bg-collapse', since: 1 },
    });
    const terminal = await adapter({
      id: 'verify-completed',
      name: 'run_command',
      arguments: { action: 'check', task_id: 'bg-collapse', since: 2 },
    });

    expect(terminal.operationStatus).toBe('completed');
    expect(state.messages).toHaveLength(4);
    expect(state.messages.filter(message => message.role === 'assistant')
      .flatMap(message => message.toolCalls ?? [])
      .map(call => call.id)).toEqual(['verify-start', 'verify-completed']);
    expect(state.messages.filter(message => message.role === 'tool')
      .map(message => message.toolCallId)).toEqual(['verify-start', 'verify-completed']);
    expect(state.operationOutcomes?.hasPending()).toBe(false);
  });

  it('settles the operation ledger after timeout cleanup through the same adapter', async () => {
    const state = adapterState();
    const executeTool = vi.fn(async (toolCall: ToolCall) => {
      const action = toolCall.arguments.action;
      if (action === 'check') {
        return {
          success: true,
          output: JSON.stringify({
            command: 'npm test',
            taskId: 'bg-timeout-ledger',
            status: 'running',
            cursor: 8,
          }),
        };
      }
      if (action === 'stop') {
        return {
          success: true,
          output: 'Stopped background task bg-timeout-ledger',
        };
      }
      return {
        success: true,
        output: JSON.stringify({
          mode: 'background',
          taskId: 'bg-timeout-ledger',
          status: 'started',
        }),
      };
    });
    const adapter = createHarnessVerificationToolAdapter({
      deps: {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 5 }),
        permissionRules: [],
        workspaceRoot: process.cwd(),
      },
      state,
      currentTools: [runCommandDefinition],
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
    });
    const plan = buildVerificationPlan({
      source: 'user',
      commands: [{ command: 'npm test', required: true, timeoutMs: 10 }],
      workspaceRoot: process.cwd(),
    })!;
    let clock = 0;

    const result = await executeStopVerificationPlan({
      plan,
      taskState: state.taskState,
      verificationState: createVerificationRuntimeState(),
      executeToolCall: adapter,
      pollIntervalMs: 10,
      now: () => clock,
      wait: async ms => {
        clock += ms;
      },
    });

    expect(result).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(executeTool.mock.calls.map(([call]) => call.arguments.action ?? 'start'))
      .toEqual(['start', 'stop']);
    expect(state.operationOutcomes?.hasPending()).toBe(false);
    expect(state.messages).toHaveLength(4);
  });
});
