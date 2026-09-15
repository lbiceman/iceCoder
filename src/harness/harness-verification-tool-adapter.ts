import type { ToolCall, ToolDefinition } from '../llm/types.js';
import { redactToolArguments, redactToolCalls } from '../tools/tool-argument-redaction.js';
import type { GateContext } from '../types/supervisor.js';
import { CompletionFactsView } from './completion-facts-view.js';
import type { HarnessRunState } from './harness-run-state.js';
import {
  executeToolCallsStreaming,
  type ToolExecutorDeps,
} from './harness-tool-executor.js';
import type { HarnessLogger } from './logger.js';
import {
  recordToolOperationOutcomes,
  type OperationOutcome,
} from './operation-outcome.js';
import { toolCallSignature } from './harness-permission-runtime.js';
import { classifyRunCommandResult } from './run-command-result.js';
import { executeToolCallsThroughGate } from './supervisor/tool-gate.js';
import { stepToolOutputPreview } from './tool-step-preview.js';
import type { HarnessStepEvent } from './types.js';
import type { VerificationToolCallResult } from './harness-stop-verification.js';

export interface HarnessVerificationToolAdapterOptions {
  deps: ToolExecutorDeps;
  state: HarnessRunState;
  currentTools: ToolDefinition[];
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  abortSignal?: AbortSignal;
  /**
   * 下一任务接线时可传入当前 graph 派生的 GateContext。
   * 未传时仍经过现有 ToolGate，只是不附加 graph step hints。
   */
  gateContext?: GateContext;
}

/**
 * 把停时 synthetic 工具调用送入与普通工具轮相同的 Gate、权限和执行链。
 */
export function createHarnessVerificationToolAdapter(
  options: HarnessVerificationToolAdapterOptions,
): (toolCall: ToolCall) => Promise<VerificationToolCallResult> {
  return async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
    const { deps, state } = options;
    state.messages.push({
      role: 'assistant',
      content: '',
      toolCalls: redactToolCalls([toolCall]),
    });

    const gateResult = executeToolCallsThroughGate({
      toolCalls: [toolCall],
      messages: state.messages,
      ctx: options.gateContext ?? {
        executionMode: state.executionMode ?? 'free',
        graphHints: [],
      },
    });
    const gateBlocked = gateResult.executableToolCalls.length === 0;

    if (gateBlocked) {
      emitGateBlockObservability(options, toolCall);
      const outcomes = recordToolOperationOutcomes(state.operationOutcomes, {
        toolCalls: [toolCall],
        messages: state.messages,
        policyBlockedSignatures: [...gateResult.skippedSignatures],
      });
      return adapterResult(
        options,
        toolCall,
        outcomes[0],
        true,
      );
    }

    const stats = await executeToolCallsStreaming(deps, {
      toolCalls: gateResult.executableToolCalls,
      messages: state.messages,
      logger: options.logger,
      onStep: options.onStep,
      harnessAbortSignal: options.abortSignal,
      taskState: state.taskState,
      repoContext: state.repoContext,
      currentTools: options.currentTools,
      buildDiagnosticGateActive: state.buildDiagnosticGateActive,
      completionFacts: CompletionFactsView.fromHarnessRunState(state),
      verificationOutputBuffer: state.verificationOutputBuffer,
      shellMandatoryConfirmDenials: state.shellMandatoryConfirmDenials,
    });
    const outcomes = recordToolOperationOutcomes(state.operationOutcomes, {
      toolCalls: [toolCall],
      messages: state.messages,
      failedSignatures: stats.failedSignatures,
      policyBlockedSignatures: stats.policyBlockedSignatures,
    });
    const outcome = outcomes[0];
    const blocked = isUnavailableOutcome(outcome);
    if (
      blocked
      && !stats.policyBlockedSignatures.includes(toolCallSignature(toolCall))
    ) {
      emitApprovalBlockCompletion(options, toolCall);
    }
    return adapterResult(options, toolCall, outcome, blocked);
  };
}

function adapterResult(
  options: HarnessVerificationToolAdapterOptions,
  toolCall: ToolCall,
  outcome: OperationOutcome | undefined,
  blocked: boolean,
): VerificationToolCallResult {
  const output = latestToolOutput(options.state, toolCall.id);
  const aborted = options.abortSignal?.aborted === true
    || options.deps.loopController.isAborted()
    || /tool execution was interrupted/i.test(output);
  const executionSucceeded = !!outcome
    && outcome.disposition === 'executed'
    && outcome.status !== 'failed'
    && outcome.status !== 'awaiting_approval';
  const classification = blocked || aborted
    ? null
    : classifyRunCommandResult(
        toolCall.arguments as Record<string, unknown>,
        output,
        executionSucceeded,
      );

  return {
    classification,
    output,
    evidenceRef: toolCall.id,
    ...(blocked ? { blocked: true } : {}),
    ...(aborted ? { aborted: true } : {}),
  };
}

function latestToolOutput(state: HarnessRunState, toolCallId: string): string {
  const message = [...state.messages].reverse().find(
    item => item.role === 'tool' && item.toolCallId === toolCallId,
  );
  return typeof message?.content === 'string'
    ? message.content
    : 'Tool execution was interrupted.';
}

function isUnavailableOutcome(outcome: OperationOutcome | undefined): boolean {
  return !outcome
    || outcome.disposition === 'policy_block'
    || outcome.disposition === 'user_denied'
    || outcome.status === 'awaiting_approval';
}

function emitGateBlockObservability(
  options: HarnessVerificationToolAdapterOptions,
  toolCall: ToolCall,
): void {
  const iteration = options.deps.loopController.getState().currentRound;
  const output = latestToolOutput(options.state, toolCall.id);
  options.logger.toolResult(toolCall.name, false, output.length, 'tool_gate_block');
  options.onStep?.({
    type: 'tool_denied',
    iteration,
    toolName: toolCall.name,
  });
  options.onStep?.({
    type: 'tool_result',
    iteration,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolSuccess: false,
    toolOutcome: 'policy_block',
    toolOutput: stepToolOutputPreview(toolCall.name, output),
    toolError: 'tool_gate_block',
    toolArgs: redactToolArguments(toolCall.name, toolCall.arguments),
  });
  options.deps.runtimeTelemetry?.recordTool({
    round: iteration,
    toolName: toolCall.name,
    success: false,
    outcome: 'policy_block',
    policyReason: 'tool_gate_block',
    outputLength: output.length,
  });
  options.deps.loopController.recordToolCalls(1);
}

/**
 * permission/mandatory-confirm 的旧分支只发 tool_denied；为 synthetic 调用补齐
 * tool_result 与 telemetry，同时仍由原执行链决定是否允许。
 */
function emitApprovalBlockCompletion(
  options: HarnessVerificationToolAdapterOptions,
  toolCall: ToolCall,
): void {
  const iteration = options.deps.loopController.getState().currentRound;
  const output = latestToolOutput(options.state, toolCall.id);
  options.onStep?.({
    type: 'tool_result',
    iteration,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    toolSuccess: false,
    toolOutcome: 'policy_block',
    toolOutput: stepToolOutputPreview(toolCall.name, output),
    toolError: 'verification_unavailable',
    toolArgs: redactToolArguments(toolCall.name, toolCall.arguments),
  });
  options.deps.runtimeTelemetry?.recordTool({
    round: iteration,
    toolName: toolCall.name,
    success: false,
    outcome: 'policy_block',
    policyReason: 'verification_unavailable',
    outputLength: output.length,
  });
  options.deps.loopController.recordToolCalls(1);
}
