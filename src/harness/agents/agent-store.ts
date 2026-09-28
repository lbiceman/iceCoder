/**
 * 子 Agent 记录：`{sessionsDir}/{parentSessionId}/agents/`
 *
 * - `{agentId}.meta.json`：类型、描述、prompt、归属消息、状态、统计、最终报告
 * - `agent-{agentId}.structured.json`：子 Harness 的完整结构化消息
 * - 子 Harness 自身的 checkpoint / 遥测文件（sessionId = `agent-{agentId}`）
 *
 * 该目录位于父会话目录内，删除会话时随现有清理一起删除。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { UnifiedMessage } from '../../llm/types.js';
import type {
  AgentCommandConflict,
  AgentCommandRecord,
  AgentFileChange,
  AgentLeaseReject,
  AgentView,
} from './agent-result.js';

export interface AgentMetaRecord extends AgentView {
  parentSessionId: string;
  childSessionId: string;
  prompt: string;
  report?: string;
  statusReason?: string;
  fileChangeDetails?: AgentFileChange[];
  commandRecords?: AgentCommandRecord[];
  leaseRejectRecords?: AgentLeaseReject[];
  commandConflicts?: AgentCommandConflict[];
  updatedAt: number;
}

export function agentsDirFor(sessionsDir: string, parentSessionId: string): string {
  return path.join(sessionsDir, parentSessionId, 'agents');
}

export function childSessionIdFor(agentId: string): string {
  return `agent-${agentId}`;
}

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_RE.test(agentId);
}

function metaPath(sessionsDir: string, parentSessionId: string, agentId: string): string {
  return path.join(agentsDirFor(sessionsDir, parentSessionId), `${agentId}.meta.json`);
}

function messagesPath(sessionsDir: string, parentSessionId: string, agentId: string): string {
  return path.join(
    agentsDirFor(sessionsDir, parentSessionId),
    `${childSessionIdFor(agentId)}.structured.json`,
  );
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf-8');
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function saveAgentMeta(sessionsDir: string, meta: AgentMetaRecord): Promise<void> {
  if (!isValidAgentId(meta.agentId)) return;
  await writeJsonAtomic(metaPath(sessionsDir, meta.parentSessionId, meta.agentId), meta);
}

export async function saveAgentMessages(
  sessionsDir: string,
  parentSessionId: string,
  agentId: string,
  messages: UnifiedMessage[],
): Promise<void> {
  if (!isValidAgentId(agentId)) return;
  await writeJsonAtomic(messagesPath(sessionsDir, parentSessionId, agentId), messages);
}

export function agentMessagesPath(sessionsDir: string, parentSessionId: string, agentId: string): string {
  return messagesPath(sessionsDir, parentSessionId, agentId);
}

export async function loadAgentMeta(
  sessionsDir: string,
  parentSessionId: string,
  agentId: string,
): Promise<AgentMetaRecord | null> {
  if (!isValidAgentId(agentId)) return null;
  return readJson<AgentMetaRecord>(metaPath(sessionsDir, parentSessionId, agentId));
}

export async function loadAgentMessages(
  sessionsDir: string,
  parentSessionId: string,
  agentId: string,
): Promise<UnifiedMessage[] | null> {
  if (!isValidAgentId(agentId)) return null;
  const parsed = await readJson<unknown>(messagesPath(sessionsDir, parentSessionId, agentId));
  return Array.isArray(parsed) ? parsed as UnifiedMessage[] : null;
}

export async function listAgentMetas(
  sessionsDir: string,
  parentSessionId: string,
): Promise<AgentMetaRecord[]> {
  const dir = agentsDirFor(sessionsDir, parentSessionId);
  const names = await fs.readdir(dir).catch((): string[] => []);
  const out: AgentMetaRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    const meta = await readJson<AgentMetaRecord>(path.join(dir, name));
    if (meta?.agentId) out.push(meta);
  }
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** 删除一个子 Agent 的全部文件（meta、结构化消息、子 Harness 的 checkpoint / 遥测）。 */
async function deleteAgentFiles(dir: string, agentId: string): Promise<void> {
  const names = await fs.readdir(dir).catch((): string[] => []);
  const prefixes = [`${agentId}.`, `${childSessionIdFor(agentId)}.`];
  await Promise.all(names
    .filter(name => prefixes.some(p => name.startsWith(p)) || name === childSessionIdFor(agentId))
    .map(name => fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined)));
}

/** 删除 messageId 属于给定集合的子 Agent 记录；返回被删除的 agentId。 */
export async function deleteAgentRecordsForMessages(
  sessionsDir: string,
  parentSessionId: string,
  messageIds: readonly string[],
): Promise<string[]> {
  const targets = new Set(messageIds.filter(Boolean));
  if (targets.size === 0) return [];
  const dir = agentsDirFor(sessionsDir, parentSessionId);
  const metas = await listAgentMetas(sessionsDir, parentSessionId);
  const removed: string[] = [];
  for (const meta of metas) {
    if (!targets.has(meta.messageId)) continue;
    await deleteAgentFiles(dir, meta.agentId);
    removed.push(meta.agentId);
  }
  return removed;
}

export function toAgentView(meta: AgentMetaRecord): AgentView {
  return {
    agentId: meta.agentId,
    parentToolCallId: meta.parentToolCallId,
    messageId: meta.messageId,
    type: meta.type,
    description: meta.description,
    status: meta.status,
    ...(meta.startedAt !== undefined ? { startedAt: meta.startedAt } : {}),
    ...(meta.finishedAt !== undefined ? { finishedAt: meta.finishedAt } : {}),
    rounds: meta.rounds,
    toolCalls: meta.toolCalls,
    tokens: meta.tokens,
    filesChanged: meta.filesChanged ?? [],
    commands: meta.commands ?? [],
    leaseRejects: meta.leaseRejects ?? 0,
    ...(meta.currentActivity ? { currentActivity: meta.currentActivity } : {}),
    ...(meta.reportPreview ? { reportPreview: meta.reportPreview } : {}),
    ...(meta.error ? { error: meta.error } : {}),
    ...(meta.interrupted ? { interrupted: true } : {}),
  };
}

/** 磁盘上仍为 queued/running、但当前进程并未在跑的记录：进程在子 Agent 运行中退出。 */
export function normalizeInterruptedAgentMeta(
  meta: AgentMetaRecord,
  isLive: (agentId: string) => boolean,
): AgentMetaRecord {
  if ((meta.status === 'running' || meta.status === 'queued') && !isLive(meta.agentId)) {
    return { ...meta, status: 'cancelled', interrupted: true };
  }
  return meta;
}
