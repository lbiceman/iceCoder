import type { UnifiedMessage, ToolCall } from '../llm/types.js';
import type { LoopState, StopReason } from './types.js';
import type { TaskStateSnapshot, RepoContextSnapshot } from '../types/runtime-snapshot.js';
import { engineeringTestTargetPaths } from './document-deliverable.js';
import { checkpointHasPendingWork } from './incomplete-completion.js';
import { buildCheckpointResumeSummary, sanitizeCheckpointGoal } from './checkpoint-resume-compact.js';
import { redactToolCalls } from '../tools/tool-argument-redaction.js';
import {
  cloneProjectCheckpointV3,
  type ProjectCheckpointV3,
} from '../types/runtime-checkpoint.js';
import { ProjectCheckpointStore } from './project-checkpoint-store.js';
import { CompletionFactsView } from './completion-facts-view.js';
import type { CompletionCondition } from './completion-condition.js';
import type {
  CompletionGateReason,
  CompletionStatus,
} from './completion-gate.js';
import type { OperationOutcome } from './operation-outcome.js';
import type { BranchBudgetSnapshot } from '../types/runtime-checkpoint.js';
// ExecutionPlan type removed (Phase 11)

export type TaskCheckpointStatus = 'running' | 'paused' | 'completed' | 'failed' | 'aborted';

export interface TaskCheckpoint {
  version: 1;
  taskId: string;
  status: TaskCheckpointStatus;
  userGoal: string;
  phase: string;
  lastCompletedStep?: string;
  nextSuggestedStep?: string;
  taskState: TaskStateSnapshot;
  repoContext: RepoContextSnapshot;
  failedToolCalls: string[];
  stopReason?: StopReason;
  messageCount: number;
  loop: {
    currentRound: number;
    totalToolCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  createdAt: string;
  updatedAt: string;
  // plan field removed (Phase 11)
}

export interface TaskCheckpointUpdate {
  status: TaskCheckpointStatus;
  userGoal: string;
  taskState: TaskStateSnapshot;
  repoContext: RepoContextSnapshot;
  loopState: LoopState;
  messages: UnifiedMessage[];
  failedToolCalls?: string[];
  stopReason?: StopReason;
  completion?: {
    conditions: CompletionCondition[];
    operationOutcomes: OperationOutcome[];
    status?: CompletionStatus;
    reason?: CompletionGateReason;
    continuationCount: number;
    blockingSignature?: string;
  };
  resumableExecution?: {
    branchBudget?: BranchBudgetSnapshot;
    failedToolCallSignatures?: Record<string, number>;
  };
  // plan field removed (Phase 11)
}

export class TaskCheckpointManager {
  readonly checkpointPath: string;
  private readonly store: ProjectCheckpointStore;

  constructor(sessionDir: string, sessionId = 'default') {
    this.store = new ProjectCheckpointStore({ sessionDir, sessionId });
    this.checkpointPath = this.store.checkpointPath;
  }

  async loadProject(): Promise<ProjectCheckpointV3 | null> {
    return this.store.load();
  }

  toActiveCheckpoint(project: ProjectCheckpointV3): TaskCheckpoint | null {
    const checkpoint = projectToLegacyCheckpoint(project);
    if (checkpoint.status === 'failed') return null;
    if (checkpoint.status === 'completed') {
      if (!checkpointHasPendingWork(project)) return null;
      return { ...checkpoint, status: 'paused' };
    }
    return checkpoint;
  }

  async loadActive(): Promise<TaskCheckpoint | null> {
    const project = await this.store.load();
    return project ? this.toActiveCheckpoint(project) : null;
  }

  setPersistBlocked(blocked: boolean): void {
    this.store.setPersistBlocked(blocked);
  }

  async save(update: TaskCheckpointUpdate): Promise<TaskCheckpoint> {
    const existingProject = await this.store.load();
    const now = new Date().toISOString();
    const completionFacts = CompletionFactsView.fromCompletionSnapshot({
      conditions: update.completion?.conditions ?? existingProject?.completion.conditions ?? [],
      operationOutcomes: update.completion?.operationOutcomes
        ?? existingProject?.completion.operationOutcomes
        ?? [],
    });
    const view = toTaskCheckpointView(update, existingProject, now, completionFacts);
    const projectCheckpoint = buildNativeProjectCheckpoint(
      update,
      existingProject,
      view,
      this.store,
      now,
      completionFacts,
    );
    if (!this.store.isPersistBlocked()) {
      await this.store.save(projectCheckpoint);
    }
    return view;
  }

  // clearEmbeddedPlan removed (Phase 11 — execution plan layer deleted)

  buildResumeMessage(checkpoint: TaskCheckpoint): UnifiedMessage {
    return {
      role: 'user',
      content: buildCheckpointResumeSummary(checkpoint),
      preserveOnCompaction: true,
    };
  }

}

function toTaskCheckpointView(
  update: TaskCheckpointUpdate,
  existingProject: ProjectCheckpointV3 | null,
  now: string,
  completionFacts: CompletionFactsView,
): TaskCheckpoint {
  const existing = existingProject ? projectToLegacyCheckpoint(existingProject) : null;
  return {
    version: 1,
    taskId: existing?.taskId ?? createTaskId(update.userGoal, now),
    status: update.status,
    userGoal: update.userGoal,
    phase: update.taskState.phase,
    lastCompletedStep: inferLastCompletedStep(update.repoContext),
    nextSuggestedStep: inferNextSuggestedStep(
      update.taskState,
      update.repoContext,
      update.status,
      completionFacts,
    ),
    taskState: {
      ...update.taskState,
      goal: sanitizeCheckpointGoal(update.taskState.goal),
    },
    repoContext: update.repoContext,
    failedToolCalls: update.failedToolCalls ?? existing?.failedToolCalls ?? [],
    stopReason: update.stopReason,
    messageCount: update.messages.length,
    loop: {
      currentRound: update.loopState.currentRound,
      totalToolCalls: update.loopState.totalToolCalls,
      totalInputTokens: update.loopState.totalInputTokens,
      totalOutputTokens: update.loopState.totalOutputTokens,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function buildNativeProjectCheckpoint(
  update: TaskCheckpointUpdate,
  existingProject: ProjectCheckpointV3 | null,
  view: TaskCheckpoint,
  store: ProjectCheckpointStore,
  now: string,
  completionFacts: CompletionFactsView,
): ProjectCheckpointV3 {
  const loopState = completeLoopState(update.loopState, update.stopReason);
  const completion = update.completion
    ? structuredClone(update.completion)
    : existingProject
      ? structuredClone(existingProject.completion)
      : {
        conditions: completionFacts.conditionSnapshot(),
        operationOutcomes: [],
      };
  const resumable = update.resumableExecution
    ? structuredClone(update.resumableExecution)
    : existingProject?.execution.resumable
      ? structuredClone(existingProject.execution.resumable)
      : undefined;
  const extensions = {
    ...(existingProject ? structuredClone(existingProject.extensions) : {}),
    legacyApi: {
      status: view.status,
      userGoal: view.userGoal,
      failedToolCalls: view.failedToolCalls,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    },
  };
  const project: ProjectCheckpointV3 = {
    version: 3,
    identity: {
      checkpointId: view.taskId,
      projectId: existingProject?.identity.projectId ?? store.projectId,
      sessionId: store.sessionId,
    },
    execution: {
      taskState: structuredClone(view.taskState),
      loopState,
      ...(update.stopReason !== undefined
        ? { lastStopReason: update.stopReason }
        : existingProject?.execution.lastStopReason !== undefined
          ? { lastStopReason: existingProject.execution.lastStopReason }
          : {}),
      ...(existingProject?.execution.currentStepId
        ? { currentStepId: existingProject.execution.currentStepId }
        : {}),
      ...(existingProject?.execution.currentStepTitle
        ? { currentStepTitle: existingProject.execution.currentStepTitle }
        : {}),
      ...(resumable ? { resumable } : {}),
    },
    completion,
    conversation: {
      messages: structuredClone(update.messages),
      ...(existingProject?.conversation.summary
        ? { summary: existingProject.conversation.summary }
        : {}),
    },
    workspace: {
      root: existingProject?.workspace.root ?? store.projectId,
      repoContext: structuredClone(update.repoContext),
    },
    memory: existingProject ? structuredClone(existingProject.memory) : {},
    snapshotMeta: {
      capturedAt: now,
      trigger: 'manual',
      sequence: existingProject?.snapshotMeta.sequence,
      parentGeneration: existingProject?.snapshotMeta.parentGeneration,
      producer: 'task-checkpoint-manager',
      runId: view.taskId,
      roundId: `${view.taskId}:round:${loopState.currentRound}`,
      conversationCursor: update.messages.length,
      captureReason: update.stopReason ?? update.status,
      ...(existingProject?.snapshotMeta.workspaceBaseline
        ? { workspaceBaseline: existingProject.snapshotMeta.workspaceBaseline }
        : {}),
    },
    extensions,
    migration: null,
  };
  return cloneProjectCheckpointV3(project);
}

function completeLoopState(loop: LoopState, stopReason?: StopReason): LoopState {
  return {
    ...loop,
    currentRound: loop.currentRound,
    totalInputTokens: loop.totalInputTokens,
    totalOutputTokens: loop.totalOutputTokens,
    lastInputTokens: Number.isFinite(loop.lastInputTokens) ? loop.lastInputTokens : 0,
    lastOutputTokens: Number.isFinite(loop.lastOutputTokens) ? loop.lastOutputTokens : 0,
    totalToolCalls: loop.totalToolCalls,
    startTime: Number.isFinite(loop.startTime) ? loop.startTime : Date.now(),
    ...(stopReason !== undefined
      ? { stopReason }
      : loop.stopReason !== undefined ? { stopReason: loop.stopReason } : {}),
  };
}

function projectToLegacyCheckpoint(checkpoint: ProjectCheckpointV3): TaskCheckpoint {
  const compat = checkpoint.extensions.legacyApi;
  const legacy = compat !== null && typeof compat === 'object' && !Array.isArray(compat)
    ? compat as Record<string, unknown>
    : {};
  const source = checkpoint.extensions.legacySource;
  const legacySource = source !== null && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, unknown>
    : {};
  const capturedAt = checkpoint.snapshotMeta.capturedAt;
  return {
    version: 1,
    taskId: checkpoint.identity.checkpointId,
    status: isTaskCheckpointStatus(legacy.status) ? legacy.status : 'paused',
    userGoal: typeof legacy.userGoal === 'string' ? legacy.userGoal : checkpoint.execution.taskState.goal,
    phase: checkpoint.execution.taskState.phase,
    lastCompletedStep: typeof legacySource.lastCompletedStep === 'string'
      ? legacySource.lastCompletedStep
      : undefined,
    nextSuggestedStep: typeof legacySource.nextSuggestedStep === 'string'
      ? legacySource.nextSuggestedStep
      : undefined,
    taskState: { ...checkpoint.execution.taskState },
    repoContext: checkpoint.workspace.repoContext,
    failedToolCalls: Array.isArray(legacy.failedToolCalls)
      ? legacy.failedToolCalls.filter((value): value is string => typeof value === 'string')
      : [],
    stopReason: checkpoint.execution.lastStopReason,
    messageCount: checkpoint.conversation.messages.length,
    loop: {
      currentRound: checkpoint.execution.loopState.currentRound,
      totalToolCalls: checkpoint.execution.loopState.totalToolCalls,
      totalInputTokens: checkpoint.execution.loopState.totalInputTokens,
      totalOutputTokens: checkpoint.execution.loopState.totalOutputTokens,
    },
    createdAt: typeof legacy.createdAt === 'string' ? legacy.createdAt : capturedAt,
    updatedAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : capturedAt,
  };
}

function isTaskCheckpointStatus(value: unknown): value is TaskCheckpointStatus {
  return ['running', 'paused', 'completed', 'failed', 'aborted'].includes(String(value));
}

export function summarizeToolCalls(toolCalls: ToolCall[] | undefined): string[] {
  if (!toolCalls?.length) return [];
  return (redactToolCalls(toolCalls) ?? [])
    .map(tc => `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`);
}

function createTaskId(userGoal: string, isoTimestamp: string): string {
  const slug = userGoal
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `${isoTimestamp.replace(/[:.]/g, '-')}-${slug}`;
}

function inferLastCompletedStep(repoContext: RepoContextSnapshot): string | undefined {
  const lastTest = repoContext.testCommands.at(-1);
  if (lastTest) return `Ran verification command: ${lastTest}`;

  const lastCommand = repoContext.commandsRun.at(-1);
  if (lastCommand) return `Ran command: ${lastCommand}`;

  const lastChanged = repoContext.filesChanged.at(-1);
  if (lastChanged) return `Changed file: ${lastChanged}`;

  const lastRead = repoContext.filesRead.at(-1);
  if (lastRead) return `Read file: ${lastRead}`;

  return undefined;
}

function inferNextSuggestedStep(
  taskState: TaskStateSnapshot,
  repoContext: RepoContextSnapshot,
  status: TaskCheckpointStatus,
  completionFacts: CompletionFactsView,
): string | undefined {
  if (status === 'completed') return 'Task completed; no resume action required.';
  const testTargets = engineeringTestTargetPaths(taskState.filesChanged);
  if (
    testTargets.length > 0
    && completionFacts.verificationSignal().status !== 'passed'
  ) {
    if (testTargets.length === 1) {
      return `Run unit tests covering: ${testTargets[0]}`;
    }
    return `Run unit tests covering ${testTargets.length} changed source files before finishing.`;
  }
  if (repoContext.recentDiagnostics.length > 0) {
    return `Investigate latest diagnostic: ${repoContext.recentDiagnostics.at(-1)}`;
  }
  if (repoContext.filesChanged.length > 0) return 'Continue implementation from changed files.';
  return 'Continue the current task from the saved conversation and session notes.';
}
