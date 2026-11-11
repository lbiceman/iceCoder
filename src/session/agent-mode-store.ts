/**
 * 会话当前启用的用户 Agent。
 *
 * 内存 Map 是进程内权威状态；`{sessionId}.agent-mode.json` 在重启后恢复。
 * 同一会话同时只有一个 Agent。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AgentModeState {
  active: boolean;
  agentId: string;
  name: string;
  enteredAt: number;
}

const agentModeBySession = new Map<string, AgentModeState>();

function resolveSessionsDir(sessionsDir?: string): string {
  const resolved = sessionsDir ?? process.env.ICE_SESSIONS_DIR;
  if (!resolved) throw new Error('ICE_SESSIONS_DIR is required for agent mode persistence');
  return path.resolve(resolved);
}

function sidecarPath(sessionId: string, sessionsDir?: string): string {
  if (!sessionId || path.basename(sessionId) !== sessionId) {
    throw new Error('invalid session id');
  }
  return path.join(resolveSessionsDir(sessionsDir), `${sessionId}.agent-mode.json`);
}

function isAgentModeState(value: unknown): value is AgentModeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.active === true
    && typeof state.agentId === 'string'
    && state.agentId.length > 0
    && typeof state.name === 'string'
    && typeof state.enteredAt === 'number'
    && Number.isFinite(state.enteredAt)
    && state.enteredAt >= 0;
}

export function getAgentModeState(sessionId: string): AgentModeState | undefined {
  return agentModeBySession.get(sessionId);
}

export async function persistAgentMode(sessionId: string, sessionsDir?: string): Promise<void> {
  const file = sidecarPath(sessionId, sessionsDir);
  const state = agentModeBySession.get(sessionId);
  if (!state?.active) {
    agentModeBySession.delete(sessionId);
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

/** `agent` 为空时退出。重复进入同一个 Agent 保留首次进入时间。 */
export async function setAgentMode(
  sessionId: string,
  agent: { id: string; name: string } | null,
  sessionsDir?: string,
): Promise<AgentModeState> {
  if (!agent) {
    const existing = agentModeBySession.get(sessionId);
    await fs.unlink(sidecarPath(sessionId, sessionsDir)).catch(() => {});
    agentModeBySession.delete(sessionId);
    return {
      active: false,
      agentId: existing?.agentId ?? '',
      name: existing?.name ?? '',
      enteredAt: existing?.enteredAt ?? 0,
    };
  }

  const existing = agentModeBySession.get(sessionId);
  const same = existing?.active === true && existing.agentId === agent.id;
  const state: AgentModeState = {
    active: true,
    agentId: agent.id,
    name: agent.name,
    enteredAt: same ? existing.enteredAt : Date.now(),
  };
  agentModeBySession.set(sessionId, state);
  await persistAgentMode(sessionId, sessionsDir);
  return state;
}

export async function loadAgentModeForSession(
  sessionId: string,
  sessionsDir?: string,
): Promise<AgentModeState | undefined> {
  const cached = agentModeBySession.get(sessionId);
  if (cached?.active) return cached;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(sidecarPath(sessionId, sessionsDir), 'utf-8'));
    if (!isAgentModeState(parsed)) return undefined;
    agentModeBySession.set(sessionId, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

export async function clearAgentMode(sessionId: string, sessionsDir?: string): Promise<void> {
  await fs.unlink(sidecarPath(sessionId, sessionsDir)).catch(() => {});
  agentModeBySession.delete(sessionId);
}

export async function buildAgentModeIndex(
  sessionIds: string[],
  sessionsDir?: string,
): Promise<Record<string, { id: string; name: string }>> {
  const index: Record<string, { id: string; name: string }> = {};
  await Promise.all(sessionIds.map(async (sessionId) => {
    const state = await loadAgentModeForSession(sessionId, sessionsDir);
    if (state?.active) index[sessionId] = { id: state.agentId, name: state.name };
  }));
  return index;
}

export function resetAgentModeStoreForTests(): void {
  agentModeBySession.clear();
}
