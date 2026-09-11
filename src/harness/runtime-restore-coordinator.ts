/**
 * RuntimeRestoreCoordinator — 统一协调 Runtime Restore。
 *
 * 顺序：Idle 校验 → Restoring → 加载 Checkpoint → Workspace → Runtime → Conversation → 截断检查点 → Idle
 * 对话会去掉被回滚的那条用户消息（及之后内容），避免再进入模型上下文；界面只追加回滚记录。
 * 任一步失败：回滚至 Restore 前状态，不留下半恢复。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UnifiedMessage } from '../llm/types.js';
import type { IntentCheckpointArchive } from '../types/intent-checkpoint.js';
import { CheckpointEngine } from './checkpoint-engine.js';
import {
  canSessionRestore,
  markSessionRestoring,
} from './harness-runtime-registry.js';
import {
  collectTrackedPathsAfterMessage,
  loadIntentCheckpoint,
  loadSessionTouchedPaths,
  readSessionCheckpointJson,
  truncateCheckpointsFrom,
  writeSessionCheckpointJson,
} from './intent-checkpoint-store.js';
import {
  truncateConversationBeforeUserMessage,
} from './conversation-delete.js';
import { saveSessionWorkspace } from './session-workspace-store.js';
import {
  applyWorkspaceFileSnapshot,
  captureWorkspaceFilesForPaths,
  collectPathsToDeleteOnRestore,
  mergeTrackedPathSets,
  remapPathToWorkspace,
} from './workspace-snapshot.js';
import {
  writeSessionNotesContent,
  writeToolTraceDiffsRaw,
  writeUiSessionMessages,
  readUiSessionMessages,
} from './intent-checkpoint-capture.js';
import {
  buildSessionWorkspaceRestoreSnapshot,
  collectExistedRelPathsAtCheckpoint,
  collectWrittenRelPathsAfterMessage,
} from './session-workspace-restore.js';
import { ProjectCheckpointStore } from './project-checkpoint-store.js';
import { bumpSessionContextWriteEpoch } from './session-context-write-gate.js';
import type { CheckpointSnapshot } from './checkpoint-snapshot.js';

interface IntentRestoreMaterial {
  checkpoint: CheckpointSnapshot | null;
  workspaceRoot: string;
  workspaceFiles: Record<string, string | null>;
  pathsToDelete: string[];
}

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

async function readStructuredMessagesFile(
  sessionDir: string,
  sessionId: string,
): Promise<UnifiedMessage[]> {
  try {
    const raw = await fs.readFile(path.join(sessionDir, `${sessionId}.structured.json`), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as UnifiedMessage[] : [];
  } catch {
    return [];
  }
}

/** 以当前会话文件为准截断：该用户气泡及之后的记录都从聊天和模型上下文里删掉。 */
async function conversationBeforeRestoredTurn(
  params: RuntimeRestoreParams,
  archive: IntentCheckpointArchive,
  messageId: string,
): Promise<{
  uiMessages: IntentCheckpointArchive['uiMessages'];
  structuredMessages: UnifiedMessage[];
}> {
  const liveUi = await readUiSessionMessages(params.sessionDir, params.sessionId);
  const sourceUi = liveUi.some((m) => m.id === messageId && m.role === 'user')
    ? liveUi
    : archive.uiMessages;
  const cached = params.getStructuredMessages?.();
  const diskStructured = await readStructuredMessagesFile(params.sessionDir, params.sessionId);
  const sourceStructured = (cached && cached.length > 0)
    ? cached
    : (diskStructured.length > 0 ? diskStructured : archive.structuredMessages);
  const archivedUser = archive.uiMessages.find((m) => m.id === messageId && m.role === 'user');
  const fallbackUserContent = typeof archivedUser?.content === 'string' ? archivedUser.content : '';
  return truncateConversationBeforeUserMessage(
    sourceUi,
    sourceStructured,
    messageId,
    fallbackUserContent,
  );
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
  structuredRaw: string | null;
  uiMessagesRaw: string | null;
  checkpointIndexRaw: string | null;
  sessionNotesRaw: string | null;
  toolTraceDiffsRaw: string | null;
}

export interface RuntimeRestoreParams {
  sessionDir: string;
  sessionId: string;
  messageId: string;
  defaultWorkDir: string;
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

      bumpSessionContextWriteEpoch(sessionId);
      const material = await this.buildRestoreMaterial(params, archive);
      backup = await this.capturePreRestoreBackup(params, archive, material);
      await this.applyRestore(params, archive, material, engine);

      const conversation = await conversationBeforeRestoredTurn(params, archive, messageId);
      await writeUiSessionMessages(sessionDir, sessionId, conversation.uiMessages);
      await writeStructuredMessages(sessionDir, sessionId, conversation.structuredMessages);
      params.setStructuredMessages?.(conversation.structuredMessages);

      await writeSessionNotesContent(sessionDir, sessionId, archive.sessionNotesContent);
      await writeToolTraceDiffsRaw(sessionDir, sessionId, archive.toolTraceDiffsRaw);

      await truncateCheckpointsFrom(sessionDir, sessionId, messageId);

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
    material: IntentRestoreMaterial,
  ): Promise<PreRestoreBackup> {
    const { sessionDir, sessionId, defaultWorkDir } = params;
    const readOptional = async (p: string): Promise<string | null> => {
      try {
        return await fs.readFile(p, 'utf-8');
      } catch {
        return null;
      }
    };

    const workspaceRoot = material.workspaceRoot
      || await this.resolveCurrentWorkspaceRoot(sessionDir, sessionId, defaultWorkDir);
    const laterPaths = await collectTrackedPathsAfterMessage(sessionDir, sessionId, archive.messageId);
    const liveTouched = await loadSessionTouchedPaths(sessionDir, sessionId);
    const currentUi = await readUiSessionMessages(sessionDir, sessionId);
    const writtenAfter = collectWrittenRelPathsAfterMessage(
      currentUi,
      archive.messageId,
      workspaceRoot,
      archive,
    );
    const pathsToSnapshot = mergeTrackedPathSets(
      Object.keys(archive.workspaceFiles),
      Object.keys(material.workspaceFiles),
      material.pathsToDelete,
      laterPaths,
      liveTouched,
      writtenAfter,
      collectPathsToDeleteOnRestore(
        archive.workspaceFiles,
        mergeTrackedPathSets(laterPaths, liveTouched, writtenAfter),
        workspaceRoot,
      ),
    );

    const workspaceFilesBefore = await captureWorkspaceFilesForPaths(workspaceRoot, pathsToSnapshot);

    const existingCheckpoint = await readSessionCheckpointJson(sessionDir, sessionId);
    const cachedStructured = params.getStructuredMessages?.();
    return {
      combinedCheckpoint: existingCheckpoint,
      checkpointFileExisted: await checkpointFileExists(sessionDir, sessionId),
      workspaceJson: await readOptional(path.join(sessionDir, `${sessionId}.workspace.json`)),
      workspaceRoot,
      workspaceFilesBefore,
      structuredMessages: Array.isArray(cachedStructured) && cachedStructured.length > 0
        ? cachedStructured.map((m) => ({ ...m }))
        : undefined,
      structuredRaw: await readOptional(path.join(sessionDir, `${sessionId}.structured.json`)),
      uiMessagesRaw: await readOptional(path.join(sessionDir, `${sessionId}.json`)),
      checkpointIndexRaw: await readOptional(path.join(sessionDir, `${sessionId}.checkpoint-index.json`)),
      sessionNotesRaw: await readOptional(path.join(sessionDir, `${sessionId}.session-notes.md`)),
      toolTraceDiffsRaw: await readOptional(path.join(sessionDir, `${sessionId}.tool-trace-diffs.json`)),
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
      new ProjectCheckpointStore({ sessionDir, sessionId }).discardCachedLatest();
    }

    if (backup.workspaceJson != null) {
      const p = path.join(sessionDir, `${sessionId}.workspace.json`);
      const tmp = `${p}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, backup.workspaceJson, 'utf-8');
      await fs.rename(tmp, p);
    } else {
      await fs.unlink(path.join(sessionDir, `${sessionId}.workspace.json`)).catch(() => undefined);
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

    if (backup.structuredMessages && backup.structuredMessages.length > 0) {
      await writeStructuredMessages(sessionDir, sessionId, backup.structuredMessages);
      params.setStructuredMessages?.(backup.structuredMessages);
    } else if (backup.structuredRaw != null) {
      const p = path.join(sessionDir, `${sessionId}.structured.json`);
      const tmp = `${p}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, backup.structuredRaw, 'utf-8');
      await fs.rename(tmp, p);
      try {
        const parsed = JSON.parse(backup.structuredRaw);
        if (Array.isArray(parsed)) params.setStructuredMessages?.(parsed as UnifiedMessage[]);
      } catch {
        /* keep previous cache */
      }
    }

    await writeSessionNotesContent(sessionDir, sessionId, backup.sessionNotesRaw);
    await writeToolTraceDiffsRaw(sessionDir, sessionId, backup.toolTraceDiffsRaw);

  }

  private async applyRestore(
    params: RuntimeRestoreParams,
    archive: IntentCheckpointArchive,
    material: IntentRestoreMaterial,
    engine: CheckpointEngine,
  ): Promise<void> {
    const { sessionDir, sessionId } = params;

    if (material.checkpoint) {
      await new ProjectCheckpointStore({ sessionDir, sessionId }).restore(
        material.checkpoint,
        { intentMessageId: archive.messageId },
      );
    } else {
      try {
        await fs.unlink(sessionCheckpointPath(sessionDir, sessionId));
      } catch {
        /* absent */
      }
      engine.resetMemory();
    }

    await saveSessionWorkspace(sessionDir, sessionId, {
      ...archive.workspace,
      lockedRoot: material.workspaceRoot || archive.workspace.lockedRoot,
    });
    await applyWorkspaceFileSnapshot(
      material.workspaceRoot,
      material.workspaceFiles,
      material.pathsToDelete,
    );
  }

  private async buildRestoreMaterial(
    params: RuntimeRestoreParams,
    archive: IntentCheckpointArchive,
  ): Promise<IntentRestoreMaterial> {
    const { sessionDir, sessionId } = params;
    const workspaceRoot = await this.resolveCurrentWorkspaceRoot(
      sessionDir,
      sessionId,
      archive.workspaceRoot || params.defaultWorkDir,
    );
    const currentUi = await readUiSessionMessages(sessionDir, sessionId);
    const workspaceSnapshot = await buildSessionWorkspaceRestoreSnapshot({
      archive,
      sessionDir,
      sessionId,
      workspaceRoot,
      currentUiMessages: currentUi,
    });
    const laterPaths = await collectTrackedPathsAfterMessage(sessionDir, sessionId, archive.messageId);
    const writtenAfter = collectWrittenRelPathsAfterMessage(
      currentUi,
      archive.messageId,
      workspaceRoot,
      archive,
    );
    const liveTouched = await loadSessionTouchedPaths(sessionDir, sessionId);
    const existed = await collectExistedRelPathsAtCheckpoint({
      archive,
      sessionDir,
      sessionId,
      workspaceRoot,
      snapshot: workspaceSnapshot,
      uiMessages: currentUi,
    });
    const deleteCandidates = mergeTrackedPathSets(laterPaths, writtenAfter, liveTouched)
      .filter((raw) => {
        const key = remapPathToWorkspace(workspaceRoot, raw) ?? raw.replace(/\\/g, '/');
        return key && !existed.has(key);
      });
    return {
      checkpoint: archive.projectCheckpoint ?? null,
      workspaceRoot,
      workspaceFiles: workspaceSnapshot,
      pathsToDelete: collectPathsToDeleteOnRestore(
        workspaceSnapshot,
        deleteCandidates,
        workspaceRoot,
      ),
    };
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
