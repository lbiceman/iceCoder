/**
 * chat-ws 后台任务：pusher 绑定、磁盘同步、UI 终止。
 */

import type { WebSocket } from 'ws';
import { formatFriendlyError } from '../cli/friendly-errors.js';
import { syncSessionBgTasksFromManager } from '../session/bg-tasks-store.js';
import {
  findBackgroundTaskManagerOwning,
  getBackgroundTaskManagerFor,
} from '../tools/background-task-manager.js';
import { BgTaskPusher, type BgTaskUpdateEntry } from './bg-task-pusher.js';
import {
  broadcastBgTaskJson,
  getSubscribedSessionId,
  sendJSON,
} from './chat-ws-broadcast.js';
import {
  DEFAULT_WORK_DIR,
  SESSIONS_DIR,
  resolveSessionWorkspacePayload,
} from './chat-ws-runtime.js';

let bgTaskPusher: BgTaskPusher | null = null;

/** UI 心跳间隔（比 LLM 摘要 5min 更密，便于聊天区看到 running 状态） */
const BG_TASK_UI_PUSH_INTERVAL_MS = 30_000;

const bgTasksDiskSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const bgTasksDiskSyncHandlers = new Map<string, () => void>();

export function ensureBgTaskPusher(): BgTaskPusher {
  if (!bgTaskPusher) {
    bgTaskPusher = new BgTaskPusher(broadcastBgTaskJson, {
      intervalMs: BG_TASK_UI_PUSH_INTERVAL_MS,
    });
  }
  return bgTaskPusher;
}

export function scheduleSessionBgTasksDiskSync(sessionId: string, workDir: string): void {
  const existing = bgTasksDiskSyncTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  bgTasksDiskSyncTimers.set(
    sessionId,
    setTimeout(() => {
      bgTasksDiskSyncTimers.delete(sessionId);
      void syncSessionBgTasksFromManager(SESSIONS_DIR, sessionId, workDir).catch(() => {});
    }, 250),
  );
}

export function wireBgTasksDiskSync(
  mgr: ReturnType<typeof getBackgroundTaskManagerFor>,
  sessionId: string,
  workDir: string,
): void {
  const prev = bgTasksDiskSyncHandlers.get(sessionId);
  if (prev) mgr.off('taskStatusChanged', prev);
  const handler = () => scheduleSessionBgTasksDiskSync(sessionId, workDir);
  bgTasksDiskSyncHandlers.set(sessionId, handler);
  mgr.on('taskStatusChanged', handler);
}

export function unwireBgTasksDiskSync(sessionId: string): void {
  const timer = bgTasksDiskSyncTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    bgTasksDiskSyncTimers.delete(sessionId);
  }
  bgTasksDiskSyncHandlers.delete(sessionId);
}

/** 将推送器绑定到指定 session 的后台任务管理器（切换会话 / 开跑前调用） */
export async function rebindBgTaskPusher(sessionId: string): Promise<void> {
  const workspace = await resolveSessionWorkspacePayload(sessionId);
  const workDir = workspace.workspaceRoot ?? DEFAULT_WORK_DIR;
  const mgr = getBackgroundTaskManagerFor(sessionId, workDir);
  wireBgTasksDiskSync(mgr, sessionId, workDir);
  ensureBgTaskPusher().attach(mgr);
  ensureBgTaskPusher().tick();
  await syncSessionBgTasksFromManager(SESSIONS_DIR, sessionId, workDir);
}

/** connected / session_switched 附带的后台任务快照 */
export async function buildBgTasksForSession(sessionId: string): Promise<BgTaskUpdateEntry[]> {
  try {
    const workspace = await resolveSessionWorkspacePayload(sessionId);
    const workDir = workspace.workspaceRoot ?? DEFAULT_WORK_DIR;
    return await syncSessionBgTasksFromManager(SESSIONS_DIR, sessionId, workDir);
  } catch {
    return [];
  }
}

/** 用户从 UI 终止后台任务（bg task chip 关闭按钮） */
export async function handleBgTaskStop(
  ws: WebSocket,
  taskId: string,
  fallbackSessionId: string,
): Promise<void> {
  const sid = getSubscribedSessionId(ws) || fallbackSessionId;
  console.log(`[chat-ws] 收到 bg_task_stop taskId=${taskId || '(empty)'} wsSession=${sid}`);

  if (!taskId) {
    sendJSON(ws, { type: 'bg_task_stop_result', ok: false, error: 'missing taskId' });
    return;
  }
  try {
    const workspace = await resolveSessionWorkspacePayload(sid);
    const workDir = workspace.workspaceRoot ?? DEFAULT_WORK_DIR;
    let mgr = getBackgroundTaskManagerFor(sid, workDir);
    let ok = mgr.kill(taskId);
    if (!ok) {
      const owner = findBackgroundTaskManagerOwning(taskId);
      if (owner) {
        console.log(
          `[chat-ws] bg_task_stop 在 session=${owner.sessionId} 找到任务（WS session=${sid}）`,
        );
        mgr = owner;
        ensureBgTaskPusher().attach(mgr);
        ok = mgr.kill(taskId);
      }
    } else {
      ensureBgTaskPusher().attach(mgr);
    }
    if (!ok) {
      console.warn(`[chat-ws] 终止后台任务失败 ${taskId} session=${sid}（未找到或已结束）`);
      sendJSON(ws, {
        type: 'bg_task_stop_result',
        ok: false,
        taskId,
        sessionId: sid,
        error: 'Task not found or not running',
      });
      return;
    }
    const stopped = mgr.getStatus(taskId);
    console.log(
      `[chat-ws] 用户终止后台任务 ${taskId}${stopped?.label ? ` (${stopped.label})` : ''} session=${mgr.sessionId}`,
    );
    ensureBgTaskPusher().tick();
    const syncWorkspace = await resolveSessionWorkspacePayload(mgr.sessionId);
    const syncWorkDir = syncWorkspace.workspaceRoot ?? DEFAULT_WORK_DIR;
    await syncSessionBgTasksFromManager(SESSIONS_DIR, mgr.sessionId, syncWorkDir);
    sendJSON(ws, { type: 'bg_task_stop_result', ok: true, taskId, sessionId: mgr.sessionId });
  } catch (err) {
    console.error('[chat-ws] bg_task_stop 异常:', err);
    sendJSON(ws, {
      type: 'bg_task_stop_result',
      ok: false,
      taskId,
      error: formatFriendlyError(err),
    });
  }
}

export function detachBgTaskPusher(): void {
  if (bgTaskPusher) {
    bgTaskPusher.detach();
    bgTaskPusher = null;
  }
}
