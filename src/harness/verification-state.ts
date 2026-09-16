import {
  normalizeAcceptanceCommandKey,
  stripLeadingCdPrefix,
  type RunCommandResultClassification,
} from './run-command-result.js';
import type {
  VerificationPlan,
  VerificationPlanSource,
} from './verification-plan.js';
import type { TaskState } from './task-state.js';

export type VerificationResultStatus = 'passed' | 'failed' | 'unavailable';

export interface VerificationLastResult {
  status: VerificationResultStatus;
  source: VerificationPlanSource;
  command?: string;
  exitCode?: number;
  evidenceRef?: string;
}

export interface VerificationFreshness {
  workspaceMutationVersion: number;
  verifiedMutationVersion: number | null;
  verifiedPlanFingerprint: string | null;
  attemptedMutationVersion: number | null;
  attemptedPlanFingerprint: string | null;
}

export interface VerificationRuntimeState extends VerificationFreshness {
  continuationCount: number;
  blockingSignature: string | null;
  lastResult: VerificationLastResult | null;
  commandProgress: VerificationCommandProgress[];
}

export interface VerificationCommandProgress {
  planFingerprint: string;
  commandIndex: number;
  command: string;
  required: boolean;
  status: 'passed' | 'failed';
  mutationVersion: number;
  evidenceRef?: string;
  exitCode?: number;
}

export interface RecordVerificationCommandResultOptions {
  plan: VerificationPlan;
  result: RunCommandResultClassification;
  evidenceRef?: string;
  /** 命令自身造成 mutation 时，证据只覆盖执行前版本。 */
  mutationVersion?: number;
}

export interface VerificationCommandRecordResult {
  matchedCommands: string[];
  allRequiredPassed: boolean;
}

export interface MarkVerificationResultOptions {
  planFingerprint: string;
  source: VerificationPlanSource;
  command?: string;
  exitCode?: number;
  evidenceRef?: string;
  blockingSignature?: string;
}

export function createVerificationRuntimeState(): VerificationRuntimeState {
  return {
    workspaceMutationVersion: 0,
    verifiedMutationVersion: null,
    verifiedPlanFingerprint: null,
    attemptedMutationVersion: null,
    attemptedPlanFingerprint: null,
    continuationCount: 0,
    blockingSignature: null,
    lastResult: null,
    commandProgress: [],
  };
}

/**
 * 仅把 TaskState 的单调 mutation version 镜像到 verification runtime。
 * TaskState 是唯一真源；持久化镜像与它冲突时清除验证身份并服从 TaskState。
 */
export function syncVerificationWorkspaceMutation(
  state: VerificationRuntimeState,
  taskState: Pick<TaskState, 'snapshot'>,
): VerificationRuntimeState {
  const sourceVersion = taskState.snapshot().workspaceMutationVersion;
  const currentVersion = isNonNegativeInteger(state.workspaceMutationVersion)
    ? state.workspaceMutationVersion
    : 0;
  if (sourceVersion < currentVersion) {
    clearVerificationIdentities(state);
  }
  state.workspaceMutationVersion = sourceVersion;
  if (sourceVersion === Number.MAX_SAFE_INTEGER) clearVerificationIdentities(state);
  return state;
}

function clearVerificationIdentities(state: VerificationRuntimeState): void {
  state.verifiedMutationVersion = null;
  state.verifiedPlanFingerprint = null;
  state.attemptedMutationVersion = null;
  state.attemptedPlanFingerprint = null;
  state.commandProgress = [];
}

export function isVerificationFresh(
  state: VerificationFreshness & Pick<VerificationRuntimeState, 'lastResult'>,
  planFingerprint: string,
): boolean {
  return !!planFingerprint
    && state.lastResult?.status === 'passed'
    && isNonNegativeInteger(state.workspaceMutationVersion)
    && isNonNegativeInteger(state.verifiedMutationVersion)
    && state.workspaceMutationVersion === state.verifiedMutationVersion
    && state.verifiedPlanFingerprint === planFingerprint;
}

export function markVerificationPassed(
  state: VerificationRuntimeState,
  options: MarkVerificationResultOptions,
): VerificationRuntimeState {
  state.verifiedMutationVersion = state.workspaceMutationVersion;
  state.verifiedPlanFingerprint = options.planFingerprint;
  state.attemptedMutationVersion = state.workspaceMutationVersion;
  state.attemptedPlanFingerprint = options.planFingerprint;
  state.blockingSignature = null;
  state.lastResult = buildLastResult('passed', options);
  return state;
}

export function markVerificationFailed(
  state: VerificationRuntimeState,
  options: MarkVerificationResultOptions,
): VerificationRuntimeState {
  return markVerificationNotPassed(state, 'failed', options);
}

export function markVerificationUnavailable(
  state: VerificationRuntimeState,
  options: MarkVerificationResultOptions,
): VerificationRuntimeState {
  return markVerificationNotPassed(state, 'unavailable', options);
}

export function sanitizeVerificationRuntimeState(value: unknown): VerificationRuntimeState {
  const record = asRecord(value);
  if (!record) return createVerificationRuntimeState();

  const workspaceVersion = persistedVersion(record.workspaceMutationVersion);
  const verifiedVersion = persistedVersion(record.verifiedMutationVersion);
  const verifiedFingerprint = nonEmptyString(record.verifiedPlanFingerprint);
  const verifiedStateIsValid = workspaceVersion !== null
    && verifiedVersion !== null
    && verifiedVersion <= workspaceVersion
    && verifiedFingerprint !== null;
  const attemptedVersion = persistedVersion(record.attemptedMutationVersion);
  const attemptedFingerprint = nonEmptyString(record.attemptedPlanFingerprint);
  const attemptedStateIsValid = workspaceVersion !== null
    && attemptedVersion !== null
    && attemptedVersion <= workspaceVersion
    && attemptedFingerprint !== null;

  return {
    workspaceMutationVersion: workspaceVersion ?? 0,
    verifiedMutationVersion: verifiedStateIsValid ? verifiedVersion : null,
    verifiedPlanFingerprint: verifiedStateIsValid ? verifiedFingerprint : null,
    attemptedMutationVersion: attemptedStateIsValid ? attemptedVersion : null,
    attemptedPlanFingerprint: attemptedStateIsValid ? attemptedFingerprint : null,
    continuationCount: nonNegativeInteger(record.continuationCount),
    blockingSignature: nonEmptyString(record.blockingSignature),
    lastResult: sanitizeLastResult(record.lastResult),
    commandProgress: sanitizeCommandProgress(record.commandProgress),
  };
}

/**
 * 把普通工具轮或停时 runner 的真实终态映射到当前计划。
 * 匹配只认规范化后的完整命令；成功的 `a && b` 可覆盖多个独立计划项。
 */
export function recordVerificationCommandResult(
  state: VerificationRuntimeState,
  options: RecordVerificationCommandResultOptions,
): VerificationCommandRecordResult {
  const { plan, result } = options;
  if (result.kind === 'background_start' || result.kind === 'background_running') {
    return { matchedCommands: [], allRequiredPassed: false };
  }

  const terminal = terminalCommandResult(result);
  const matchedIndexes = matchPlanCommandIndexes(plan, result.command, terminal.status);
  if (matchedIndexes.length === 0) {
    return { matchedCommands: [], allRequiredPassed: false };
  }

  const resultMutationVersion = isNonNegativeInteger(options.mutationVersion)
    && options.mutationVersion <= state.workspaceMutationVersion
    ? options.mutationVersion
    : state.workspaceMutationVersion;
  for (const commandIndex of matchedIndexes) {
    const command = plan.commands[commandIndex]!;
    const progress: VerificationCommandProgress = {
      planFingerprint: plan.fingerprint,
      commandIndex,
      command: command.command,
      required: command.required,
      status: terminal.status,
      mutationVersion: resultMutationVersion,
      ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
    };
    state.commandProgress = state.commandProgress.filter(item =>
      !(
        item.planFingerprint === plan.fingerprint
        && item.mutationVersion === resultMutationVersion
        && item.commandIndex === commandIndex
      ),
    );
    state.commandProgress.push(progress);
  }

  const failedRequiredIndex = terminal.status === 'failed'
    ? matchedIndexes.find(index => plan.commands[index]?.required)
    : undefined;
  if (failedRequiredIndex !== undefined) {
    const command = plan.commands[failedRequiredIndex]!;
    markVerificationFailed(state, {
      planFingerprint: plan.fingerprint,
      source: plan.source,
      command: command.command,
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
      blockingSignature: [
        'verification',
        plan.fingerprint,
        state.workspaceMutationVersion,
        commandIndexKey(failedRequiredIndex),
        terminal.exitCode ?? '',
      ].join(':'),
    });
  }

  const allRequiredPassed = plan.commands.every((command, commandIndex) =>
    !command.required || state.commandProgress.some(progress =>
      progress.planFingerprint === plan.fingerprint
      && progress.mutationVersion === state.workspaceMutationVersion
      && progress.commandIndex === commandIndex
      && progress.status === 'passed',
    ),
  );
  if (allRequiredPassed) {
    const lastIndex = matchedIndexes.at(-1)!;
    markVerificationPassed(state, {
      planFingerprint: plan.fingerprint,
      source: plan.source,
      command: plan.commands[lastIndex]!.command,
      exitCode: 0,
      ...(options.evidenceRef ? { evidenceRef: options.evidenceRef } : {}),
    });
  }

  return {
    matchedCommands: matchedIndexes.map(index => plan.commands[index]!.command),
    allRequiredPassed,
  };
}

export function tryConsumeVerificationContinuation(
  state: VerificationRuntimeState,
  maxContinuations: number,
): boolean {
  if (!isNonNegativeInteger(maxContinuations)) return false;
  const current = isNonNegativeInteger(state.continuationCount)
    ? state.continuationCount
    : 0;
  if (current >= maxContinuations) return false;
  state.continuationCount = current + 1;
  return true;
}

function markVerificationNotPassed(
  state: VerificationRuntimeState,
  status: Exclude<VerificationResultStatus, 'passed'>,
  options: MarkVerificationResultOptions,
): VerificationRuntimeState {
  state.attemptedMutationVersion = state.workspaceMutationVersion;
  state.attemptedPlanFingerprint = options.planFingerprint;
  state.blockingSignature = nonEmptyString(options.blockingSignature);
  state.lastResult = buildLastResult(status, options);
  return state;
}

function buildLastResult(
  status: VerificationResultStatus,
  options: MarkVerificationResultOptions,
): VerificationLastResult {
  const result: VerificationLastResult = {
    status,
    source: options.source,
  };
  if (options.command !== undefined) result.command = options.command;
  if (options.exitCode !== undefined) result.exitCode = options.exitCode;
  if (options.evidenceRef !== undefined) result.evidenceRef = options.evidenceRef;
  return result;
}

function sanitizeLastResult(value: unknown): VerificationLastResult | null {
  const record = asRecord(value);
  if (!record) return null;
  const status = parseVerificationResultStatus(record.status);
  const source = verificationSource(record.source);
  if (!status || !source) return null;

  const result: VerificationLastResult = { status, source };
  if (typeof record.command === 'string' && record.command.trim()) {
    result.command = record.command;
  }
  if (typeof record.exitCode === 'number' && Number.isFinite(record.exitCode)) {
    result.exitCode = Math.trunc(record.exitCode);
  }
  if (typeof record.evidenceRef === 'string' && record.evidenceRef.trim()) {
    result.evidenceRef = record.evidenceRef;
  }
  return result;
}

function sanitizeCommandProgress(value: unknown): VerificationCommandProgress[] {
  if (!Array.isArray(value)) return [];
  const progress: VerificationCommandProgress[] = [];
  for (const item of value.slice(-256)) {
    const record = asRecord(item);
    if (!record) continue;
    const planFingerprint = nonEmptyString(record.planFingerprint);
    const command = nonEmptyString(record.command);
    const commandIndex = persistedVersion(record.commandIndex);
    const mutationVersion = persistedVersion(record.mutationVersion);
    const status = record.status === 'passed' || record.status === 'failed'
      ? record.status
      : null;
    if (
      !planFingerprint
      || !command
      || commandIndex === null
      || mutationVersion === null
      || typeof record.required !== 'boolean'
      || !status
    ) {
      continue;
    }
    progress.push({
      planFingerprint,
      commandIndex,
      command,
      required: record.required,
      status,
      mutationVersion,
      ...(nonEmptyString(record.evidenceRef)
        ? { evidenceRef: nonEmptyString(record.evidenceRef)! }
        : {}),
      ...(typeof record.exitCode === 'number' && Number.isFinite(record.exitCode)
        ? { exitCode: Math.trunc(record.exitCode) }
        : {}),
    });
  }
  return progress;
}

function terminalCommandResult(
  result: Exclude<
    RunCommandResultClassification,
    { kind: 'background_start' | 'background_running' }
  >,
): { status: 'passed' | 'failed'; exitCode?: number } {
  if (result.kind === 'foreground') {
    return {
      status: result.foregroundSuccess ? 'passed' : 'failed',
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    };
  }
  if (result.kind === 'background_completed') {
    const passed = result.exitCode === undefined || result.exitCode === 0;
    return {
      status: passed ? 'passed' : 'failed',
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    };
  }
  return {
    status: 'failed',
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  };
}

function matchPlanCommandIndexes(
  plan: VerificationPlan,
  rawCommand: string,
  status: 'passed' | 'failed',
): number[] {
  const runKey = normalizeAcceptanceCommandKey(rawCommand);
  if (!runKey) return [];
  const planKeys = plan.commands.map(command =>
    normalizeAcceptanceCommandKey(command.command),
  );
  const exactIndex = planKeys.findIndex(key => key === runKey);
  if (exactIndex >= 0) return [exactIndex];

  const segments = stripLeadingCdPrefix(rawCommand)
    .split(/\s*(?:&&|;)\s*/)
    .map(segment => normalizeAcceptanceCommandKey(segment))
    .filter(Boolean);
  const matched: number[] = [];
  const seen = new Set<number>();
  for (const segment of segments) {
    const index = planKeys.findIndex((key, candidateIndex) =>
      !seen.has(candidateIndex) && key === segment,
    );
    if (index < 0) continue;
    seen.add(index);
    matched.push(index);
  }
  // `&&` 在第一个非零段短路；没有逐段 shell 回执时只记录首个可归因失败，
  // 绝不把后续未执行段一起标红。
  return status === 'failed' ? matched.slice(0, 1) : matched;
}

function commandIndexKey(index: number): string {
  return `command-${index}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): number {
  return persistedVersion(value) ?? 0;
}

function persistedVersion(value: unknown): number | null {
  return isNonNegativeInteger(value) ? value : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseVerificationResultStatus(value: unknown): VerificationResultStatus | null {
  return value === 'passed' || value === 'failed' || value === 'unavailable'
    ? value
    : null;
}

function verificationSource(value: unknown): VerificationPlanSource | null {
  return value === 'user' || value === 'project' || value === 'runtime_default'
    ? value
    : null;
}
