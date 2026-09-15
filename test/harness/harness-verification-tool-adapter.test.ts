import { describe, expect, it, vi } from 'vitest';

import {
  createHarnessVerificationToolAdapter,
} from '../../src/harness/harness-verification-tool-adapter.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { OperationOutcomeLedger } from '../../src/harness/operation-outcome.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { VerificationOutputBuffer } from '../../src/harness/verification-output-buffer.js';
import type { ToolCall, ToolDefinition, UnifiedMessage } from '../../src/llm/types.js';

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
      gateContext: {
        executionMode: 'forced',
        graphHints: [{
          toolName: 'run_command',
          action: 'block',
          message: 'verification command is outside the active step',
        }],
      },
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
  });
});
