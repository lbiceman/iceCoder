import type { VerificationPlanSource } from './verification-plan.js';

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
  verifiedMutationVersion: number;
  verifiedPlanFingerprint: string | null;
}

export interface VerificationRuntimeState extends VerificationFreshness {
  continuationCount: number;
  blockingSignature: string | null;
  lastResult: VerificationLastResult | null;
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
    verifiedMutationVersion: 0,
    verifiedPlanFingerprint: null,
    continuationCount: 0,
    blockingSignature: null,
    lastResult: null,
  };
}

export function markWorkspaceMutation(
  state: VerificationRuntimeState,
): VerificationRuntimeState {
  if (state.workspaceMutationVersion >= Number.MAX_SAFE_INTEGER) {
    state.workspaceMutationVersion = Number.MAX_SAFE_INTEGER;
    state.verifiedMutationVersion = Math.min(
      state.verifiedMutationVersion,
      Number.MAX_SAFE_INTEGER - 1,
    );
  } else {
    state.workspaceMutationVersion += 1;
  }
  return state;
}

export function isVerificationFresh(
  state: VerificationFreshness & Pick<VerificationRuntimeState, 'lastResult'>,
  planFingerprint: string,
): boolean {
  return !!planFingerprint
    && state.lastResult?.status === 'passed'
    && state.workspaceMutationVersion === state.verifiedMutationVersion
    && state.verifiedPlanFingerprint === planFingerprint;
}

export function markVerificationPassed(
  state: VerificationRuntimeState,
  options: MarkVerificationResultOptions,
): VerificationRuntimeState {
  state.verifiedMutationVersion = state.workspaceMutationVersion;
  state.verifiedPlanFingerprint = options.planFingerprint;
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

  return {
    workspaceMutationVersion: nonNegativeInteger(record.workspaceMutationVersion),
    verifiedMutationVersion: nonNegativeInteger(record.verifiedMutationVersion),
    verifiedPlanFingerprint: nonEmptyString(record.verifiedPlanFingerprint),
    continuationCount: nonNegativeInteger(record.continuationCount),
    blockingSignature: nonEmptyString(record.blockingSignature),
    lastResult: sanitizeLastResult(record.lastResult),
  };
}

export function restoreVerificationRuntimeState(value: unknown): VerificationRuntimeState {
  return sanitizeVerificationRuntimeState(value);
}

function markVerificationNotPassed(
  state: VerificationRuntimeState,
  status: Exclude<VerificationResultStatus, 'passed'>,
  options: MarkVerificationResultOptions,
): VerificationRuntimeState {
  state.verifiedMutationVersion = state.workspaceMutationVersion;
  state.verifiedPlanFingerprint = options.planFingerprint;
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
  const status = verificationStatus(record.status);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function verificationStatus(value: unknown): VerificationResultStatus | null {
  return value === 'passed' || value === 'failed' || value === 'unavailable'
    ? value
    : null;
}

function verificationSource(value: unknown): VerificationPlanSource | null {
  return value === 'user' || value === 'project' || value === 'runtime_default'
    ? value
    : null;
}
