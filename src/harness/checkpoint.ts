import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UnifiedMessage, ToolCall } from '../llm/types.js';
import type { LoopState, StopReason } from './types.js';
import type { TaskStateSnapshot, RepoContextSnapshot } from '../types/runtime-snapshot.js';
import { snapshotHasUnconfirmedFileDeliverables, writeConfirmationPaths } from './document-deliverable.js';
import { checkpointHasPendingWork } from './incomplete-completion.js';
import { buildCheckpointResumeSummary, sanitizeCheckpointGoal } from './checkpoint-resume-compact.js';
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
  // plan field removed (Phase 11)
}

export class TaskCheckpointManager {
  readonly checkpointPath: string;

  constructor(sessionDir: string, sessionId = 'default') {
    this.checkpointPath = path.join(sessionDir, `${sessionId}.checkpoint.json`);
  }

  async loadActive(): Promise<TaskCheckpoint | null> {
    try {
      const raw = await fs.readFile(this.checkpointPath, 'utf-8');
      const checkpoint = JSON.parse(raw) as TaskCheckpoint;
      if (checkpoint.version !== 1) return null;
      if (checkpoint.status === 'failed') return null;
      if (checkpoint.status === 'completed') {
        if (!checkpointHasPendingWork(checkpoint)) return null;
        return { ...checkpoint, status: 'paused' };
      }
      return checkpoint;
    } catch {
      return null;
    }
  }

  async save(update: TaskCheckpointUpdate): Promise<TaskCheckpoint> {
    const existing = await this.readExisting();
    const now = new Date().toISOString();
    // planField logic removed (Phase 11)

    const checkpoint: TaskCheckpoint = {
      version: 1,
      taskId: existing?.taskId ?? createTaskId(update.userGoal, now),
      status: update.status,
      userGoal: update.userGoal,
      phase: update.taskState.phase,
      lastCompletedStep: inferLastCompletedStep(update.repoContext),
      nextSuggestedStep: inferNextSuggestedStep(update.taskState, update.repoContext, update.status),
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
      // ...planField removed (Phase 11)
    };

    await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true });
    const tmpPath = `${this.checkpointPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.checkpointPath);
    return checkpoint;
  }

  // clearEmbeddedPlan removed (Phase 11 — execution plan layer deleted)

  buildResumeMessage(checkpoint: TaskCheckpoint): UnifiedMessage {
    return {
      role: 'user',
      content: buildCheckpointResumeSummary(checkpoint),
      preserveOnCompaction: true,
    };
  }

  private async readExisting(): Promise<TaskCheckpoint | null> {
    try {
      return JSON.parse(await fs.readFile(this.checkpointPath, 'utf-8')) as TaskCheckpoint;
    } catch {
      return null;
    }
  }
}

export function summarizeToolCalls(toolCalls: ToolCall[] | undefined): string[] {
  if (!toolCalls?.length) return [];
  return toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments ?? {})}`);
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
): string | undefined {
  if (status === 'completed') return 'Task completed; no resume action required.';
  if (snapshotHasUnconfirmedFileDeliverables(taskState)) {
    const paths = writeConfirmationPaths(taskState.filesChanged);
    if (paths.length === 1) {
      return `Confirm the deliverable with file_info or read_file: ${paths[0]}`;
    }
    return `Confirm ${paths.length} file deliverables with file_info or read_file before finishing.`;
  }
  if (repoContext.recentDiagnostics.length > 0) {
    return `Investigate latest diagnostic: ${repoContext.recentDiagnostics.at(-1)}`;
  }
  if (repoContext.filesChanged.length > 0) return 'Continue implementation from changed files.';
  return 'Continue the current task from the saved conversation and session notes.';
}
