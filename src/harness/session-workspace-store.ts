import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  detectWorkspaceFromUserMessage,
  emptySessionWorkspaceState,
  mergeWorkspaceDetection,
  normalizeDetectedPath,
  type SessionWorkspaceState,
  type WorkspaceDetectionResult,
} from './workspace-lock.js';

function workspaceFilePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.workspace.json`);
}

function sessionMessagesFilePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.json`);
}

const LOCKED_ROOT_FILE_EXT =
  /\.(md|markdown|rst|txt|log|yaml|yml|json|jsonc|toml|ini|cfg|conf|env|properties|lock|csv|tsv|xml|sql|ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro|py|go|rs|rb|php|java|kt|kts|swift|scala|dart|lua|c|cc|cpp|cxx|h|hpp|hh|cs|m|mm|sh|bash|zsh|bat|cmd|ps1|gradle|html|htm|css|scss|sass|less|unity|prefab|asset|mat|shader|shadergraph|anim|controller|meta|scene|uasset|umap|png|jpe?g|gif|svg|webp|ico|pdf|docx?|xlsx?|pptx?)$/i;

async function looksLikeCorruptFileLockedRoot(lockedRoot?: string): Promise<boolean> {
  if (!lockedRoot) return false;
  try {
    const stat = await fs.stat(lockedRoot);
    return stat.isFile();
  } catch {
    return LOCKED_ROOT_FILE_EXT.test(path.win32.basename(lockedRoot));
  }
}

async function rebuildSessionWorkspaceFromMessages(
  sessionDir: string,
  sessionId: string,
): Promise<SessionWorkspaceState | null> {
  try {
    const raw = await fs.readFile(sessionMessagesFilePath(sessionDir, sessionId), 'utf-8');
    const messages = JSON.parse(raw) as Array<{ role?: string; content?: unknown }>;
    let state = emptySessionWorkspaceState();
    for (const msg of messages) {
      if (msg?.role !== 'user' || typeof msg.content !== 'string') continue;
      const detection = detectWorkspaceFromUserMessage(msg.content, state);
      state = mergeWorkspaceDetection(state, detection);
    }
    return state.lockedRoot ? state : null;
  } catch {
    return null;
  }
}

async function repairCorruptFileLockedRoot(
  sessionDir: string,
  sessionId: string,
  state: SessionWorkspaceState,
): Promise<SessionWorkspaceState> {
  if (!await looksLikeCorruptFileLockedRoot(state.lockedRoot)) return state;
  const rebuilt = await rebuildSessionWorkspaceFromMessages(sessionDir, sessionId);
  if (!rebuilt?.lockedRoot || rebuilt.lockedRoot === state.lockedRoot) return state;
  await saveSessionWorkspace(sessionDir, sessionId, rebuilt);
  return rebuilt;
}

export async function loadSessionWorkspace(
  sessionDir: string,
  sessionId: string,
): Promise<SessionWorkspaceState> {
  try {
    const raw = await fs.readFile(workspaceFilePath(sessionDir, sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as SessionWorkspaceState;
    const state = {
      referenceReads: parsed.referenceReads ?? [],
      changeCount: parsed.changeCount ?? 0,
      lockedRoot: parsed.lockedRoot,
      lockedAt: parsed.lockedAt,
    };
    return await repairCorruptFileLockedRoot(sessionDir, sessionId, state);
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

/** 将 imagesCache 等会话外挂载路径登记为 referenceReads（供 image_read 等工作区外只读）。 */
export async function addSessionReferenceReads(params: {
  sessionDir: string;
  sessionId: string;
  paths: string[];
}): Promise<SessionWorkspaceState> {
  const current = await loadSessionWorkspace(params.sessionDir, params.sessionId);
  const refs = new Set(current.referenceReads.map((r) => normalizeDetectedPath(r)));
  let changed = false;

  for (const raw of params.paths) {
    if (!raw?.trim()) continue;
    const normalized = normalizeDetectedPath(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (![...refs].some((r) => r.toLowerCase() === key)) {
      refs.add(normalized);
      changed = true;
    }
  }

  if (!changed) return current;

  const next: SessionWorkspaceState = {
    ...current,
    referenceReads: [...refs],
  };
  await saveSessionWorkspace(params.sessionDir, params.sessionId, next);
  return next;
}
