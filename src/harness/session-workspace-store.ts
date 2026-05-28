import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  detectWorkspaceFromUserMessage,
  emptySessionWorkspaceState,
  mergeWorkspaceDetection,
  type SessionWorkspaceState,
  type WorkspaceDetectionResult,
} from './workspace-lock.js';

function workspaceFilePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.workspace.json`);
}

export async function loadSessionWorkspace(
  sessionDir: string,
  sessionId: string,
): Promise<SessionWorkspaceState> {
  try {
    const raw = await fs.readFile(workspaceFilePath(sessionDir, sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as SessionWorkspaceState;
    return {
      referenceReads: parsed.referenceReads ?? [],
      changeCount: parsed.changeCount ?? 0,
      lockedRoot: parsed.lockedRoot,
      lockedAt: parsed.lockedAt,
    };
  } catch {
    return emptySessionWorkspaceState();
  }
}

export async function saveSessionWorkspace(
  sessionDir: string,
  sessionId: string,
  state: SessionWorkspaceState,
): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    workspaceFilePath(sessionDir, sessionId),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

export async function clearSessionWorkspace(
  sessionDir: string,
  sessionId: string,
): Promise<void> {
  try {
    await fs.unlink(workspaceFilePath(sessionDir, sessionId));
  } catch {
    /* file may not exist */
  }
}

export interface ResolvedSessionWorkspace {
  workspaceRoot: string;
  defaultWorkDir: string;
  lockedRoot?: string;
}

/** 会话有效工作目录：已锁定则用 lockedRoot，否则回退 defaultWorkDir（通常为 process.cwd()）。 */
export async function resolveEffectiveWorkspaceRoot(
  sessionDir: string,
  sessionId: string,
  defaultWorkDir: string = process.cwd(),
): Promise<ResolvedSessionWorkspace> {
  const state = await loadSessionWorkspace(sessionDir, sessionId);
  const workspaceRoot = state.lockedRoot ?? defaultWorkDir;
  return {
    workspaceRoot,
    defaultWorkDir,
    ...(state.lockedRoot ? { lockedRoot: state.lockedRoot } : {}),
  };
}

export interface ApplyWorkspaceLockResult {
  state: SessionWorkspaceState;
  detection: WorkspaceDetectionResult;
}

/** 加载 → 检测 → 合并 → 持久化（幂等：同一条消息重复调用结果一致）。 */
export async function applyUserMessageWorkspaceLock(params: {
  sessionDir: string;
  sessionId: string;
  userMessage: string;
}): Promise<ApplyWorkspaceLockResult> {
  const current = await loadSessionWorkspace(params.sessionDir, params.sessionId);
  const detection = detectWorkspaceFromUserMessage(params.userMessage, current);
  const next = mergeWorkspaceDetection(current, detection);
  if (detection.changed || JSON.stringify(next) !== JSON.stringify(current)) {
    await saveSessionWorkspace(params.sessionDir, params.sessionId, next);
  }
  return { state: next, detection };
}
