/**
 * 在用户消息到达时捕获 Intent Checkpoint（Harness Idle → 即将 Running）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UnifiedMessage } from '../llm/types.js';
import type { SessionWorkspaceState } from './workspace-lock.js';
import type { IntentCheckpointArchive, UiChatMessage } from '../types/intent-checkpoint.js';
import { INTENT_CHECKPOINT_VERSION } from '../types/intent-checkpoint.js';
import {
  loadSessionTouchedPaths,
  readSessionCheckpointJson,
  saveIntentCheckpoint,
} from './intent-checkpoint-store.js';
import {
  captureWorkspaceFileSnapshot,
  collectTrackedPathsFromCheckpoint,
  extractLikelyFilePathsFromText,
  mergeTrackedPathSets,
  resolveLikelyPathsInWorkspace,
} from './workspace-snapshot.js';
import { loadSessionWorkspace } from './session-workspace-store.js';
import { sessionNotesPath } from '../memory/file-memory/session-memory.js';

function toolTraceDiffsFile(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.tool-trace-diffs.json`);
}

export interface CaptureIntentCheckpointParams {
  sessionDir: string;
  sessionId: string;
  messageId: string;
  userMessageTime: number | null;
  workspaceRoot: string;
  workspaceState: SessionWorkspaceState;
  structuredMessages: UnifiedMessage[];
  uiMessages: UiChatMessage[];
  /** 之前 checkpoint 已跟踪路径，用于累积 */
  priorTrackedPaths?: string[];
}

export interface CaptureIntentCheckpointResult {
  archive: IntentCheckpointArchive;
  ok: true;
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function captureIntentCheckpoint(
  params: CaptureIntentCheckpointParams,
): Promise<CaptureIntentCheckpointResult> {
  const combined = await readSessionCheckpointJson(params.sessionDir, params.sessionId);
  const manifestPaths = await loadSessionTouchedPaths(params.sessionDir, params.sessionId);
  const userMsg = params.uiMessages.find((m) => m.id === params.messageId && m.role === 'user');
  const userText = typeof userMsg?.content === 'string' ? userMsg.content : '';
  const hintedPaths = await resolveLikelyPathsInWorkspace(
    params.workspaceRoot,
    extractLikelyFilePathsFromText(userText),
  );
  const trackedPaths = mergeTrackedPathSets(
    collectTrackedPathsFromCheckpoint(combined, params.priorTrackedPaths ?? []),
    manifestPaths,
    hintedPaths,
  );
  const workspaceFiles = await captureWorkspaceFileSnapshot(
    params.workspaceRoot,
    trackedPaths,
  );

  const notesFile = sessionNotesPath(params.sessionDir, params.sessionId);
  const diffsFile = toolTraceDiffsFile(params.sessionDir, params.sessionId);

  const archive: IntentCheckpointArchive = {
    version: INTENT_CHECKPOINT_VERSION,
    messageId: params.messageId,
    sessionId: params.sessionId,
    createdAt: new Date().toISOString(),
    userMessageTime: params.userMessageTime,
    combinedCheckpoint: combined,
    workspace: params.workspaceState,
    workspaceRoot: params.workspaceRoot,
    workspaceFiles,
    trackedPaths,
    structuredMessages: params.structuredMessages.map((m) => ({ ...m })),
    uiMessages: params.uiMessages.map((m) => ({ ...m })),
    sessionNotesContent: await readOptionalFile(notesFile),
    toolTraceDiffsRaw: await readOptionalFile(diffsFile),
  };

  await saveIntentCheckpoint({
    sessionDir: params.sessionDir,
    sessionId: params.sessionId,
    archive,
  });

  return { archive, ok: true };
}

/** 读取 UI 消息文件 */
export async function readUiSessionMessages(
  sessionDir: string,
  sessionId: string,
): Promise<UiChatMessage[]> {
  const file = path.join(sessionDir, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeUiSessionMessages(
  sessionDir: string,
  sessionId: string,
  messages: UiChatMessage[],
): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const file = path.join(sessionDir, `${sessionId}.json`);
  await fs.mkdir(sessionDir, { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(messages), 'utf-8');
  await fs.rename(tmp, file);
}

export async function writeSessionNotesContent(
  sessionDir: string,
  sessionId: string,
  content: string | null | undefined,
): Promise<void> {
  const file = sessionNotesPath(sessionDir, sessionId);
  if (content == null) {
    try {
      await fs.unlink(file);
    } catch {
      /* absent */
    }
    return;
  }
  await fs.mkdir(sessionDir, { recursive: true });
  const { randomUUID } = await import('node:crypto');
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, file);
}

export async function writeToolTraceDiffsRaw(
  sessionDir: string,
  sessionId: string,
  raw: string | null | undefined,
): Promise<void> {
  const file = toolTraceDiffsFile(sessionDir, sessionId);
  if (raw == null) {
    try {
      await fs.unlink(file);
    } catch {
      /* absent */
    }
    return;
  }
  await fs.mkdir(sessionDir, { recursive: true });
  const { randomUUID } = await import('node:crypto');
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, raw, 'utf-8');
  await fs.rename(tmp, file);
}

export async function loadWorkspaceForCapture(
  sessionDir: string,
  sessionId: string,
): Promise<SessionWorkspaceState> {
  return loadSessionWorkspace(sessionDir, sessionId);
}
