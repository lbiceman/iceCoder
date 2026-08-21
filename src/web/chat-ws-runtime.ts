/**
 * chat-ws 进程级运行时状态（叶子模块）。
 * 禁止 import 任何其它 chat-ws-*.ts，以免成环。
 */

import path from 'path';
import { applyRuntimeDataEnvDefaults, getDefaultWorkDir } from '../cli/paths.js';
import {
  beginSessionHarnessRun,
  endSessionHarnessRun,
} from '../harness/harness-runtime-registry.js';
import { loadHarnessSupervisorRuntime } from '../harness/supervisor/supervisor-config.js';
import { registerSupervisorRuntimeReset } from '../harness/supervisor/supervisor-runtime-cache.js';
import { resolveEffectiveWorkspaceRoot } from '../harness/session-workspace-store.js';
import type { UnifiedMessage } from '../llm/types.js';

applyRuntimeDataEnvDefaults();

export const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR!);
export const MEMORY_DIR = path.resolve(process.env.ICE_MEMORY_DIR!);
export const DATA_DIR = path.resolve(process.env.ICE_DATA_DIR!);
export const MAIN_CONFIG_PATH = path.resolve(process.env.ICE_CONFIG_PATH!);
export const DEFAULT_WORK_DIR = getDefaultWorkDir();

let activeSessionId = 'default';

export function getActiveSessionId(): string {
  return activeSessionId;
}

export function setActiveSessionId(id: string): void {
  activeSessionId = id;
}

export function getSessionsDir(): string {
  return SESSIONS_DIR;
}

export function getSessionFile(sessionId: string = getActiveSessionId()): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

export function getStructuredSessionFile(sessionId: string = getActiveSessionId()): string {
  return path.join(SESSIONS_DIR, `${sessionId}.structured.json`);
}

export async function resolveSessionWorkspacePayload(sessionId: string) {
  return resolveEffectiveWorkspaceRoot(SESSIONS_DIR, sessionId, DEFAULT_WORK_DIR);
}

/** 会话级活跃 batch 计数（含排队消息处理中） */
export const sessionActiveBatchCounts = new Map<string, number>();

export function beginSessionBatch(sessionId: string): void {
  sessionActiveBatchCounts.set(sessionId, (sessionActiveBatchCounts.get(sessionId) ?? 0) + 1);
  beginSessionHarnessRun(sessionId);
}

export function endSessionBatch(sessionId: string): void {
  const next = Math.max(0, (sessionActiveBatchCounts.get(sessionId) ?? 0) - 1);
  if (next === 0) sessionActiveBatchCounts.delete(sessionId);
  else sessionActiveBatchCounts.set(sessionId, next);
  endSessionHarnessRun(sessionId);
}

/** F2 — supervisor runtime 进程级缓存：避免每个 WS 连接重复读盘。 */
let supervisorRuntimePromise: ReturnType<typeof loadHarnessSupervisorRuntime> | null = null;

registerSupervisorRuntimeReset(() => {
  supervisorRuntimePromise = null;
});

export function getSupervisorRuntime(): ReturnType<typeof loadHarnessSupervisorRuntime> {
  if (!supervisorRuntimePromise) {
    supervisorRuntimePromise = loadHarnessSupervisorRuntime({
      dataDir: DATA_DIR,
      mainConfigPath: MAIN_CONFIG_PATH,
    });
  }
  return supervisorRuntimePromise;
}

/**
 * 单会话消息缓存（legacy，保留兼容）。
 * 跨轮次累积，包含完整的结构化对话历史（含 toolCalls/toolCallId）。
 * 同时持久化到磁盘，服务重启后自动恢复。
 */
let cachedMessages: UnifiedMessage[] | undefined;

/** 多会话结构化消息缓存 Map<sessionId, UnifiedMessage[]> */
export const structuredCache = new Map<string, UnifiedMessage[]>();

/** 获取指定会话的结构化消息缓存 */
export function getCachedMessages(sessionId: string = getActiveSessionId()): UnifiedMessage[] | undefined {
  return structuredCache.get(sessionId) ?? (sessionId === getActiveSessionId() ? cachedMessages : undefined);
}

/** 设置指定会话的结构化消息缓存 */
export function setCachedMessages(sessionId: string, messages: UnifiedMessage[] | undefined): void {
  if (messages === undefined) {
    structuredCache.delete(sessionId);
  } else {
    structuredCache.set(sessionId, messages);
  }
  if (sessionId === getActiveSessionId()) {
    cachedMessages = messages;
  }
}

/** 每个会话独立的 fileBrowser 状态 */
export interface FileBrowserState {
  active: boolean;
  lastBrowsedPath: string | null;
}
export const fileBrowserStateBySession = new Map<string, FileBrowserState>();

export function getFileBrowserState(sessionId: string = getActiveSessionId()): FileBrowserState {
  let state = fileBrowserStateBySession.get(sessionId);
  if (!state) {
    state = { active: false, lastBrowsedPath: null };
    fileBrowserStateBySession.set(sessionId, state);
  }
  return state;
}

/** 会话级最近成功调用的 deferred 工具名（供 Lazy Tool Offering 粘性） */
export const sessionDeferredToolCalls = new Map<string, string[]>();

export function recordSessionDeferredToolCall(sessionId: string, toolName: string): void {
  const list = sessionDeferredToolCalls.get(sessionId) ?? [];
  if (!list.includes(toolName)) {
    list.push(toolName);
    sessionDeferredToolCalls.set(sessionId, list);
  }
}

export function getSessionDeferredToolCalls(sessionId: string): string[] {
  return sessionDeferredToolCalls.get(sessionId) ?? [];
}

/**
 * 会话级 AbortController（用于用户中断正在执行的任务）。
 * 每次 handleChatMessage 开始时按 runSessionId 登记，结束时移除。
 */
export const sessionAbortControllers = new Map<string, AbortController>();

/** 当前正在运行 harness 的会话集合（跨连接共享，防止同一会话被多标签并发跑两个 harness）。 */
export const sessionProcessing = new Set<string>();

export function abortSession(sessionId: string): boolean {
  const ctrl = sessionAbortControllers.get(sessionId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

export function hasActiveSessionRun(sessionId: string): boolean {
  return sessionAbortControllers.has(sessionId);
}

export function isSessionProcessing(sessionId: string): boolean {
  return sessionProcessing.has(sessionId);
}

export type SessionRunPhase = 'running' | 'done' | 'error' | 'idle';

export interface SessionRunStateEntry {
  sessionId: string;
  phase: Exclude<SessionRunPhase, 'idle'>;
  stopReason?: string;
}

/** 进程内会话运行态（侧栏圆点）。done/error 不落盘，重启后只恢复 running。 */
const runPhaseBySession = new Map<string, { phase: Exclude<SessionRunPhase, 'idle'>; stopReason?: string }>();

export function setSessionRunPhase(
  sessionId: string,
  phase: SessionRunPhase,
  stopReason?: string,
): void {
  if (!sessionId) return;
  if (phase === 'idle') {
    runPhaseBySession.delete(sessionId);
    return;
  }
  runPhaseBySession.set(sessionId, stopReason ? { phase, stopReason } : { phase });
}

export function getSessionRunPhase(sessionId: string): SessionRunPhase {
  if (!sessionId) return 'idle';
  return runPhaseBySession.get(sessionId)?.phase ?? 'idle';
}

/** 侧栏圆点快照：Map 中的非 idle + 仍在 processing 但尚未写入 phase 的会话。 */
export function buildSessionRunStatesSnapshot(): SessionRunStateEntry[] {
  const runStates: SessionRunStateEntry[] = [];
  for (const [sessionId, v] of runPhaseBySession) {
    runStates.push(v.stopReason
      ? { sessionId, phase: v.phase, stopReason: v.stopReason }
      : { sessionId, phase: v.phase });
  }
  const seen = new Set(runStates.map((s) => s.sessionId));
  for (const id of sessionProcessing) {
    if (!seen.has(id)) runStates.push({ sessionId: id, phase: 'running' });
  }
  return runStates;
}

/** 已删除会话 tombstone：阻止异步刷盘在 purge 之后 resurrect 文件 */
export const tombstonedSessionIds = new Set<string>();

export function isSessionTombstoned(sessionId: string): boolean {
  return tombstonedSessionIds.has(sessionId);
}

export function tombstoneSession(sessionId: string): void {
  tombstonedSessionIds.add(sessionId);
}

/** 保存结构化消息到磁盘（防抖，避免频繁写入） */
export const saveTimerMap = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 只清 runtime 自己持有的 Map/Set（不含 abort）。
 * 杀 shell 必须发生在 abort 之前，由 chat-ws.ts 编排。
 */
export function purgeSessionMaps(sessionId: string): void {
  tombstoneSession(sessionId);
  structuredCache.delete(sessionId);
  fileBrowserStateBySession.delete(sessionId);
  sessionDeferredToolCalls.delete(sessionId);
  sessionActiveBatchCounts.delete(sessionId);
  runPhaseBySession.delete(sessionId);
  const pending = saveTimerMap.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    saveTimerMap.delete(sessionId);
  }
  if (sessionId === getActiveSessionId()) {
    cachedMessages = undefined;
  }
}

/** abort harness 并丢掉会话级运行锁。须在 stopAllShellWork 之后调用。 */
export function dropSessionRunLocks(sessionId: string): void {
  abortSession(sessionId);
  sessionAbortControllers.delete(sessionId);
  sessionProcessing.delete(sessionId);
}

export function clearRuntimeOnShutdown(): void {
  for (const ctrl of sessionAbortControllers.values()) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  sessionAbortControllers.clear();
  sessionProcessing.clear();
  runPhaseBySession.clear();
  setCachedMessages(getActiveSessionId(), undefined);
  fileBrowserStateBySession.delete(getActiveSessionId());
}
