import type { ToolCall } from '../llm/types.js';
import type { ToolResultStatus } from '../tools/types.js';
import {
  extractRunCommandTaskId,
  type RunCommandResultClassification,
} from './run-command-result.js';
import type { TaskState } from './task-state.js';
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  type VerificationPlan,
  type VerificationPlanCommand,
} from './verification-plan.js';
import {
  markVerificationFailed,
  markVerificationPassed,
  markVerificationUnavailable,
  recordVerificationCommandResult,
  syncVerificationWorkspaceMutation,
  type VerificationRuntimeState,
} from './verification-state.js';

export type StopVerificationStatus = 'passed' | 'failed' | 'unavailable' | 'aborted';

export type StopVerificationUnavailableReason =
  | 'blocked'
  | 'timeout'
  | 'aborted'
  | 'invalid_result'
  | 'execution_error'
  | 'cleanup_failed'
  | 'workspace_mutated';

export interface VerificationToolCallResult {
  classification: RunCommandResultClassification | null;
  output: string;
  evidenceRef: string;
  blocked?: boolean;
  aborted?: boolean;
  operationStatus?: ToolResultStatus;
}

export interface StopVerificationResult {
  status: StopVerificationStatus;
  reason?: StopVerificationUnavailableReason;
  failedCommand?: string;
  exitCode?: number;
  evidenceRef?: string;
  outputTail?: string;
}

export interface ExecuteStopVerificationPlanOptions {
  plan: VerificationPlan;
  taskState: TaskState;
  verificationState: VerificationRuntimeState;
  executeToolCall: (toolCall: ToolCall) => Promise<VerificationToolCallResult>;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  maxPollAttempts?: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  abortSignal?: AbortSignal;
  outputTailChars?: number;
}

interface SettledCommandResult {
  status: 'passed' | 'failed' | 'unavailable' | 'aborted';
  reason?: StopVerificationUnavailableReason;
  exitCode?: number;
  evidenceRef?: string;
  outputTail?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 60;
const DEFAULT_OUTPUT_TAIL_CHARS = 2_000;

/**
 * 在模型提出停手后顺序执行一次确定的验收计划。
 * 所有命令均通过注入的工具回调执行；本模块不直接创建子进程。
 */
export async function executeStopVerificationPlan(
  options: ExecuteStopVerificationPlanOptions,
): Promise<StopVerificationResult> {
  const {
    plan,
    taskState,
    verificationState,
  } = options;
  syncVerificationWorkspaceMutation(verificationState, taskState);
  const initialMutationVersion = taskState.snapshot().workspaceMutationVersion;
  if (
    verificationState.workspaceMutationVersion !== initialMutationVersion
    || initialMutationVersion === Number.MAX_SAFE_INTEGER
  ) {
    return finishUnavailable(options, undefined, {
      status: 'unavailable',
      reason: 'invalid_result',
    });
  }
  let syntheticToolCallSequence = 0;
  const nextToolCallId = (commandIndex: number, phase: string): string => {
    syntheticToolCallSequence = syntheticToolCallSequence >= Number.MAX_SAFE_INTEGER
      ? 1
      : syntheticToolCallSequence + 1;
    return [
      'stop-verification',
      plan.id.replace(/[^a-zA-Z0-9_-]/g, '-'),
      commandIndex,
      phase,
      syntheticToolCallSequence,
    ].join(':');
  };

  if (plan.commands.length === 0) {
    return finishUnavailable(options, undefined, {
      status: 'unavailable',
      reason: 'invalid_result',
    });
  }

  let lastCommand: string | undefined;
  let lastEvidenceRef: string | undefined;

  for (let index = 0; index < plan.commands.length; index++) {
    const command = plan.commands[index]!;
    lastCommand = command.command;

    if (options.abortSignal?.aborted) {
      return finishAborted(options, command.command, {
        status: 'aborted',
        reason: 'aborted',
      });
    }

    const settled = await executeVerificationCommand(
      options,
      command,
      index,
      nextToolCallId,
    );
    lastEvidenceRef = settled.evidenceRef ?? lastEvidenceRef;
    if (settled.status === 'passed' || settled.status === 'failed') {
      recordVerificationCommandResult(verificationState, {
        plan,
        result: {
          kind: 'foreground',
          command: command.command,
          foregroundSuccess: settled.status === 'passed',
          ...(settled.exitCode !== undefined ? { exitCode: settled.exitCode } : {}),
        },
        ...(settled.evidenceRef ? { evidenceRef: settled.evidenceRef } : {}),
      });
    }
    if (settled.status === 'failed') {
      if (!command.required) continue;
      return finishFailed(options, command.command, settled);
    }
    if (settled.status === 'unavailable') {
      if (!command.required) continue;
      return finishUnavailable(options, command.command, settled);
    }
    if (settled.status === 'aborted') {
      return finishAborted(options, command.command, settled);
    }
  }

  const finalMutationVersion = taskState.snapshot().workspaceMutationVersion;
  syncVerificationWorkspaceMutation(verificationState, taskState);
  if (finalMutationVersion !== initialMutationVersion) {
    return finishUnavailable(options, lastCommand, {
      status: 'unavailable',
      reason: 'workspace_mutated',
      evidenceRef: lastEvidenceRef,
    });
  }

  markVerificationPassed(verificationState, {
    planFingerprint: plan.fingerprint,
    source: plan.source,
    ...(lastCommand ? { command: lastCommand } : {}),
    exitCode: 0,
    ...(lastEvidenceRef ? { evidenceRef: lastEvidenceRef } : {}),
  });
  return {
    status: 'passed',
    ...(lastEvidenceRef ? { evidenceRef: lastEvidenceRef } : {}),
  };
}

async function executeVerificationCommand(
  options: ExecuteStopVerificationPlanOptions,
  command: VerificationPlanCommand,
  commandIndex: number,
  nextToolCallId: (commandIndex: number, phase: string) => string,
): Promise<SettledCommandResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = positiveInteger(
    command.timeoutMs,
    DEFAULT_VERIFICATION_TIMEOUT_MS,
  );
  let syntheticElapsedMs = 0;

  const initial = await invokeTool(options, {
    id: nextToolCallId(commandIndex, 'run'),
    name: 'run_command',
    arguments: {
      command: command.command,
      timeout: timeoutMs,
    },
  });
  const initialSettled = settleImmediateResult(initial);
  if (initialSettled) return initialSettled;

  const taskId = extractRunCommandTaskId(undefined, initial.output);
  if (!taskId) {
    return {
      status: 'unavailable',
      reason: 'invalid_result',
      evidenceRef: initial.evidenceRef,
      outputTail: outputTail(initial.output, options.outputTailChars),
    };
  }

  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const maxPollIntervalMs = Math.max(
    pollIntervalMs,
    positiveInteger(options.maxPollIntervalMs, DEFAULT_MAX_POLL_INTERVAL_MS),
  );
  const maxPollAttempts = positiveInteger(
    options.maxPollAttempts,
    DEFAULT_MAX_POLL_ATTEMPTS,
  );
  const wait = options.wait ?? defaultWait;
  let pollIndex = 0;
  let lastResult = initial;
  let cursor = outputCursor(initial.output) ?? 0;
  let nextDelayMs = pollIntervalMs;

  while (
    pollIndex < maxPollAttempts
    && elapsedMs(now, startedAt, syntheticElapsedMs) < timeoutMs
  ) {
    if (options.abortSignal?.aborted) {
      return stopBackgroundTask(options, commandIndex, taskId, {
        status: 'aborted',
        reason: 'aborted',
        evidenceRef: lastResult.evidenceRef,
        outputTail: outputTail(lastResult.output, options.outputTailChars),
      }, nextToolCallId);
    }

    const remainingBeforeWait = timeoutMs - elapsedMs(now, startedAt, syntheticElapsedMs);
    if (remainingBeforeWait <= 0) break;
    const delay = Math.min(nextDelayMs, remainingBeforeWait);
    try {
      await wait(delay);
    } catch (error) {
      const interrupted: SettledCommandResult = options.abortSignal?.aborted
        ? {
            status: 'aborted',
            reason: 'aborted',
            evidenceRef: lastResult.evidenceRef,
            outputTail: outputTail(lastResult.output, options.outputTailChars),
          }
        : {
            status: 'unavailable',
            reason: 'execution_error',
            evidenceRef: lastResult.evidenceRef,
            outputTail: outputTail(errorText(error), options.outputTailChars),
          };
      return stopBackgroundTask(
        options,
        commandIndex,
        taskId,
        interrupted,
        nextToolCallId,
      );
    }
    syntheticElapsedMs += delay;
    if (options.abortSignal?.aborted) {
      return stopBackgroundTask(options, commandIndex, taskId, {
        status: 'aborted',
        reason: 'aborted',
        evidenceRef: lastResult.evidenceRef,
        outputTail: outputTail(lastResult.output, options.outputTailChars),
      }, nextToolCallId);
    }
    if (elapsedMs(now, startedAt, syntheticElapsedMs) >= timeoutMs) break;

    const checked = await invokeTool(options, {
      id: nextToolCallId(commandIndex, `check-${pollIndex++}`),
      name: 'run_command',
      arguments: {
        action: 'check',
        task_id: taskId,
        since: cursor,
      },
    });
    lastResult = checked;
    cursor = outputCursor(checked.output) ?? cursor;
    const settled = settleImmediateResult(checked);
    if (settled) {
      const terminalBackgroundResult = checked.classification?.kind === 'background_completed'
        || checked.classification?.kind === 'background_failed';
      if (
        !terminalBackgroundResult
        && (settled.status === 'aborted' || settled.status === 'unavailable')
      ) {
        return stopBackgroundTask(
          options,
          commandIndex,
          taskId,
          settled,
          nextToolCallId,
        );
      }
      return settled;
    }
    nextDelayMs = Math.min(nextDelayMs * 2, maxPollIntervalMs);
  }

  return stopBackgroundTask(options, commandIndex, taskId, {
    status: 'unavailable',
    reason: 'timeout',
    evidenceRef: lastResult.evidenceRef,
    outputTail: outputTail(lastResult.output, options.outputTailChars),
  }, nextToolCallId);
}

async function stopBackgroundTask(
  options: ExecuteStopVerificationPlanOptions,
  commandIndex: number,
  taskId: string,
  pendingResult: SettledCommandResult,
  nextToolCallId: (commandIndex: number, phase: string) => string,
): Promise<SettledCommandResult> {
  const stopped = await invokeTool(options, {
    id: nextToolCallId(commandIndex, 'stop'),
    name: 'run_command',
    arguments: { action: 'stop', task_id: taskId },
  });
  const cleanupSucceeded = !stopped.blocked
    && !stopped.aborted
    && (
      isAlreadySettledStopOutput(stopped.output)
      || (
        stopped.operationStatus !== 'failed'
        && stopped.operationStatus !== 'awaiting_approval'
        && (
          stopped.operationStatus === 'completed'
          || stopped.classification?.kind === 'background_completed'
          || stopped.classification?.kind === 'background_failed'
          || /\b(?:stopped|killed|terminated)\b/i.test(stopped.output)
        )
      )
    );
  return {
    ...pendingResult,
    ...(!cleanupSucceeded ? { reason: 'cleanup_failed' as const } : {}),
    evidenceRef: stopped.evidenceRef,
    outputTail: outputTail(stopped.output, options.outputTailChars)
      ?? pendingResult.outputTail,
  };
}

async function invokeTool(
  options: ExecuteStopVerificationPlanOptions,
  toolCall: ToolCall,
): Promise<VerificationToolCallResult> {
  try {
    return await options.executeToolCall(toolCall);
  } catch (error) {
    return {
      classification: null,
      output: errorText(error),
      evidenceRef: toolCall.id,
      aborted: options.abortSignal?.aborted === true,
    };
  }
}

function settleImmediateResult(
  result: VerificationToolCallResult,
): SettledCommandResult | null {
  if (result.aborted) {
    return {
      status: 'aborted',
      reason: 'aborted',
      evidenceRef: result.evidenceRef,
      outputTail: outputTail(result.output),
    };
  }
  if (result.blocked) {
    return {
      status: 'unavailable',
      reason: 'blocked',
      evidenceRef: result.evidenceRef,
      outputTail: outputTail(result.output),
    };
  }

  const classification = result.classification;
  if (!classification) {
    return {
      status: 'unavailable',
      reason: 'invalid_result',
      evidenceRef: result.evidenceRef,
      outputTail: outputTail(result.output),
    };
  }

  if (classification.kind === 'foreground') {
    return classification.foregroundSuccess
      ? { status: 'passed', evidenceRef: result.evidenceRef }
      : isTimeoutClassification(classification, result.output)
      ? {
          status: 'unavailable',
          reason: 'timeout',
          evidenceRef: result.evidenceRef,
          outputTail: outputTail(result.output),
        }
      : {
          status: 'failed',
          exitCode: classificationExitCode(classification, result.output),
          evidenceRef: result.evidenceRef,
          outputTail: outputTail(result.output),
        };
  }
  if (classification.kind === 'background_completed') {
    return {
      status: 'passed',
      evidenceRef: result.evidenceRef,
    };
  }
  if (classification.kind === 'background_failed') {
    if (classification.statusLabel === 'timeout' || isTimeoutOutput(result.output)) {
      return {
        status: 'unavailable',
        reason: 'timeout',
        evidenceRef: result.evidenceRef,
        outputTail: outputTail(result.output),
      };
    }
    return {
      status: 'failed',
      ...(classification.exitCode !== undefined
        ? { exitCode: classification.exitCode }
        : {}),
      evidenceRef: result.evidenceRef,
      outputTail: outputTail(result.output),
    };
  }
  if (classification.kind === 'background_start'
    || classification.kind === 'background_running') {
    return null;
  }
  return {
    status: 'unavailable',
    reason: 'invalid_result',
    evidenceRef: result.evidenceRef,
    outputTail: outputTail(result.output),
  };
}

function finishFailed(
  options: ExecuteStopVerificationPlanOptions,
  failedCommand: string,
  settled: SettledCommandResult,
): StopVerificationResult {
  syncVerificationWorkspaceMutation(options.verificationState, options.taskState);
  markVerificationFailed(options.verificationState, {
    planFingerprint: options.plan.fingerprint,
    source: options.plan.source,
    command: failedCommand,
    ...(settled.exitCode !== undefined ? { exitCode: settled.exitCode } : {}),
    ...(settled.evidenceRef ? { evidenceRef: settled.evidenceRef } : {}),
    blockingSignature: verificationBlockingSignature('failed', failedCommand, settled.exitCode),
  });
  return {
    status: 'failed',
    failedCommand,
    ...(settled.exitCode !== undefined ? { exitCode: settled.exitCode } : {}),
    ...(settled.evidenceRef ? { evidenceRef: settled.evidenceRef } : {}),
    ...(settled.outputTail ? { outputTail: boundedTail(
      settled.outputTail,
      options.outputTailChars,
    ) } : {}),
  };
}

function finishUnavailable(
  options: ExecuteStopVerificationPlanOptions,
  failedCommand: string | undefined,
  settled: SettledCommandResult,
): StopVerificationResult {
  syncVerificationWorkspaceMutation(options.verificationState, options.taskState);
  markVerificationUnavailable(options.verificationState, {
    planFingerprint: options.plan.fingerprint,
    source: options.plan.source,
    ...(failedCommand ? { command: failedCommand } : {}),
    ...(settled.evidenceRef ? { evidenceRef: settled.evidenceRef } : {}),
    blockingSignature: verificationBlockingSignature(
      settled.reason ?? 'unavailable',
      failedCommand,
    ),
  });
  return {
    status: 'unavailable',
    ...(settled.reason ? { reason: settled.reason } : {}),
    ...(failedCommand ? { failedCommand } : {}),
    ...(settled.evidenceRef ? { evidenceRef: settled.evidenceRef } : {}),
    ...(settled.outputTail ? { outputTail: boundedTail(
      settled.outputTail,
      options.outputTailChars,
    ) } : {}),
  };
}

function finishAborted(
  options: ExecuteStopVerificationPlanOptions,
  failedCommand: string,
  settled: SettledCommandResult,
): StopVerificationResult {
  syncVerificationWorkspaceMutation(options.verificationState, options.taskState);
  markVerificationUnavailable(options.verificationState, {
    planFingerprint: options.plan.fingerprint,
    source: options.plan.source,
    command: failedCommand,
    ...(settled.evidenceRef ? { evidenceRef: settled.evidenceRef } : {}),
    blockingSignature: verificationBlockingSignature('aborted', failedCommand),
  });
  return {
    status: 'aborted',
    ...(settled.reason ? { reason: settled.reason } : {}),
    failedCommand,
    ...(settled.evidenceRef ? { evidenceRef: settled.evidenceRef } : {}),
    ...(settled.outputTail ? { outputTail: boundedTail(
      settled.outputTail,
      options.outputTailChars,
    ) } : {}),
  };
}

function outputCursor(output: string): number | null {
  const value = parseObject(output)?.cursor;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function isTimeoutClassification(
  classification: Extract<RunCommandResultClassification, { kind: 'foreground' }>,
  output: string,
): boolean {
  return !classification.foregroundSuccess && isTimeoutOutput(output);
}

function isTimeoutOutput(output: string): boolean {
  return /(?:^|\r?\n)(?:Tool execution error:\s*)?Command timed out \(\d+ms\)(?:\r?\n|$)/i
    .test(output)
    || /"reason"\s*:\s*"soft_timeout"/i.test(output);
}

function isAlreadySettledStopOutput(output: string): boolean {
  return /\bnot running \(status:\s*(?:completed|failed|timeout|killed)\)/i.test(output);
}

function classificationExitCode(
  classification: Extract<RunCommandResultClassification, { kind: 'foreground' }>,
  output: string,
): number | undefined {
  const extended = classification as typeof classification & { exitCode?: unknown };
  if (typeof extended.exitCode === 'number' && Number.isFinite(extended.exitCode)) {
    return Math.trunc(extended.exitCode);
  }
  const parsed = parseObject(output);
  if (typeof parsed?.exitCode === 'number' && Number.isFinite(parsed.exitCode)) {
    return Math.trunc(parsed.exitCode);
  }
  const match = output.match(/exit\s+code\s*[:=]?\s*\(?\s*(-?\d+)/i)
    ?? output.match(/exit\s+code\s*:\s*(-?\d+)/i);
  return match ? Number.parseInt(match[1]!, 10) : undefined;
}

function outputTail(output: string, limit?: number): string | undefined {
  const parsed = parseObject(output);
  const payload = typeof parsed?.output === 'string' ? parsed.output : output;
  const trimmed = payload.trim();
  return trimmed ? boundedTail(trimmed, limit) : undefined;
}

function boundedTail(value: string, limit?: number): string {
  const cap = positiveInteger(limit, DEFAULT_OUTPUT_TAIL_CHARS);
  return value.length <= cap ? value : value.slice(-cap);
}

function elapsedMs(now: () => number, startedAt: number, syntheticElapsedMs: number): number {
  const wallElapsed = Math.max(0, now() - startedAt);
  return Math.max(wallElapsed, syntheticElapsedMs);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function verificationBlockingSignature(
  reason: string,
  command?: string,
  exitCode?: number,
): string {
  return [
    'stop-verification',
    reason,
    command ?? '',
    exitCode ?? '',
  ].join(':');
}

function parseObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultWait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
