/**
 * chat-ws 规划模式：/plan 入站路由、plan_mode_exit，以及 connected 载荷 extras。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  getPlanModeState,
  setPlanModeActive,
  buildPlanModeActiveIndex,
  loadPlanModeForSession,
} from '../session/plan-mode-store.js';
import { resolveShellCollabActive } from '../session/shell-collab-store.js';
import { applyFirstPromptSessionTitle } from './session-title.js';
import { buildUserMessageDisplayFields } from './user-message-display.js';
import {
  broadcastSessionUpdated,
  broadcastToSession,
  sendJSON,
} from './chat-ws-broadcast.js';
import { appendMessages, buildEnqueueInput } from './chat-ws-persist.js';
import {
  SESSIONS_DIR,
  getActiveSessionId,
} from './chat-ws-runtime.js';

export const PLAN_MODE_ENTERED_MESSAGE =
  '已进入规划模式。此模式只能阅读代码并编写/完善文档（.md/.txt 等），不能改代码、执行命令或使用 MCP。\n\n'
  + '请一起把方案写清楚：目标、现状缺口、实施步骤、验收标准。信息不够时我会先提问。写完后点上方 Plan 芯片的 × 退出，再让我按文档实现。';
export const PLAN_MODE_ALREADY_ACTIVE_MESSAGE = '已在规划模式。继续完善文档即可；写完后点上方 Plan 芯片的 × 退出。';
export const PLAN_MODE_EXITED_MESSAGE = '已退出规划模式。现在可以改代码、执行命令。';
export const PLAN_MODE_NOT_ACTIVE_MESSAGE = '当前不是规划模式。';
export const PLAN_MODE_SHELL_BLOCKED_MESSAGE =
  '当前会话已在 Shell 协作模式，不能进入规划模式；请新建会话。';

const planModeTransitions = new Map<string, Promise<void>>();

export function queuePlanModeTransition(sessionId: string, operation: () => Promise<void>): Promise<void> {
  const previous = planModeTransitions.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  planModeTransitions.set(sessionId, current);
  const cleanup = () => {
    if (planModeTransitions.get(sessionId) === current) {
      planModeTransitions.delete(sessionId);
    }
  };
  void current.then(cleanup, cleanup);
  return current;
}

export async function waitForPlanModeTransition(sessionId: string): Promise<void> {
  await planModeTransitions.get(sessionId)?.catch(() => {});
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

export async function buildPlanModeWsExtras(sessionId: string): Promise<{
  planModeActive: boolean;
  planModeActiveBySession: Record<string, boolean>;
}> {
  const sessionIds = await readSessionIdsFromIndex();
  const ids = sessionIds.includes(sessionId) ? sessionIds : [...sessionIds, sessionId];
  const planModeActiveBySession = await buildPlanModeActiveIndex(ids, SESSIONS_DIR);
  return {
    planModeActive: planModeActiveBySession[sessionId] === true,
    planModeActiveBySession,
  };
}

function buildPlanUserMessage(
  rawContent: string,
  userMsgId: string,
  now: number,
  extras: {
    referencePaths?: string[];
    skills?: string[];
    images?: string[];
  } = {},
) {
  const display = buildUserMessageDisplayFields(
    rawContent,
    extras.referencePaths ?? [],
    extras.skills ?? [],
  );
  return {
    role: 'user' as const,
    content: display.content,
    id: userMsgId,
    sentAt: now,
    ...(display.planCommand ? { planCommand: display.planCommand } : {}),
    ...(display.shellCommand ? { shellCommand: display.shellCommand } : {}),
    ...(display.openCommand ? { openCommand: display.openCommand } : {}),
    ...(display.skills ? { skills: display.skills } : {}),
    ...(display.referencePaths ? { referencePaths: display.referencePaths } : {}),
    ...(extras.images && extras.images.length > 0 ? { images: extras.images } : {}),
  };
}

/** @returns 是否完成模式切换（Shell 会话拒绝进入时为 false） */
export async function handlePlanModeRoute(
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
  await loadPlanModeForSession(sessionId, SESSIONS_DIR);

  if (action === 'exit') {
    return handlePlanModeExit(ws, sessionId, {
      persistUserMessage: true,
      rawContent,
      clientMessageId,
    });
  }

  if (await resolveShellCollabActive(sessionId, SESSIONS_DIR)) {
    sendJSON(ws, { type: 'info', sessionId, message: PLAN_MODE_SHELL_BLOCKED_MESSAGE });
    return false;
  }

  const now = Date.now();
  const userMsgId = clientMessageId ?? randomUUID();
  const trimmedPrompt = String(prompt || '').trim();
  let resolvedReferencePaths = referencePaths.slice();
  let resolvedSkills = skills.slice();
  let uiImageUrls: string[] = [];
  if (images.length > 0) {
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

  const userMessage = buildPlanUserMessage(rawContent, userMsgId, now, {
    referencePaths: resolvedReferencePaths,
    skills: resolvedSkills,
    images: uiImageUrls,
  });

  const wasActive = getPlanModeState(sessionId)?.active === true;
  await setPlanModeActive(sessionId, true, SESSIONS_DIR);

  const skipAlreadyActiveBubble = wasActive && !!trimmedPrompt;
  const agentMessage = skipAlreadyActiveBubble
    ? null
    : {
        role: 'agent' as const,
        content: wasActive ? PLAN_MODE_ALREADY_ACTIVE_MESSAGE : PLAN_MODE_ENTERED_MESSAGE,
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
      sendJSON(ws, { type: 'info', sessionId, message: PLAN_MODE_ALREADY_ACTIVE_MESSAGE });
    }
    broadcastToSession(sessionId, {
      type: 'plan_mode_entered',
      sessionId,
      planModeActive: true,
      idempotent: true,
    });
  } else if (agentMessage) {
    broadcastToSession(sessionId, {
      type: 'plan_mode_entered',
      sessionId,
      planModeActive: true,
      message: agentMessage,
    });
  }

  console.log(
    `[chat-ws] /plan enter session=${sessionId.slice(0, 8)} `
    + `wasActive=${wasActive} prompt=${trimmedPrompt ? 'yes' : 'no'}`,
  );
  return true;
}

export async function handlePlanModeExit(
  ws: WebSocket,
  sessionId: string,
  options: {
    persistUserMessage?: boolean;
    rawContent?: string;
    clientMessageId?: string;
  } = {},
): Promise<boolean> {
  await loadPlanModeForSession(sessionId, SESSIONS_DIR);
  const now = Date.now();
  const wasActive = getPlanModeState(sessionId)?.active === true;

  const userMessage = options.persistUserMessage
    ? buildPlanUserMessage(
        options.rawContent ?? '/plan exit',
        options.clientMessageId ?? randomUUID(),
        now,
      )
    : null;

  if (!wasActive) {
    if (userMessage) {
      await appendMessages([userMessage], sessionId);
      broadcastToSession(sessionId, {
        type: 'user_message_appended',
        sessionId,
        message: userMessage,
      });
    }
    sendJSON(ws, { type: 'info', sessionId, message: PLAN_MODE_NOT_ACTIVE_MESSAGE });
    broadcastToSession(sessionId, {
      type: 'plan_mode_exited',
      sessionId,
      planModeActive: false,
      idempotent: true,
    });
    return true;
  }

  await setPlanModeActive(sessionId, false, SESSIONS_DIR);
  const agentMessage = {
    role: 'agent' as const,
    content: PLAN_MODE_EXITED_MESSAGE,
    id: randomUUID(),
    completedAt: now,
  };
  await appendMessages(
    userMessage ? [userMessage, agentMessage] : [agentMessage],
    sessionId,
  );
  if (userMessage) {
    broadcastToSession(sessionId, {
      type: 'user_message_appended',
      sessionId,
      message: userMessage,
    });
  }
  broadcastToSession(sessionId, {
    type: 'plan_mode_exited',
    sessionId,
    planModeActive: false,
    message: agentMessage,
  });
  console.log(`[chat-ws] /plan exit session=${sessionId.slice(0, 8)}`);
  return true;
}

/** 进入 Shell 协作时清掉规划模式（两模式互斥）。 */
export async function clearPlanModeForShellCollab(sessionId: string): Promise<void> {
  await loadPlanModeForSession(sessionId, SESSIONS_DIR);
  if (getPlanModeState(sessionId)?.active !== true) return;
  await setPlanModeActive(sessionId, false, SESSIONS_DIR);
  broadcastToSession(sessionId, {
    type: 'plan_mode_exited',
    sessionId,
    planModeActive: false,
    reason: 'shell_collab',
  });
}
