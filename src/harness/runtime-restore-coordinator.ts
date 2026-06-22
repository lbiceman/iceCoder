/**
 * RuntimeRestoreCoordinator — 统一协调 Runtime Restore。
 *
 * 顺序：Idle 校验 → Restoring → 加载 Checkpoint → Workspace → Runtime → Conversation → Cursor → Idle
 * 任一步失败：回滚至 Restore 前状态，不留下半恢复。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UnifiedMessage } from '../llm/types.js';
import type { IntentCheckpointArchive } from '../types/intent-checkpoint.js';
import type { RuntimeSupervisorCheckpointState } from '../types/runtime-checkpoint.js';
import type { SupervisorRuntimeBridge } from './supervisor/supervisor-bridge.js';
import { CheckpointEngine } from './checkpoint-engine.js';
import {
  canSessionRestore,
  markSessionRestoring,
} from './harness-runtime-registry.js';
import {
  collectTrackedPathsAfterMessage,
  loadIntentCheckpoint,
  readSessionCheckpointJson,
  setCheckpointCursor,
  truncateCheckpointsAfter,
  writeSessionCheckpointJson,
} from './intent-checkpoint-store.js';
import { saveSessionWorkspace } from './session-workspace-store.js';
import {
  applyWorkspaceFileSnapshot,
  captureWorkspaceFilesForPaths,
  collectPathsToDeleteOnRestore,
  mergeTrackedPathSets,
} from './workspace-snapshot.js';
import {
  writeSessionNotesContent,
  writeToolTraceDiffsRaw,
  writeUiSessionMessages,
  readUiSessionMessages,
} from './intent-checkpoint-capture.js';
import { buildSessionWorkspaceRestoreSnapshot } from './session-workspace-restore.js';

async function writeStructuredMessages(
  sessionDir: string,
  sessionId: string,
  messages: UnifiedMessage[],
): Promise<void> {
  const file = path.join(sessionDir, `${sessionId}.structured.json`);
  await fs.mkdir(sessionDir, { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(messages), 'utf-8');
  await fs.rename(tmp, file);
}

function sessionCheckpointPath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.checkpoint.json`);
}

async function checkpointFileExists(sessionDir: string, sessionId: string): Promise<boolean> {
  try {
    await fs.access(sessionCheckpointPath(sessionDir, sessionId));
    return true;
  } catch {
    return false;
  }
}

export class RestoreNotAllowedError extends Error {
  readonly code = 'RESTORE_NOT_ALLOWED';
  constructor(message: string) {
    super(message);
    this.name = 'RestoreNotAllowedError';
  }
}

export class RestoreFailedError extends Error {
  readonly code = 'RESTORE_FAILED';
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RestoreFailedError';
    if (cause instanceof Error) this.cause = cause;
  }
}

interface PreRestoreBackup {
  combinedCheckpoint: Awaited<ReturnType<typeof readSessionCheckpointJson>>;
  checkpointFileExisted: boolean;
  workspaceJson: string | null;
  workspaceRoot: string;
  workspaceFilesBefore: Record<string, string | null>;
  structuredMessages: UnifiedMessage[] | undefined;
  uiMessagesRaw: string | null;
  checkpointIndexRaw: string | null;
  sessionNotesRaw: string | null;
  toolTraceDiffsRaw: string | null;
  supervisorSnapshot: RuntimeSupervisorCheckpointState | null;
}

export interface RuntimeRestoreParams {
  sessionDir: string;
  sessionId: string;
  messageId: string;
  defaultWorkDir: string;
  supervisorBridge?: SupervisorRuntimeBridge;
  getStructuredMessages?: () => UnifiedMessage[] | undefined;
  setStructuredMessages?: (messages: UnifiedMessage[] | undefined) => void;
}

export interface RuntimeRestoreResult {
  restoredAt: string;
  userMessageTime: number | null;
  systemEventContent: string;
}

export class RuntimeRestoreCoordinator {
  private restoringSessions = new Set<string>();

  isRestoring(sessionId?: string): boolean {
    if (sessionId) return this.restoringSessions.has(sessionId);
    return this.restoringSessions.size > 0;
  }

  async restore(params: RuntimeRestoreParams): Promise<RuntimeRestoreResult> {
    const { sessionDir, sessionId, messageId } = params;

    if (this.restoringSessions.has(sessionId)) {
      throw new RestoreNotAllowedError('该会话已有回滚操作正在进行。');
    }
    if (!canSessionRestore(sessionId)) {
      throw new RestoreNotAllowedError('运行中，无法回滚。');
    }

    this.restoringSessions.add(sessionId);
    markSessionRestoring(sessionId, true);

    let backup: PreRestoreBackup | undefined;
    const engine = new CheckpointEngine(sessionDir, sessionId);
    engine.setRestoreLock(true);

    try {
      const archive = await loadIntentCheckpoint(sessionDir, sessionId, messageId);
      if (!archive) {
        throw new RestoreFailedError(
          '未找到该消息的检查点。该消息可能在回滚功能启用前发送，或检查点捕获失败。',
        );
      }

      backup = await this.capturePreRestoreBackup(params, archive);

      await this.applyRestore(params, archive, engine);

      await writeUiSessionMessages(sessionDir, sessionId, archive.uiMessages);
      await writeStructuredMessages(sessionDir, sessionId, archive.structuredMessages);
      params.setStructuredMessages?.(archive.structuredMessages);

      await writeSessionNotesContent(sessionDir, sessionId, archive.sessionNotesContent);
      await writeToolTraceDiffsRaw(sessionDir, sessionId, archive.toolTraceDiffsRaw);

      await setCheckpointCursor(sessionDir, sessionId, messageId);
      await truncateCheckpointsAfter(sessionDir, sessionId, messageId);

      const timeLabel = archive.userMessageTime
        ? new Date(archive.userMessageTime).toLocaleString('zh-CN')
        : archive.createdAt;

      return {
        restoredAt: new Date().toISOString(),
        userMessageTime: archive.userMessageTime,
        systemEventContent:
          `已回滚至检查点：\n${timeLabel}\n\n运行时已成功恢复。`,
      };
    } catch (err) {
      if (backup) {
        try {
          await this.rollbackRestore(sessionDir, sessionId, backup, params);
        } catch (rollbackErr) {
          console.error('[runtime-restore] rollback failed:', rollbackErr);
        }
      }
      if (err instanceof RestoreNotAllowedError || err instanceof RestoreFailedError) {
        throw err;
      }
      throw new RestoreFailedError(
        '回滚失败，运行时状态未改变。',
        err,
      );
    } finally {
      engine.setRestoreLock(false);
      this.restoringSessions.delete(sessionId);
      markSessionRestoring(sessionId, false);
    }
  }

  private async capturePreRestoreBackup(
    params: RuntimeRestoreParams,
    archive: IntentCheckpointArchive,
  ): Promise<PreRestoreBackup> {
    const { sessionDir, sessionId, defaultWorkDir } = params;
    const readOptional = async (p: string): Promise<string | null> => {
      try {
        return await fs.readFile(p, 'utf-8');
      } catch {
        return null;
      }
    };

    const workspaceRoot = await this.resolveCurrentWorkspaceRoot(sessionDir, sessionId, defaultWorkDir);
    const laterPaths = await collectTrackedPathsAfterMessage(sessionDir, sessionId, archive.messageId);
    const pathsToSnapshot = mergeTrackedPathSets(
      Object.keys(archive.workspaceFiles),
      laterPaths,
      collectPathsToDeleteOnRestore(archive.workspaceFiles, laterPaths),
    );

    const workspaceFilesBefore = await captureWorkspaceFilesForPaths(workspaceRoot, pathsToSnapshot);

    const existingCheckpoint = await readSessionCheckpointJson(sessionDir, sessionId);
    const supervisorSnapshot = existingCheckpoint?.runtimeV2?.supervisorState
      ? structuredClone(existingCheckpoint.runtimeV2.supervisorState)
      : null;

    return {
      combinedCheckpoint: existingCheckpoint,
      checkpointFileExisted: await checkpointFileExists(sessionDir, sessionId),
      workspaceJson: await readOptional(path.join(sessionDir, `${sessionId}.workspace.json`)),
      workspaceRoot,
      workspaceFilesBefore,
      structuredMessages: params.getStructuredMessages?.()?.map((m) => ({ ...m })),
      uiMessagesRaw: await readOptional(path.join(sessionDir, `${sessionId}.json`)),
      checkpointIndexRaw: await readOptional(path.join(sessionDir, `${sessionId}.checkpoint-index.json`)),
      sessionNotesRaw: await readOptional(path.join(sessionDir, `${sessionId}.session-notes.md`)),
      toolTraceDiffsRaw: await readOptional(path.join(sessionDir, `${sessionId}.tool-trace-diffs.json`)),
      supervisorSnapshot,
    };
  }

  private async resolveCurrentWorkspaceRoot(
    sessionDir: string,
    sessionId: string,
    defaultWorkDir: string,
  ): Promise<string> {
    try {
      const raw = await fs.readFile(path.join(sessionDir, `${sessionId}.workspace.json`), 'utf-8');
      const parsed = JSON.parse(raw) as { lockedRoot?: string };
      return parsed.lockedRoot ?? defaultWorkDir;
    } catch {
      return defaultWorkDir;
    }
  }

  private async rollbackRestore(
    sessionDir: string,
    sessionId: string,
    backup: PreRestoreBackup,
    params: RuntimeRestoreParams,
  ): Promise<void> {
    if (backup.checkpointFileExisted && backup.combinedCheckpoint) {
      await writeSessionCheckpointJson(sessionDir, sessionId, backup.combinedCheckpoint);
    } else {
      try {
        await fs.unlink(sessionCheckpointPath(sessionDir, sessionId));
      } catch {
        /* absent */
      }
    }

    if (backup.workspaceJson != null) {
      const p = path.join(sessionDir, `${sessionId}.workspace.json`);
      const tmp = `${p}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, backup.workspaceJson, 'utf-8');
      await fs.rename(tmp, p);
    }

    await applyWorkspaceFileSnapshot(
      backup.workspaceRoot,
      backup.workspaceFilesBefore,
      [],
    );

    if (backup.uiMessagesRaw != null) {
      const p = path.join(sessionDir, `${sessionId}.json`);
      const tmp = `${p}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, backup.uiMessagesRaw, 'utf-8');
      await fs.rename(tmp, p);
    }

    if (backup.checkpointIndexRaw != null) {
      const p = path.join(sessionDir, `${sessionId}.checkpoint-index.json`);
      const tmp = `${p}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, backup.checkpointIndexRaw, 'utf-8');
      await fs.rename(tmp, p);
    }

    if (backup.structuredMessages) {
      await writeStructuredMessages(sessionDir, sessionId, backup.structuredMessages);
      params.setStructuredMessages?.(backup.structuredMessages);
    }

    await writeSessionNotesContent(sessionDir, sessionId, backup.sessionNotesRaw);
    await writeToolTraceDiffsRaw(sessionDir, sessionId, backup.toolTraceDiffsRaw);

    if (params.supervisorBridge?.isActive() && backup.supervisorSnapshot) {
      params.supervisorBridge.restoreFromCheckpoint(backup.supervisorSnapshot);
    }
  }

  private async applyRestore(
    params: RuntimeRestoreParams,
    archive: IntentCheckpointArchive,
    engine: CheckpointEngine,
  ): Promise<void> {
    const { sessionDir, sessionId, supervisorBridge } = params;
    const workspaceRoot = archive.workspaceRoot || params.defaultWorkDir;

    if (archive.combinedCheckpoint) {
      await writeSessionCheckpointJson(sessionDir, sessionId, archive.combinedCheckpoint);
      engine.loadFromCombined(archive.combinedCheckpoint);
    } else {
      try {
        await fs.unlink(sessionCheckpointPath(sessionDir, sessionId));
      } catch {
        /* absent */
      }
      engine.resetMemory();
    }

    await saveSessionWorkspace(sessionDir, sessionId, archive.workspace);
    const currentUi = await readUiSessionMessages(sessionDir, sessionId);
    const workspaceSnapshot = await buildSessionWorkspaceRestoreSnapshot({
      archive,
      sessionDir,
      sessionId,
      workspaceRoot,
      currentUiMessages: currentUi,
    });
    const laterPaths = await collectTrackedPathsAfterMessage(sessionDir, sessionId, archive.messageId);
    const toDelete = collectPathsToDeleteOnRestore(workspaceSnapshot, laterPaths);
    await applyWorkspaceFileSnapshot(workspaceRoot, workspaceSnapshot, toDelete);

    const v2 = archive.combinedCheckpoint?.runtimeV2;
    if (v2?.supervisorState && supervisorBridge?.isActive()) {
      supervisorBridge.restoreFromCheckpoint(v2.supervisorState);
    }
  }
}

/** 进程级单例 */
let coordinatorInstance: RuntimeRestoreCoordinator | null = null;

export function getRuntimeRestoreCoordinator(): RuntimeRestoreCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new RuntimeRestoreCoordinator();
  }
  return coordinatorInstance;
}

export function resetRuntimeRestoreCoordinator(): void {
  coordinatorInstance = null;
}
