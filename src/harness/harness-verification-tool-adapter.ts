import type { ToolCall, ToolDefinition } from '../llm/types.js';
import { redactToolArguments, redactToolCalls } from '../tools/tool-argument-redaction.js';
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
import {
  classifyRunCommandResult,
  extractRunCommandTaskId,
} from './run-command-result.js';
import { executeToolCallsThroughGate } from './supervisor/tool-gate.js';
import { stepToolOutputPreview } from './tool-step-preview.js';
import type { HarnessStepEvent } from './types.js';
import type { VerificationToolCallResult } from './harness-stop-verification.js';
import type { GraphExecutor } from './task-graph-executor.js';
import { buildHarnessToolGateContext } from './harness-tool-gate-context.js';

export interface HarnessVerificationToolAdapterOptions {
  deps: ToolExecutorDeps;
  state: HarnessRunState;
  currentTools: ToolDefinition[];
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  abortSignal?: AbortSignal;
  graphExecutor?: GraphExecutor;
}

/**
 * 把停时 synthetic 工具调用送入与普通工具轮相同的 Gate、权限和执行链。
 */
export function createHarnessVerificationToolAdapter(
  options: HarnessVerificationToolAdapterOptions,
): (toolCall: ToolCall) => Promise<VerificationToolCallResult> {
  const intermediatePollCallIds = new Map<string, string[]>();
  return async (toolCall: ToolCall): Promise<VerificationToolCallResult> => {
    const { deps, state } = options;
    deps.branchBudget = state.branchBudget;
    deps.missingFileAttempts = state.missingFileAttempts;
    deps.harnessPolicyStats = state.harnessPolicyStats;
    state.branchBudget?.bindWorkspaceRoot(deps.workspaceRoot);
    state.messages.push({
      role: 'assistant',
      content: '',
      toolCalls: redactToolCalls([toolCall]),
    });

    const gateResult = executeToolCallsThroughGate({
      toolCalls: [toolCall],
      messages: state.messages,
      ctx: buildHarnessToolGateContext(options.graphExecutor, [toolCall], state),
    });
    const gateBlocked = gateResult.executableToolCalls.length === 0;
    const graphExecutor = options.graphExecutor;
    const forcedGraphActive = (state.executionMode ?? 'free') === 'forced'
      && graphExecutor?.hasGraph() === true;
    const tracksGraphDeviation = forcedGraphActive && isInitialVerificationRun(toolCall);

    if (gateBlocked) {
      emitGateBlockObservability(options, toolCall);
      const outcomes = recordToolOperationOutcomes(state.operationOutcomes, {
        toolCalls: [toolCall],
        messages: state.messages,
        policyBlockedSignatures: [...gateResult.skippedSignatures],
      });
      const result = adapterResult(
        options,
        toolCall,
        outcomes[0],
        true,
      );
      compactBackgroundPollMessages(options.state, toolCall, result, intermediatePollCallIds);
      return result;
    }
    if (tracksGraphDeviation) {
      graphExecutor?.checkToolCall(toolCall.name, { track: true });
    }

    const stats = await executeToolCallsStreaming(deps, {
      toolCalls: gateResult.executableToolCalls,
      messages: state.messages,
      logger: options.logger,
      onStep: options.onStep,
      harnessAbortSignal: isBackgroundStop(toolCall) ? undefined : options.abortSignal,
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
    if (tracksGraphDeviation) {
      graphExecutor?.recordToolResult(
        toolCall.name,
        !!outcome && outcome.disposition === 'executed' && outcome.status !== 'failed',
      );
    }
    const blocked = isUnavailableOutcome(outcome);
    if (
      blocked
      && !stats.policyBlockedSignatures.includes(toolCallSignature(toolCall))
    ) {
      emitApprovalBlockCompletion(options, toolCall);
    }
    const result = adapterResult(options, toolCall, outcome, blocked);
    compactBackgroundPollMessages(options.state, toolCall, result, intermediatePollCallIds);
    return result;
  };
}

function adapterResult(
  options: HarnessVerificationToolAdapterOptions,
  toolCall: ToolCall,
  outcome: OperationOutcome | undefined,
  blocked: boolean,
): VerificationToolCallResult {
  const output = latestToolOutput(options.state, toolCall.id);
  const aborted = !isBackgroundStop(toolCall) && (
    options.abortSignal?.aborted === true
    || options.deps.loopController.isAborted()
    || /tool execution was interrupted/i.test(output)
  );
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
    ...(outcome?.status ? { operationStatus: outcome.status } : {}),
    ...(blocked ? { blocked: true } : {}),
    ...(aborted ? { aborted: true } : {}),
  };
}

function compactBackgroundPollMessages(
  state: HarnessRunState,
  toolCall: ToolCall,
  result: VerificationToolCallResult,
  intermediatePollCallIds: Map<string, string[]>,
): void {
  const taskId = backgroundTaskId(toolCall, result.output);
  if (!taskId) return;
  if (result.classification?.kind === 'background_start') {
    intermediatePollCallIds.set(taskId, []);
    return;
  }
  const action = String(toolCall.arguments?.action ?? '').toLowerCase();
  if (action !== 'check' && action !== 'stop') return;
  if (result.classification?.kind === 'background_running') {
    const ids = intermediatePollCallIds.get(taskId) ?? [];
    ids.push(toolCall.id);
    intermediatePollCallIds.set(taskId, ids);
    return;
  }
  const ids = new Set(intermediatePollCallIds.get(taskId) ?? []);
  if (ids.size > 0) {
    const retained = state.messages.filter(message => {
      if (message.role === 'tool') return !ids.has(message.toolCallId ?? '');
      if (message.role !== 'assistant' || !message.toolCalls?.length) return true;
      return !message.toolCalls.some(call => ids.has(call.id));
    });
    state.messages.splice(0, state.messages.length, ...retained);
  }
  intermediatePollCallIds.delete(taskId);
}

function backgroundTaskId(toolCall: ToolCall, output: string): string | null {
  return extractRunCommandTaskId(toolCall.arguments, output);
}

function isBackgroundStop(toolCall: ToolCall): boolean {
  return toolCall.name === 'run_command'
    && String(toolCall.arguments?.action ?? '').toLowerCase() === 'stop';
}

function isInitialVerificationRun(toolCall: ToolCall): boolean {
  return toolCall.name === 'run_command'
    && !String(toolCall.arguments?.action ?? '').trim();
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
