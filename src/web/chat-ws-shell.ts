/**
 * chat-ws Shell 协作：/shell 入站路由与 connected 载荷 extras。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  getShellCollabState,
  setShellCollabActive,
  buildShellCollabActiveIndex,
  loadForSession,
} from '../session/shell-collab-store.js';
import { getInteractiveShellManagerFor } from '../tools/interactive-shell-manager.js';
import { applyFirstPromptSessionTitle } from './session-title.js';
import { buildUserMessageDisplayFields } from './user-message-display.js';
import {
  broadcastSessionUpdated,
  broadcastToSession,
  sendJSON,
} from './chat-ws-broadcast.js';
import { appendMessages, buildEnqueueInput } from './chat-ws-persist.js';
import { hasBusySessionRun } from './chat-ws-running-turn.js';
import {
  DEFAULT_WORK_DIR,
  SESSIONS_DIR,
  getActiveSessionId,
  resolveSessionWorkspacePayload,
} from './chat-ws-runtime.js';

export const SHELL_COLLAB_ENTERED_MESSAGE =
  '当前会话已进入 Shell 协作模式（只需 /shell 一次）。后续直接说话即可，无需再带 /shell。';
export const SHELL_COLLAB_ALREADY_ACTIVE_MESSAGE = '已在 Shell 协作模式。';
export const SHELL_COLLAB_EXIT_DISABLED_MESSAGE =
  'Shell 协作模式已固定到当前会话，不能退出；如需普通 Agent，请新建会话。';
export const SHELL_COLLAB_BUSY_ENTER_MESSAGE =
  '当前会话仍有任务运行，不能切换为 Shell 协作模式；请等待任务结束后重试 /shell。';

const shellCollabTransitions = new Map<string, Promise<void>>();

export function queueShellCollabTransition(sessionId: string, operation: () => Promise<void>): Promise<void> {
  const previous = shellCollabTransitions.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  shellCollabTransitions.set(sessionId, current);
  const cleanup = () => {
    if (shellCollabTransitions.get(sessionId) === current) {
      shellCollabTransitions.delete(sessionId);
    }
  };
  void current.then(cleanup, cleanup);
  return current;
}

export async function waitForShellCollabTransition(sessionId: string): Promise<void> {
  await shellCollabTransitions.get(sessionId)?.catch(() => {});
}

const SESSION_INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

async function readSessionIdsFromIndex(): Promise<string[]> {
  const fallback = getActiveSessionId();
  try {
    const raw = await fsPromises.readFile(SESSION_INDEX_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [fallback];
    const ids = parsed
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: string }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return ids.length > 0 ? ids : [fallback];
  } catch {
    return [fallback];
  }
}

export async function buildShellCollabWsExtras(sessionId: string): Promise<{
  shellCollabActive: boolean;
  shellCollabActiveBySession: Record<string, boolean>;
}> {
  const sessionIds = await readSessionIdsFromIndex();
  const ids = sessionIds.includes(sessionId) ? sessionIds : [...sessionIds, sessionId];
  const shellCollabActiveBySession = await buildShellCollabActiveIndex(ids, SESSIONS_DIR);
  return {
    shellCollabActive: shellCollabActiveBySession[sessionId] === true,
    shellCollabActiveBySession,
  };
}

async function findRunningInteractiveShellForSession(sessionId: string) {
  const workspace = await resolveSessionWorkspacePayload(sessionId);
  const workDir = workspace.workspaceRoot ?? DEFAULT_WORK_DIR;
  const mgr = getInteractiveShellManagerFor(sessionId, workDir);
  return mgr.listForSession().find((task) => task.status === 'running') ?? null;
}

/** @returns 是否完成模式切换（busy 拒绝进入时为 false） */
export async function handleShellCollabRoute(
  ws: WebSocket,
  sessionId: string,
  action: 'enter' | 'exit',
  rawContent: string,
  clientMessageId?: string,
  prompt: string = '',
  referencePaths: string[] = [],
  skills: string[] = [],
  images: string[] = [],
): Promise<boolean> {
  // 进程重启后内存 Map 为空，须先从 sidecar 恢复再判断 active（T15/T16 幂等）。
  await loadForSession(sessionId, SESSIONS_DIR);

  const now = Date.now();
  const userMsgId = clientMessageId ?? randomUUID();
  const trimmedPrompt = String(prompt || '').trim();
  let resolvedReferencePaths = referencePaths.slice();
  let resolvedSkills = skills.slice();
  let uiImageUrls: string[] = [];
  if (action === 'enter' && images.length > 0) {
    const taskInput = await buildEnqueueInput(
      sessionId,
      rawContent,
      images,
      resolvedReferencePaths,
      userMsgId,
      'implicit',
      resolvedSkills,
    );
    uiImageUrls = taskInput.images ?? [];
    resolvedReferencePaths = taskInput.referencePaths ?? resolvedReferencePaths;
    resolvedSkills = taskInput.skills ?? resolvedSkills;
  }
  const display = buildUserMessageDisplayFields(rawContent, resolvedReferencePaths, resolvedSkills);
  const userMessage = action === 'enter'
    ? {
        role: 'user' as const,
        content: display.content,
        id: userMsgId,
        sentAt: now,
        ...(display.shellCommand ? { shellCommand: display.shellCommand } : {}),
        ...(display.openCommand ? { openCommand: display.openCommand } : {}),
        ...(display.skills ? { skills: display.skills } : {}),
        ...(display.referencePaths ? { referencePaths: display.referencePaths } : {}),
        ...(uiImageUrls.length > 0 ? { images: uiImageUrls } : {}),
      }
    : {
        role: 'user' as const,
        content: rawContent.trim(),
        id: userMsgId,
        sentAt: now,
      };

  if (action === 'exit') {
    await appendMessages([userMessage], sessionId);
    broadcastToSession(sessionId, {
      type: 'user_message_appended',
      sessionId,
      message: userMessage,
    });
    sendJSON(ws, { type: 'info', sessionId, message: SHELL_COLLAB_EXIT_DISABLED_MESSAGE });
    return true;
  }

  const wasActive = getShellCollabState(sessionId)?.active === true;
  if (!wasActive && hasBusySessionRun(sessionId)) {
    sendJSON(ws, { type: 'info', sessionId, message: SHELL_COLLAB_BUSY_ENTER_MESSAGE });
    return false;
  }
  await setShellCollabActive(sessionId, true, SESSIONS_DIR);
  const runningTask = await findRunningInteractiveShellForSession(sessionId);

  // 已在模式且带提示词：只写用户气泡，跳过「已在模式中」，提示词交给后续入队执行。
  const skipAlreadyActiveBubble = wasActive && !!trimmedPrompt;
  const agentMessage = skipAlreadyActiveBubble
    ? null
    : {
        role: 'agent' as const,
        content: wasActive ? SHELL_COLLAB_ALREADY_ACTIVE_MESSAGE : SHELL_COLLAB_ENTERED_MESSAGE,
        id: randomUUID(),
        completedAt: now,
      };

  await appendMessages(
    agentMessage ? [userMessage, agentMessage] : [userMessage],
    sessionId,
  );
  broadcastToSession(sessionId, {
    type: 'user_message_appended',
    sessionId,
    message: userMessage,
  });

  if (trimmedPrompt) {
    const autoTitle = await applyFirstPromptSessionTitle(sessionId, trimmedPrompt);
    broadcastSessionUpdated(
      'user_message',
      autoTitle ? { sessionId, title: autoTitle } : { sessionId },
      ws,
    );
  }

  if (wasActive) {
    if (!skipAlreadyActiveBubble) {
      sendJSON(ws, { type: 'info', sessionId, message: SHELL_COLLAB_ALREADY_ACTIVE_MESSAGE });
    }
    broadcastToSession(sessionId, {
      type: 'shell_collab_entered',
      sessionId,
      sticky: true,
      shellCollabActive: true,
      idempotent: true,
    });
  } else if (agentMessage) {
    broadcastToSession(sessionId, {
      type: 'shell_collab_entered',
      sessionId,
      sticky: true,
      shellCollabActive: true,
      message: agentMessage,
    });
  }

  if (runningTask) {
    broadcastToSession(sessionId, {
      type: 'shell_collab_resumed',
      sessionId,
      taskId: runningTask.taskId,
      status: runningTask.status,
    });
  }

  console.log(
    `[chat-ws] /shell enter session=${sessionId.slice(0, 8)} `
    + `wasActive=${wasActive} resumed=${runningTask?.taskId ?? 'none'} `
    + `prompt=${trimmedPrompt ? 'yes' : 'no'}`,
  );
  return true;
}
