/**
 * 会话级 Shell 协作状态。
 *
 * 内存 Map 是进程内的权威状态；`{sessionId}.shell-collab.json` sidecar
 * 用于在服务重启、页面刷新或重新连接后恢复状态。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ShellCollabState {
  active: boolean;
  taskId: string | null;
  enteredAt: number;
}

const shellCollabBySession = new Map<string, ShellCollabState>();

function resolveSessionsDir(sessionsDir?: string): string {
  const resolved = sessionsDir ?? process.env.ICE_SESSIONS_DIR;
  if (!resolved) {
    throw new Error('ICE_SESSIONS_DIR is required for shell collaboration persistence');
  }
  return path.resolve(resolved);
}

function sidecarPath(sessionId: string, sessionsDir?: string): string {
  if (!sessionId || path.basename(sessionId) !== sessionId) {
    throw new Error('invalid session id');
  }
  return path.join(resolveSessionsDir(sessionsDir), `${sessionId}.shell-collab.json`);
}

function isShellCollabState(value: unknown): value is ShellCollabState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return typeof state.active === 'boolean'
    && (state.taskId === null || typeof state.taskId === 'string')
    && typeof state.enteredAt === 'number'
    && Number.isFinite(state.enteredAt)
    && state.enteredAt >= 0;
}

/**
 * 返回当前进程内状态。
 *
 * 返回的是 Map 中的对象，调用方更新 `taskId` 后应调用 `persist` 落盘。
 */
export function getShellCollabState(sessionId: string): ShellCollabState | undefined {
  return shellCollabBySession.get(sessionId);
}

/**
 * 切换会话的 Shell 协作标记并立即持久化。
 *
 * 重复进入为幂等操作：保留首次进入时间和已有 PTY taskId。
 */
export async function setShellCollabActive(
  sessionId: string,
  active: boolean,
  sessionsDir?: string,
): Promise<ShellCollabState> {
  const existing = shellCollabBySession.get(sessionId);
  // Shell 协作是会话创建后的单向能力：一旦进入，只能通过删除会话清理。
  // 保留 active 参数是为了兼容现有调用/测试，但禁止 true → false 回退。
  if (!active && existing?.active === true) {
    return existing;
  }
  const state: ShellCollabState = active
    ? {
        active: true,
        taskId: existing?.taskId ?? null,
        enteredAt: existing?.enteredAt || Date.now(),
      }
    : {
        active: false,
        taskId: null,
        enteredAt: existing?.enteredAt ?? 0,
      };

  shellCollabBySession.set(sessionId, state);
  await persist(sessionId, sessionsDir);
  return state;
}

/** 将当前进程内状态写入 session sidecar；无状态时删除遗留 sidecar。 */
export async function persist(sessionId: string, sessionsDir?: string): Promise<void> {
  const file = sidecarPath(sessionId, sessionsDir);
  const state = shellCollabBySession.get(sessionId);
  if (!state) {
    await fs.unlink(file).catch(() => {});
    return;
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempFile, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tempFile, file);
  } catch (error) {
    await fs.unlink(tempFile).catch(() => {});
    throw error;
  }
}

/**
 * 从 sidecar 恢复指定会话。
 *
 * 文件缺失或内容无效均视为未启用，且会清除可能存在的旧内存状态。
 */
export async function loadForSession(
  sessionId: string,
  sessionsDir?: string,
): Promise<ShellCollabState | undefined> {
  try {
    const raw = await fs.readFile(sidecarPath(sessionId, sessionsDir), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isShellCollabState(parsed)) {
      shellCollabBySession.delete(sessionId);
      return undefined;
    }
    shellCollabBySession.set(sessionId, parsed);
    return parsed;
  } catch {
    shellCollabBySession.delete(sessionId);
    return undefined;
  }
}

/** 清除进程内状态及持久化 sidecar。 */
export async function clearShellCollab(
  sessionId: string,
  sessionsDir?: string,
): Promise<void> {
  shellCollabBySession.delete(sessionId);
  await fs.unlink(sidecarPath(sessionId, sessionsDir)).catch(() => {});
}

/** 批量读取各 session 的 Shell 协作标记（用于 session 列表 / connected 载荷）。 */
export async function buildShellCollabActiveIndex(
  sessionIds: string[],
  sessionsDir?: string,
): Promise<Record<string, boolean>> {
  const index: Record<string, boolean> = {};
  await Promise.all(sessionIds.map(async (sessionId) => {
    const state = await loadForSession(sessionId, sessionsDir);
    if (state?.active === true) {
      index[sessionId] = true;
    }
  }));
  return index;
}

/** 读取单个 session 的 Shell 协作是否 active（含 sidecar 恢复）。 */
export async function resolveShellCollabActive(
  sessionId: string,
  sessionsDir?: string,
): Promise<boolean> {
  const state = await loadForSession(sessionId, sessionsDir);
  return state?.active === true;
}

/** 仅供测试模拟进程重启；不触碰磁盘。 */
export function resetShellCollabStoreForTests(): void {
  shellCollabBySession.clear();
}
