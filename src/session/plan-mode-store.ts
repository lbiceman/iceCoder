/**
 * 会话级规划模式状态。
 *
 * 内存 Map 是进程内的权威状态；`{sessionId}.plan-mode.json` sidecar
 * 用于服务重启、页面刷新或重连后恢复。与 Shell 协作不同：允许退出。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface PlanModeState {
  active: boolean;
  enteredAt: number;
}

const planModeBySession = new Map<string, PlanModeState>();

function resolveSessionsDir(sessionsDir?: string): string {
  const resolved = sessionsDir ?? process.env.ICE_SESSIONS_DIR;
  if (!resolved) {
    throw new Error('ICE_SESSIONS_DIR is required for plan mode persistence');
  }
  return path.resolve(resolved);
}

function sidecarPath(sessionId: string, sessionsDir?: string): string {
  if (!sessionId || path.basename(sessionId) !== sessionId) {
    throw new Error('invalid session id');
  }
  return path.join(resolveSessionsDir(sessionsDir), `${sessionId}.plan-mode.json`);
}

function isPlanModeState(value: unknown): value is PlanModeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return typeof state.active === 'boolean'
    && typeof state.enteredAt === 'number'
    && Number.isFinite(state.enteredAt)
    && state.enteredAt >= 0;
}

/** 返回当前进程内状态。 */
export function getPlanModeState(sessionId: string): PlanModeState | undefined {
  return planModeBySession.get(sessionId);
}

/** 将当前进程内状态写入 session sidecar；无状态或已退出时删除 sidecar。 */
export async function persistPlanMode(sessionId: string, sessionsDir?: string): Promise<void> {
  const file = sidecarPath(sessionId, sessionsDir);
  const state = planModeBySession.get(sessionId);
  if (!state || !state.active) {
    planModeBySession.delete(sessionId);
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
 * 切换会话的规划模式并立即持久化。
 * 重复进入为幂等：保留首次进入时间。允许 true → false 退出。
 */
export async function setPlanModeActive(
  sessionId: string,
  active: boolean,
  sessionsDir?: string,
): Promise<PlanModeState> {
  if (!active) {
    const existing = planModeBySession.get(sessionId);
    // 先删 sidecar 再清内存，避免并发 load 读到旧文件又把模式恢复回去。
    await fs.unlink(sidecarPath(sessionId, sessionsDir)).catch(() => {});
    planModeBySession.delete(sessionId);
    return {
      active: false,
      enteredAt: existing?.enteredAt ?? 0,
    };
  }

  const existing = planModeBySession.get(sessionId);
  const state: PlanModeState = {
    active: true,
    enteredAt: existing?.enteredAt || Date.now(),
  };
  planModeBySession.set(sessionId, state);
  await persistPlanMode(sessionId, sessionsDir);
  return state;
}

/**
 * 从 sidecar 恢复指定会话。
 * 内存里已是 active 时直接返回，避免并发读到缺失文件时把模式清掉。
 */
export async function loadPlanModeForSession(
  sessionId: string,
  sessionsDir?: string,
): Promise<PlanModeState | undefined> {
  const cached = planModeBySession.get(sessionId);
  if (cached?.active) return cached;
  try {
    const raw = await fs.readFile(sidecarPath(sessionId, sessionsDir), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isPlanModeState(parsed) || !parsed.active) {
      return undefined;
    }
    planModeBySession.set(sessionId, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

/** 清除进程内状态及持久化 sidecar。 */
export async function clearPlanMode(
  sessionId: string,
  sessionsDir?: string,
): Promise<void> {
  await fs.unlink(sidecarPath(sessionId, sessionsDir)).catch(() => {});
  planModeBySession.delete(sessionId);
}

/** 批量读取各 session 的规划模式标记（用于 session 列表 / connected 载荷）。 */
export async function buildPlanModeActiveIndex(
  sessionIds: string[],
  sessionsDir?: string,
): Promise<Record<string, boolean>> {
  const index: Record<string, boolean> = {};
  await Promise.all(sessionIds.map(async (sessionId) => {
    const state = await loadPlanModeForSession(sessionId, sessionsDir);
    if (state?.active === true) {
      index[sessionId] = true;
    }
  }));
  return index;
}

/** 读取单个 session 的规划模式是否 active（含 sidecar 恢复）。 */
export async function resolvePlanModeActive(
  sessionId: string,
  sessionsDir?: string,
): Promise<boolean> {
  const state = await loadPlanModeForSession(sessionId, sessionsDir);
  return state?.active === true;
}

/** 仅供测试模拟进程重启；不触碰磁盘。 */
export function resetPlanModeStoreForTests(): void {
  planModeBySession.clear();
}
