import { createHash } from 'node:crypto';

import type { UnifiedMessage } from '../llm/types.js';
import {
  PROJECT_CHECKPOINT_VERSION,
  cloneProjectCheckpointV3,
  isPersistableCheckpointMessage,
  isProjectCheckpointV3,
  type CheckpointSaveTrigger,
  type ProjectCheckpointV3,
} from '../types/runtime-checkpoint.js';
import type {
  RepoContextSnapshot,
  TaskStateSnapshot,
} from '../types/runtime-snapshot.js';
import type { CompletionCondition } from './completion-condition.js';
import type { OperationOutcome } from './operation-outcome.js';
import type { AcceptanceGateSnapshot } from './task-acceptance-tracker.js';
import type { LoopState, StopReason } from './types.js';

const EPOCH = '1970-01-01T00:00:00.000Z';
const INTENTS = new Set(['question', 'inspect', 'edit', 'debug', 'test', 'refactor', 'docs']);
const PHASES = new Set(['intent', 'context', 'editing', 'verification', 'final']);
const VERIFICATION_STATUSES = new Set(['not_required', 'required', 'passed', 'failed']);
const LIFECYCLE_STATUSES = new Set(['running', 'paused', 'completed', 'failed', 'aborted']);
const TRIGGERS = new Set<CheckpointSaveTrigger>([
  'step_completed',
  'tool_failed',
  'verification_started',
  'verification_failed',
  'compaction',
  'final_draft',
  'manual',
]);

type LegacyVerificationStatus = 'not_required' | 'required' | 'passed' | 'failed';

interface LegacyTaskStateSnapshot extends TaskStateSnapshot {
  verificationRequired: boolean;
  verificationStatus: LegacyVerificationStatus;
}

export type LegacyCheckpointSourceKind =
  | 'combined'
  | 'persisted-runtime'
  | 'session-notes'
  | 'intent-archive'
  | 'unknown';

/**
 * All context is already-loaded data. The adapter never reads the filesystem.
 * Supplying timestamps is optional; source timestamps and then the Unix epoch are used
 * so adapting the same payload remains byte-for-byte stable.
 */
export interface LegacyCheckpointAdapterContext {
  projectId?: string;
  sessionId?: string;
  checkpointId?: string;
  workspaceRoot?: string;
  messages?: readonly UnifiedMessage[];
  sessionNotes?: string | null;
  memoryPayload?: Record<string, unknown>;
  operationOutcomes?: readonly OperationOutcome[];
  capturedAt?: string;
  migratedAt?: string;
}

interface ExtractedLegacy {
  kind: LegacyCheckpointSourceKind;
  sourceVersion: 1 | 2;
  task: LegacyTaskStateSnapshot;
  repo: RepoContextSnapshot;
  loop: LoopState;
  lifecycle?: string;
  acceptance?: AcceptanceGateSnapshot;
  verificationPending: boolean;
  currentStepId?: string;
  currentStepTitle?: string;
  lastCompletedStep?: string;
  nextSuggestedStep?: string;
  lastStopReason?: StopReason;
  trigger: CheckpointSaveTrigger;
  capturedAt: string;
  sessionId?: string;
  checkpointId?: string;
  workspaceRoot?: string;
  messages: UnifiedMessage[];
  sessionNotes?: string;
  memoryPayload?: Record<string, unknown>;
  explicitOutcomes: OperationOutcome[];
  resumable?: ProjectCheckpointV3['execution']['resumable'];
  extensions: Record<string, unknown>;
  warnings: string[];
}

type Resolution = 'passed' | 'failed' | 'pending' | 'none';

/**
 * Adapts TaskCheckpoint v1 + runtimeV2, PersistedRuntimeV1, session-note runtime
 * fences, and IntentCheckpointArchive payloads to ProjectCheckpointV3.
 */
export function adaptLegacyCheckpoint(
  input: unknown,
  context: LegacyCheckpointAdapterContext = {},
): ProjectCheckpointV3 {
  if (isProjectCheckpointV3(input)) return cloneProjectCheckpointV3(input);

  const sourceHash = legacyCheckpointSourceHash(input);
  const extracted = extractLegacy(input, context);
  const explicitOutcomes = mergeOutcomes(
    extracted.explicitOutcomes,
    sanitizeOutcomes(context.operationOutcomes, extracted.warnings),
  );
  const conditions: CompletionCondition[] = [];
  const syntheticOutcomes: OperationOutcome[] = [];

  const receiptResolution = resolutionFromReceipts(explicitOutcomes);
  const acceptanceResolution = resolutionFromAcceptance(extracted.acceptance);
  const lifecycleResolution = resolutionFromLifecycle(extracted.lifecycle);
  const verificationResolution = resolutionFromVerification(extracted.task, extracted.verificationPending);
  recordResolutionConflicts(extracted.warnings, [
    ['receipt', receiptResolution],
    ['acceptance', acceptanceResolution],
    ['lifecycle', lifecycleResolution],
    ['verification', verificationResolution],
  ]);
  const resolution = receiptResolution
    ?? acceptanceResolution
    ?? lifecycleResolution
    ?? verificationResolution;

  if (extracted.acceptance?.active && extracted.acceptance.commands.length > 0) {
    for (const command of extracted.acceptance.commands) {
      const key = nonEmptyString(command.key) ?? stableTextKey(nonEmptyString(command.label) ?? 'unknown');
      const label = nonEmptyString(command.label) ?? key;
      const status = command.status === 'passed'
        ? 'satisfied'
        : command.status === 'failed'
          ? 'failed'
          : 'pending';
      let evidenceRefs = validStrings(command.evidenceRefs);
      if (status === 'satisfied' && !hasCompletedEvidence(evidenceRefs, explicitOutcomes)) {
        const outcome = syntheticOutcome(sourceHash, `acceptance:${key}`, 'completed', extracted.capturedAt);
        syntheticOutcomes.push(outcome);
        evidenceRefs = [outcome.toolCallId];
      }
      conditions.push({
        id: `acceptance:${key}`,
        label,
        required: true,
        status,
        source: 'user',
        sourceRef: `acceptance:${key}`,
        evidenceRefs,
      });
    }
  }

  const resolutionOutcome = outcomeForResolution(
    resolution,
    sourceHash,
    extracted.capturedAt,
    explicitOutcomes,
    syntheticOutcomes,
  );
  const verificationEvidence = resolutionOutcome?.status === 'completed'
    ? [resolutionOutcome.toolCallId]
    : [];
  if (resolution !== 'none') {
    conditions.push({
      id: `legacy:verification:${sourceHash.slice(0, 16)}`,
      label: 'Legacy verification state',
      // A compatibility mirror is never promoted to a hard condition. Explicit
      // acceptance commands above are the only legacy source that can require it.
      required: false,
      status: resolution === 'passed'
        ? 'satisfied'
        : resolution === 'failed'
          ? 'failed'
          : 'pending',
      source: 'runtime',
      sourceRef: 'legacy:verification',
      evidenceRefs: verificationEvidence,
    });
  }

  const capturedAt = validIso(context.capturedAt)
    ?? extracted.capturedAt;
  const migratedAt = validIso(context.migratedAt)
    ?? capturedAt;
  const shortHash = sourceHash.slice(0, 20);

  const built: ProjectCheckpointV3 = {
    version: PROJECT_CHECKPOINT_VERSION,
    identity: {
      checkpointId: nonEmptyString(context.checkpointId)
        ?? extracted.checkpointId
        ?? `legacy-${shortHash}`,
      projectId: nonEmptyString(context.projectId) ?? `legacy-project-${shortHash}`,
      sessionId: nonEmptyString(context.sessionId)
        ?? extracted.sessionId
        ?? `legacy-session-${shortHash}`,
    },
    execution: {
      taskState: toProjectTaskState(extracted.task),
      loopState: extracted.loop,
      ...(extracted.currentStepId ? { currentStepId: extracted.currentStepId } : {}),
      ...(extracted.currentStepTitle ? { currentStepTitle: extracted.currentStepTitle } : {}),
      ...(extracted.lastStopReason ? { lastStopReason: extracted.lastStopReason } : {}),
      ...(extracted.resumable ? { resumable: extracted.resumable } : {}),
    },
    completion: {
      conditions: dedupeConditions(conditions),
      operationOutcomes: mergeOutcomes(explicitOutcomes, syntheticOutcomes),
    },
    conversation: {
      messages: cloneMessages(context.messages ?? extracted.messages),
    },
    workspace: {
      root: context.workspaceRoot ?? extracted.workspaceRoot ?? '',
      repoContext: extracted.repo,
    },
    memory: {
      ...(context.sessionNotes != null
        ? { sessionNotes: context.sessionNotes }
        : extracted.sessionNotes !== undefined
          ? { sessionNotes: extracted.sessionNotes }
          : {}),
      ...(context.memoryPayload
        ? { payload: cloneJsonRecord(context.memoryPayload, extracted.warnings, 'context.memoryPayload') }
        : extracted.memoryPayload
          ? { payload: extracted.memoryPayload }
          : {}),
    },
    snapshotMeta: {
      capturedAt,
      trigger: extracted.trigger,
      producer: 'legacy-checkpoint-adapter',
    },
    extensions: {
      ...extracted.extensions,
      legacySource: {
        kind: extracted.kind,
        hash: sourceHash,
        ...(extracted.lastCompletedStep ? { lastCompletedStep: extracted.lastCompletedStep } : {}),
        ...(extracted.nextSuggestedStep ? { nextSuggestedStep: extracted.nextSuggestedStep } : {}),
      },
    },
    migration: {
      sourceVersion: extracted.sourceVersion,
      targetVersion: PROJECT_CHECKPOINT_VERSION,
      migratedAt,
      warnings: [...new Set(extracted.warnings)].sort(),
    },
  };
  return finalizeAdaptedCheckpoint(built);
}

/** Store-friendly explicit entry point for a combined v1/v2 object. */
export function adaptCombinedCheckpoint(
  combined: unknown,
  context: LegacyCheckpointAdapterContext = {},
): ProjectCheckpointV3 {
  return adaptLegacyCheckpoint(combined, context);
}

/** Alias for callers that emphasize the unknown-input boundary. */
export const adaptLegacyCheckpointPayload = adaptLegacyCheckpoint;

/** Stable digest for store deduplication; independent of object key insertion order. */
export function legacyCheckpointSourceHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function extractLegacy(input: unknown, context: LegacyCheckpointAdapterContext): ExtractedLegacy {
  const warnings: string[] = [];
  let kind: LegacyCheckpointSourceKind = 'unknown';
  let root = asRecord(input);
  let sessionNotes = context.sessionNotes ?? undefined;
  let messages = cloneMessages(context.messages ?? []);
  let sessionId: string | undefined;
  let checkpointId: string | undefined;
  let workspaceRoot = context.workspaceRoot;
  let capturedAt = validIso(context.capturedAt) ?? EPOCH;

  if (typeof input === 'string') {
    kind = 'session-notes';
    sessionNotes = input;
    root = parseLastRuntimeFence(input, warnings);
  } else if (root && isIntentArchive(root)) {
    kind = 'intent-archive';
    sessionId = nonEmptyString(root.sessionId);
    checkpointId = nonEmptyString(root.messageId);
    workspaceRoot = nonEmptyString(root.workspaceRoot) ?? workspaceRoot;
    capturedAt = validIso(root.createdAt) ?? capturedAt;
    messages = sanitizeMessages(root.structuredMessages, warnings);
    sessionNotes = typeof root.sessionNotesContent === 'string' ? root.sessionNotesContent : sessionNotes;
    const notesRuntime = typeof sessionNotes === 'string'
      ? parseLastRuntimeFence(sessionNotes, warnings)
      : null;
    root = asRecord(root.combinedCheckpoint) ?? notesRuntime ?? root;
  }

  if (root && looksCombined(root)) {
    if (kind === 'unknown') kind = 'combined';
    const runtime = asRecord(root.runtimeV2);
    const sourceVersion: 1 | 2 = runtime?.runtimeVersion === 2 ? 2 : 1;
    const task = sanitizeTask(root.taskState, warnings);
    const repo = sanitizeRepo(root.repoContext, warnings);
    capturedAt = validIso(root.updatedAt) ?? validIso(root.createdAt) ?? capturedAt;
    checkpointId = nonEmptyString(root.taskId) ?? checkpointId;
    return {
      kind,
      sourceVersion,
      task,
      repo,
      loop: sanitizeLoop(root.loop, capturedAt, warnings),
      lifecycle: nonEmptyString(root.status),
      acceptance: sanitizeAcceptance(runtime?.acceptanceGate, warnings),
      verificationPending: runtime?.verificationPending === true,
      currentStepId: nonEmptyString(runtime?.currentStepId),
      currentStepTitle: nonEmptyString(runtime?.currentStepTitle),
      lastCompletedStep: nonEmptyString(root.lastCompletedStep),
      nextSuggestedStep: nonEmptyString(root.nextSuggestedStep),
      lastStopReason: asStopReason(runtime?.lastStopReason ?? root.stopReason),
      trigger: asTrigger(runtime?.lastTrigger),
      capturedAt: validIso(runtime?.v2UpdatedAt) ?? capturedAt,
      sessionId,
      checkpointId,
      workspaceRoot,
      messages,
      sessionNotes,
      memoryPayload: sanitizeOptionalJsonRecord(root.memoryPayload, warnings, 'memoryPayload'),
      explicitOutcomes: extractOutcomes(root, warnings),
      resumable: extractLegacyResumable(root, runtime),
      extensions: extractLegacyExtensions(root, runtime, warnings),
      warnings,
    };
  }

  if (root && looksPersistedRuntime(root)) {
    if (kind === 'unknown') kind = 'persisted-runtime';
    return {
      kind,
      sourceVersion: 1,
      task: sanitizeTask(root.task, warnings),
      repo: sanitizeRepo(root.repo, warnings),
      loop: emptyLoop(capturedAt),
      verificationPending: false,
      trigger: 'manual',
      capturedAt,
      sessionId,
      checkpointId,
      workspaceRoot,
      messages,
      sessionNotes,
      explicitOutcomes: extractOutcomes(root, warnings),
      extensions: extractLegacyExtensions(root, null, warnings, new Set(['version', 'task', 'repo'])),
      warnings,
    };
  }

  warnings.push('Unrecognized legacy payload; conservative empty runtime was used.');
  return {
    kind,
    sourceVersion: 1,
    task: emptyTask(),
    repo: emptyRepo(),
    loop: emptyLoop(capturedAt),
    verificationPending: false,
    trigger: 'manual',
    capturedAt,
    sessionId,
    checkpointId,
    workspaceRoot,
    messages,
    sessionNotes,
    explicitOutcomes: root ? extractOutcomes(root, warnings) : [],
    extensions: root
      ? extractLegacyExtensions(root, null, warnings, new Set(['version', 'task', 'repo']))
      : {},
    warnings,
  };
}

const LEGACY_COMBINED_KEYS = new Set([
  'version',
  'taskId',
  'status',
  'userGoal',
  'phase',
  'lastCompletedStep',
  'nextSuggestedStep',
  'taskState',
  'repoContext',
  'failedToolCalls',
  'stopReason',
  'messageCount',
  'loop',
  'createdAt',
  'updatedAt',
  'runtimeV2',
  'completion',
  'operationOutcomes',
  'memoryPayload',
  'extensions',
  'taskGraph',
  'graphMetrics',
  'graphSession',
]);

const LEGACY_COMPLETION_KEYS = new Set([
  'verificationPending',
  'acceptanceGate',
  'verificationStatus',
  'verificationRequired',
]);

function extractLegacyResumable(
  root: Record<string, unknown>,
  runtime: Record<string, unknown> | null,
): ProjectCheckpointV3['execution']['resumable'] | undefined {
  const branchBudget = sanitizeBranchBudget(runtime?.branchBudget);
  const failedToolCallSignatures = sanitizeCountRecord(root.failedToolCallSignatures);
  if (!branchBudget && !failedToolCallSignatures) return undefined;
  return {
    ...(branchBudget ? { branchBudget } : {}),
    ...(failedToolCallSignatures ? { failedToolCallSignatures } : {}),
  };
}

function extractLegacyExtensions(
  root: Record<string, unknown>,
  runtime: Record<string, unknown> | null,
  warnings: string[],
  knownKeys: ReadonlySet<string> = LEGACY_COMBINED_KEYS,
): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  const embedded = cloneSafeJsonRecord(root.extensions);
  if (embedded) Object.assign(extensions, embedded);

  for (const key of ['taskGraph', 'graphMetrics', 'graphSession'] as const) {
    const value = cloneSafeJsonValue(root[key]);
    if (value !== undefined) extensions[key] = value;
  }

  if (runtime) {
    const durable = cloneSafeJsonRecord(runtime);
    if (durable) {
      for (const key of LEGACY_COMPLETION_KEYS) delete durable[key];
      if (Object.keys(durable).length > 0) extensions.runtimeResilience = durable;
    } else {
      warnings.push('Legacy runtimeV2 was not JSON-safe and was discarded.');
    }
  }

  const unknown: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(root)) {
    if (knownKeys.has(key) || LEGACY_COMPLETION_KEYS.has(key)) continue;
    const value = cloneSafeJsonValue(raw);
    if (value !== undefined) unknown[key] = value;
  }
  if (Object.keys(unknown).length > 0) extensions.legacyUnknown = unknown;

  const legacyApi: Record<string, unknown> = {};
  for (const key of ['status', 'userGoal', 'failedToolCalls', 'createdAt', 'updatedAt']) {
    const value = cloneSafeJsonValue(root[key]);
    if (value !== undefined) legacyApi[key] = value;
  }
  if (Object.keys(legacyApi).length > 0) extensions.legacyApi = legacyApi;
  return extensions;
}

function sanitizeBranchBudget(
  value: unknown,
): NonNullable<ProjectCheckpointV3['execution']['resumable']>['branchBudget'] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const fileEdits = sanitizeCountRecord(record.fileEdits);
  const commandRetries = sanitizeCountRecord(record.commandRetries);
  const errorRepeats = sanitizeCountRecord(record.errorRepeats);
  if (!fileEdits || !commandRetries || !errorRepeats) return undefined;
  if (!Number.isInteger(record.recoverTriggers) || Number(record.recoverTriggers) < 0) return undefined;
  return {
    fileEdits,
    commandRetries,
    errorRepeats,
    recoverTriggers: Number(record.recoverTriggers),
    ...(validStrings(record.writeBypassPaths).length > 0
      ? { writeBypassPaths: validStrings(record.writeBypassPaths) }
      : {}),
    ...(validStrings(record.commandRetryBypassKeys).length > 0
      ? { commandRetryBypassKeys: validStrings(record.commandRetryBypassKeys) }
      : {}),
  };
}

function sanitizeCountRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record);
  if (!entries.every(([, count]) => Number.isInteger(count) && Number(count) >= 0)) return undefined;
  return Object.fromEntries(entries) as Record<string, number>;
}

function cloneSafeJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const cloned = cloneSafeJsonValue(value);
  return asRecord(cloned) ?? undefined;
}

function cloneSafeJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const cloned = cloneSafeJsonValue(item, seen);
      if (cloned === undefined) {
        seen.delete(value);
        return undefined;
      }
      result.push(cloned);
    }
    seen.delete(value);
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    seen.delete(value);
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (LEGACY_COMPLETION_KEYS.has(key)) continue;
    const cloned = cloneSafeJsonValue(item, seen);
    if (cloned === undefined) {
      seen.delete(value);
      return undefined;
    }
    result[key] = cloned;
  }
  seen.delete(value);
  return result;
}

function resolutionFromReceipts(outcomes: readonly OperationOutcome[]): Resolution | undefined {
  const receipted = outcomes
    .filter(outcome => outcome.receipt !== undefined)
    .sort((a, b) => b.at - a.at || a.toolCallId.localeCompare(b.toolCallId));
  if (receipted.length === 0) return undefined;
  const latest = receipted[0];
  if (latest.status === 'completed') return 'passed';
  if (latest.status === 'failed') return 'failed';
  return 'pending';
}

function resolutionFromAcceptance(acceptance: AcceptanceGateSnapshot | undefined): Resolution | undefined {
  if (!acceptance?.active || acceptance.commands.length === 0) return undefined;
  if (acceptance.commands.some(command => command.status === 'failed')) return 'failed';
  if (acceptance.commands.some(command => command.status === 'pending')) return 'pending';
  return 'passed';
}

function resolutionFromLifecycle(status: string | undefined): Resolution | undefined {
  if (!status || !LIFECYCLE_STATUSES.has(status)) return undefined;
  if (status === 'completed') return 'passed';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function resolutionFromVerification(
  task: LegacyTaskStateSnapshot,
  verificationPending: boolean,
): Resolution {
  if (task.verificationStatus === 'passed') return 'passed';
  if (task.verificationStatus === 'failed') return 'failed';
  if (
    task.verificationStatus === 'required'
    || task.verificationRequired
    || verificationPending
  ) return 'pending';
  return 'none';
}

function recordResolutionConflicts(
  warnings: string[],
  signals: ReadonlyArray<readonly [string, Resolution | undefined]>,
): void {
  const meaningful = signals.filter(
    (signal): signal is readonly [string, Resolution] =>
      signal[1] !== undefined && signal[1] !== 'none',
  );
  if (meaningful.length < 2) return;
  const [winnerName, winnerResolution] = meaningful[0];
  const conflicts = meaningful.slice(1).filter(([, resolution]) => resolution !== winnerResolution);
  if (conflicts.length > 0) {
    warnings.push(
      `Conflicting legacy completion signals resolved as ${winnerName}:${winnerResolution}; `
      + `ignored ${conflicts.map(([name, resolution]) => `${name}:${resolution}`).join(', ')}.`,
    );
  }
}

function outcomeForResolution(
  resolution: Resolution,
  sourceHash: string,
  atIso: string,
  explicit: readonly OperationOutcome[],
  synthetic: OperationOutcome[],
): OperationOutcome | undefined {
  const receiptMatch = explicit
    .filter(outcome => outcome.receipt !== undefined)
    .sort((a, b) => b.at - a.at)[0];
  if (receiptMatch) return receiptMatch;
  if (resolution !== 'passed' && resolution !== 'failed') return undefined;
  const outcome = syntheticOutcome(
    sourceHash,
    'verification',
    resolution === 'passed' ? 'completed' : 'failed',
    atIso,
  );
  synthetic.push(outcome);
  return outcome;
}

function syntheticOutcome(
  sourceHash: string,
  discriminator: string,
  status: 'completed' | 'failed',
  atIso: string,
): OperationOutcome {
  const suffix = createHash('sha256').update(`${sourceHash}:${discriminator}`).digest('hex').slice(0, 20);
  return {
    toolCallId: `legacy:${suffix}`,
    toolName: 'legacy:verification',
    status,
    effect: 'observe',
    risk: 'low',
    disposition: status === 'completed' ? 'executed' : 'execution_fail',
    scope: `legacy:verification:${stableTextKey(discriminator)}`,
    ...(status === 'failed' ? { error: 'Legacy checkpoint records verification failure.' } : {}),
    at: Date.parse(atIso),
    legacySynthetic: true,
  };
}

function sanitizeTask(value: unknown, warnings: string[]): LegacyTaskStateSnapshot {
  const record = asRecord(value);
  if (!record) {
    warnings.push('Missing task snapshot; conservative empty task was used.');
    return emptyTask();
  }
  const intent = typeof record.intent === 'string' && INTENTS.has(record.intent)
    ? record.intent as TaskStateSnapshot['intent']
    : 'inspect';
  const phase = typeof record.phase === 'string' && PHASES.has(record.phase)
    ? record.phase as TaskStateSnapshot['phase']
    : 'context';
  const verificationStatus = typeof record.verificationStatus === 'string'
    && VERIFICATION_STATUSES.has(record.verificationStatus)
    ? record.verificationStatus as LegacyVerificationStatus
    : record.verificationRequired === true ? 'required' : 'not_required';
  if (intent !== record.intent) warnings.push('Invalid task intent was downgraded to inspect.');
  if (phase !== record.phase) warnings.push('Invalid task phase was downgraded to context.');
  if (verificationStatus !== record.verificationStatus) {
    warnings.push('Invalid verification status was conservatively normalized.');
  }
  warnInvalidStringArray(record.filesRead, 'task.filesRead', warnings);
  warnInvalidStringArray(record.filesChanged, 'task.filesChanged', warnings);
  warnInvalidStringArray(record.commandsRun, 'task.commandsRun', warnings);
  return {
    goal: typeof record.goal === 'string' ? record.goal : '',
    intent,
    phase,
    filesRead: validStrings(record.filesRead),
    filesChanged: validStrings(record.filesChanged),
    commandsRun: validStrings(record.commandsRun),
    verificationRequired: record.verificationRequired === true,
    verificationStatus,
    ...optionalNumberRecord('fileDeliverableWriteVersions', record),
    ...optionalNumberRecord('fileDeliverableConfirmVersions', record),
  };
}

function sanitizeRepo(value: unknown, warnings: string[]): RepoContextSnapshot {
  const record = asRecord(value);
  if (!record) {
    warnings.push('Missing repo snapshot; conservative empty repo context was used.');
    return emptyRepo();
  }
  for (const key of [
    'filesRead',
    'filesChanged',
    'commandsRun',
    'testCommands',
    'recentDiagnostics',
  ]) {
    warnInvalidStringArray(record[key], `repo.${key}`, warnings);
  }
  return {
    filesRead: validStrings(record.filesRead),
    filesChanged: validStrings(record.filesChanged),
    commandsRun: validStrings(record.commandsRun),
    testCommands: validStrings(record.testCommands),
    recentDiagnostics: validStrings(record.recentDiagnostics),
  };
}

function sanitizeLoop(value: unknown, capturedAt: string, warnings: string[]): LoopState {
  const record = asRecord(value);
  if (!record) {
    warnings.push('Missing loop snapshot; zero counters were used.');
    return emptyLoop(capturedAt);
  }
  const number = (key: string): number => {
    const candidate = record[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  };
  return {
    currentRound: number('currentRound'),
    totalInputTokens: number('totalInputTokens'),
    totalOutputTokens: number('totalOutputTokens'),
    lastInputTokens: number('lastInputTokens'),
    lastOutputTokens: number('lastOutputTokens'),
    totalToolCalls: number('totalToolCalls'),
    startTime: number('startTime') || Date.parse(capturedAt),
    ...(asStopReason(record.stopReason) ? { stopReason: asStopReason(record.stopReason) } : {}),
  };
}

function sanitizeAcceptance(value: unknown, warnings: string[]): AcceptanceGateSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (!Array.isArray(record.commands)) {
    warnings.push('Malformed acceptance gate was ignored.');
    return undefined;
  }
  const commands = record.commands.flatMap(raw => {
    const command = asRecord(raw);
    if (!command) return [];
    const key = nonEmptyString(command.key);
    const label = nonEmptyString(command.label);
    if (!key && !label) {
      warnings.push('Acceptance command without key or label was ignored.');
      return [];
    }
    const status: 'pending' | 'passed' | 'failed' = command.status === 'passed' || command.status === 'failed'
      ? command.status
      : 'pending';
    if (status !== command.status) {
      warnings.push('Invalid acceptance status was downgraded to pending.');
    }
    return [{
      key: key ?? stableTextKey(label!),
      label: label ?? key!,
      status,
      ...(typeof command.lastRunAt === 'number' && Number.isFinite(command.lastRunAt)
        ? { lastRunAt: command.lastRunAt }
        : {}),
      ...(validStrings(command.evidenceRefs).length > 0
        ? { evidenceRefs: validStrings(command.evidenceRefs) }
        : {}),
    }];
  });
  return { active: record.active === true, commands };
}

function extractOutcomes(root: Record<string, unknown>, warnings: string[]): OperationOutcome[] {
  const completion = asRecord(root.completion);
  return sanitizeOutcomes(completion?.operationOutcomes ?? root.operationOutcomes, warnings);
}

function sanitizeOutcomes(
  value: unknown,
  warnings: string[],
): OperationOutcome[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push('Malformed operation outcomes were ignored.');
    return [];
  }
  return value.flatMap(raw => {
    const outcome = asRecord(raw);
    if (
      !outcome
      || !nonEmptyString(outcome.toolCallId)
      || !nonEmptyString(outcome.toolName)
      || !['completed', 'pending', 'failed', 'awaiting_approval'].includes(String(outcome.status))
      || !['observe', 'local_change', 'external_change', 'execute'].includes(String(outcome.effect))
      || !['low', 'high'].includes(String(outcome.risk))
      || !['executed', 'execution_fail', 'policy_block', 'user_denied'].includes(String(outcome.disposition))
      || typeof outcome.scope !== 'string'
      || typeof outcome.at !== 'number'
      || !Number.isFinite(outcome.at)
    ) {
      warnings.push('Malformed operation outcome entry was ignored.');
      return [];
    }
    const receipt = sanitizeReceipt(outcome.receipt);
    return [{
      toolCallId: outcome.toolCallId as string,
      toolName: outcome.toolName as string,
      status: outcome.status as OperationOutcome['status'],
      effect: outcome.effect as OperationOutcome['effect'],
      risk: outcome.risk as OperationOutcome['risk'],
      disposition: outcome.disposition as OperationOutcome['disposition'],
      scope: outcome.scope,
      ...(receipt ? { receipt } : {}),
      ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}),
      at: outcome.at,
      ...(['reversible', 'compensatable', 'irreversible'].includes(String(outcome.reversibility))
        ? { reversibility: outcome.reversibility as OperationOutcome['reversibility'] }
        : {}),
      ...(typeof outcome.legacySynthetic === 'boolean'
        ? { legacySynthetic: outcome.legacySynthetic }
        : {}),
    }];
  });
}

function sanitizeReceipt(value: unknown): OperationOutcome['receipt'] {
  const receipt = asRecord(value);
  if (!receipt) return undefined;
  const result = {
    ...(typeof receipt.operationId === 'string' ? { operationId: receipt.operationId } : {}),
    ...(typeof receipt.target === 'string' ? { target: receipt.target } : {}),
    ...(typeof receipt.exitCode === 'number' && Number.isFinite(receipt.exitCode)
      ? { exitCode: receipt.exitCode }
      : {}),
    ...(typeof receipt.version === 'string' ? { version: receipt.version } : {}),
    ...(typeof receipt.summary === 'string' ? { summary: receipt.summary } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseLastRuntimeFence(notes: string, warnings: string[]): Record<string, unknown> | null {
  const marker = '```icecoder-runtime';
  const startMarker = notes.lastIndexOf(marker);
  if (startMarker < 0) {
    warnings.push('Session notes contain no icecoder-runtime payload.');
    return null;
  }
  const start = startMarker + marker.length;
  const end = notes.indexOf('```', start);
  if (end < 0) {
    warnings.push('Session runtime fence is not closed.');
    return null;
  }
  try {
    const parsed = JSON.parse(notes.slice(start, end).trim()) as unknown;
    const record = asRecord(parsed);
    if (!record) warnings.push('Session runtime payload is not an object.');
    return record;
  } catch {
    warnings.push('Session runtime payload contains invalid JSON.');
    return null;
  }
}

function sanitizeMessages(value: unknown, warnings: string[]): UnifiedMessage[] {
  if (!Array.isArray(value)) {
    warnings.push('Malformed structured messages were ignored.');
    return [];
  }
  const messages = value.flatMap(raw => {
    const normalized = coercePersistableMessage(raw);
    return normalized ? [normalized] : [];
  });
  if (messages.length !== value.length) warnings.push('Malformed structured message entries were ignored.');
  return messages;
}

function coercePersistableMessage(value: unknown): UnifiedMessage | null {
  const record = asRecord(value);
  if (!record) return null;
  const toolCalls = Array.isArray(record.toolCalls)
    ? record.toolCalls.map(call => {
      const item = asRecord(call);
      if (!item) return call;
      if (typeof item.arguments === 'string') {
        const parsed = asRecord(tryParseJson(item.arguments));
        return parsed ? { ...item, arguments: parsed } : item;
      }
      return item;
    })
    : record.toolCalls;
  const candidate = toolCalls === record.toolCalls ? record : { ...record, toolCalls };
  return isPersistableCheckpointMessage(candidate) ? structuredClone(candidate) : null;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function finalizeAdaptedCheckpoint(built: ProjectCheckpointV3): ProjectCheckpointV3 {
  const withSafeMessages = {
    ...built,
    conversation: {
      ...built.conversation,
      messages: built.conversation.messages.filter(isPersistableCheckpointMessage),
    },
  };
  const clonedSafe = tryCloneProjectCheckpoint(withSafeMessages);
  if (clonedSafe) return clonedSafe;
  const withoutMessages = {
    ...withSafeMessages,
    conversation: { messages: [] as UnifiedMessage[] },
  };
  const clonedWithoutMessages = tryCloneProjectCheckpoint(withoutMessages);
  if (clonedWithoutMessages) return clonedWithoutMessages;
  return cloneProjectCheckpointV3({
    ...withoutMessages,
    completion: { conditions: [], operationOutcomes: [] },
    extensions: {
      legacySource: asRecord(withoutMessages.extensions.legacySource) ?? {
        kind: 'unknown',
        hash: legacyCheckpointSourceHash(built),
      },
    },
  });
}

function tryCloneProjectCheckpoint(value: unknown): ProjectCheckpointV3 | null {
  return isProjectCheckpointV3(value) ? cloneProjectCheckpointV3(value) : null;
}

function cloneMessages(messages: readonly UnifiedMessage[]): UnifiedMessage[] {
  return messages.map(message => structuredClone(message));
}

function hasCompletedEvidence(refs: readonly string[], outcomes: readonly OperationOutcome[]): boolean {
  return refs.some(ref => outcomes.some(outcome =>
    outcome.toolCallId === ref && outcome.status === 'completed',
  ));
}

function mergeOutcomes(
  first: readonly OperationOutcome[],
  second: readonly OperationOutcome[],
): OperationOutcome[] {
  const merged = new Map<string, OperationOutcome>();
  for (const outcome of [...first, ...second]) merged.set(outcome.toolCallId, structuredClone(outcome));
  return [...merged.values()].sort((a, b) => a.at - b.at || a.toolCallId.localeCompare(b.toolCallId));
}

function dedupeConditions(conditions: readonly CompletionCondition[]): CompletionCondition[] {
  const merged = new Map<string, CompletionCondition>();
  for (const condition of conditions) merged.set(condition.id, structuredClone(condition));
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function isIntentArchive(value: Record<string, unknown>): boolean {
  return value.version === 1
    && typeof value.messageId === 'string'
    && (
      'combinedCheckpoint' in value
      || 'projectCheckpoint' in value
      || Array.isArray(value.uiMessages)
      || Array.isArray(value.structuredMessages)
    );
}

function looksCombined(value: Record<string, unknown>): boolean {
  return 'taskState' in value || 'runtimeV2' in value || 'status' in value;
}

function looksPersistedRuntime(value: Record<string, unknown>): boolean {
  return value.version === 1 && 'task' in value && 'repo' in value;
}

function emptyTask(): LegacyTaskStateSnapshot {
  return {
    goal: '',
    intent: 'inspect',
    phase: 'context',
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    verificationRequired: false,
    verificationStatus: 'not_required',
  };
}

function toProjectTaskState(
  task: LegacyTaskStateSnapshot,
): ProjectCheckpointV3['execution']['taskState'] {
  const {
    verificationRequired: _verificationRequired,
    verificationStatus: _verificationStatus,
    ...projectTask
  } = task;
  return projectTask;
}

function emptyRepo(): RepoContextSnapshot {
  return {
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    testCommands: [],
    recentDiagnostics: [],
  };
}

function emptyLoop(capturedAt: string): LoopState {
  return {
    currentRound: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0,
    totalToolCalls: 0,
    startTime: Date.parse(capturedAt),
  };
}

function optionalNumberRecord(
  key: 'fileDeliverableWriteVersions' | 'fileDeliverableConfirmVersions',
  source: Record<string, unknown>,
): Partial<LegacyTaskStateSnapshot> {
  const record = asRecord(source[key]);
  if (!record) return {};
  const entries = Object.entries(record).filter((entry): entry is [string, number] =>
    typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
  return entries.length > 0 ? { [key]: Object.fromEntries(entries) } : {};
}

function sanitizeOptionalJsonRecord(
  value: unknown,
  warnings: string[],
  label: string,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return cloneJsonRecord(record, warnings, label);
}

function cloneJsonRecord(
  value: Record<string, unknown>,
  warnings: string[],
  label: string,
): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    warnings.push(`${label} was not JSON-safe and was discarded.`);
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function validStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
}

function warnInvalidStringArray(value: unknown, label: string, warnings: string[]): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    warnings.push(`Invalid ${label} entries were discarded.`);
  }
}

function validIso(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}

function asTrigger(value: unknown): CheckpointSaveTrigger {
  return typeof value === 'string' && TRIGGERS.has(value as CheckpointSaveTrigger)
    ? value as CheckpointSaveTrigger
    : 'manual';
}

function asStopReason(value: unknown): StopReason | undefined {
  return typeof value === 'string' ? value as StopReason : undefined;
}

function stableTextKey(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : '"[non-finite]"';
  if (typeof value === 'bigint') return `"[bigint:${String(value)}]"`;
  if (typeof value === 'undefined') return '"[undefined]"';
  if (typeof value === 'function' || typeof value === 'symbol') return `"[${typeof value}]"`;
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map(item => canonicalJson(item, seen)).join(',')}]`
    : `{${Object.keys(value as object).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], seen)}`,
    ).join(',')}}`;
  seen.delete(value);
  return result;
}
