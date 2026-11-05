/**
 * 用户 Agent：`/<id>` 进入、`/<id> exit` 退出，以及输入栏芯片的 agent_mode_exit。
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

import { parseAgentCommand, type AgentProfile } from '../agents/agent-profile.js';
import { getAgentsDir, listAgents, readAgent } from '../agents/agent-store.js';
import { isSafeIntentMessageId } from '../harness/intent-checkpoint-store.js';
import { getAgentModeState, loadAgentModeForSession, setAgentMode, buildAgentModeIndex } from '../session/agent-mode-store.js';
import { resolveShellCollabActive } from '../session/shell-collab-store.js';
import { applyFirstPromptSessionTitle } from './session-title.js';
import { buildUserMessageDisplayFields } from './user-message-display.js';
import { broadcastSessionUpdated, broadcastToSession, sendJSON } from './chat-ws-broadcast.js';
import { appendMessages, buildEnqueueInput } from './chat-ws-persist.js';
import { SESSIONS_DIR, getActiveSessionId } from './chat-ws-runtime.js';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

export const AGENT_MODE_SHELL_BLOCKED_MESSAGE = '当前会话已在 Shell 协作模式，不能进入 Agent；请新建会话。';

const transitions = new Map<string, Promise<void>>();

export function queueAgentModeTransition(sessionId: string, operation: () => Promise<void>): Promise<void> {
  const previous = transitions.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  transitions.set(sessionId, current);
  const cleanup = () => {
    if (transitions.get(sessionId) === current) transitions.delete(sessionId);
  };
  void current.then(cleanup, cleanup);
  return current;
}

export async function waitForAgentModeTransition(sessionId: string): Promise<void> {
  await transitions.get(sessionId)?.catch(() => {});
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

export async function buildAgentModeWsExtras(sessionId: string): Promise<{
  agentMode: { id: string; name: string } | null;
  agentModeBySession: Record<string, { id: string; name: string }>;
}> {
  const sessionIds = await readSessionIdsFromIndex();
  const ids = sessionIds.includes(sessionId) ? sessionIds : [...sessionIds, sessionId];
  const agentModeBySession = await buildAgentModeIndex(ids, SESSIONS_DIR);
  return {
    agentMode: agentModeBySession[sessionId] ?? null,
    agentModeBySession,
  };
}

export async function listAgentCommandIds(): Promise<string[]> {
  const agents = await listAgents(getAgentsDir());
  return agents.map((agent) => agent.id);
}

function enteredMessage(name: string, toolCount: number): string {
  const tools = toolCount > 0
    ? `这一会话只会使用你为它勾选的 ${toolCount} 个工具。`
    : '这一会话没有勾选工具，只会根据提示词回答。';
  return `已进入 Agent「${name}」。${tools}\n\n角色提示词优先于技能。点工作区左边芯片的 ×，或发送 /命令 exit 即可退出。`;
}

function buildUserMessage(
  rawContent: string,
  command: string,
  userMsgId: string,
  now: number,
  extras: { referencePaths?: string[]; skills?: string[]; images?: string[] } = {},
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
    agentCommand: command,
    ...(display.skills ? { skills: display.skills } : {}),
    ...(display.referencePaths ? { referencePaths: display.referencePaths } : {}),
    ...(extras.images && extras.images.length > 0 ? { images: extras.images } : {}),
  };
}

export async function handleAgentModeRoute(
  ws: WebSocket,
  sessionId: string,
  action: 'enter' | 'exit',
  agentId: string,
  rawContent: string,
  clientMessageId?: string,
  prompt = '',
  referencePaths: string[] = [],
  skills: string[] = [],
  images: string[] = [],
): Promise<boolean> {
  await loadAgentModeForSession(sessionId, SESSIONS_DIR);
  if (action === 'exit') {
    return handleAgentModeExit(ws, sessionId, {
      persistUserMessage: true,
      rawContent,
      clientMessageId,
      agentId,
    });
  }

  if (await resolveShellCollabActive(sessionId, SESSIONS_DIR)) {
    sendJSON(ws, { type: 'info', sessionId, message: AGENT_MODE_SHELL_BLOCKED_MESSAGE });
    return false;
  }

  const profile = await readAgent(agentId, getAgentsDir());
  if (!profile) {
    sendJSON(ws, { type: 'info', sessionId, message: `Agent「${agentId}」不存在。` });
    return false;
  }

  const now = Date.now();
  const userMsgId = isSafeIntentMessageId(clientMessageId) ? clientMessageId : randomUUID();
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

  const userMessage = buildUserMessage(trimmedPrompt, `/${profile.id}`, userMsgId, now, {
    referencePaths: resolvedReferencePaths,
    skills: resolvedSkills,
    images: uiImageUrls,
  });

  const previous = getAgentModeState(sessionId);
  const wasThisAgent = previous?.active === true && previous.agentId === profile.id;
  await setAgentMode(sessionId, { id: profile.id, name: profile.name }, SESSIONS_DIR);

  const skipBubble = wasThisAgent && !!trimmedPrompt;
  const switched = previous?.active === true && previous.agentId !== profile.id;
  const bubble = skipBubble
    ? ''
    : switched
      ? `已切换到 Agent「${profile.name}」。角色提示词优先于技能。`
      : wasThisAgent
        ? `已在 Agent「${profile.name}」。点输入栏芯片的 × 可退出。`
        : enteredMessage(profile.name, profile.tools.length);
  const agentMessage = skipBubble
    ? null
    : {
        role: 'agent' as const,
        content: bubble,
        id: randomUUID(),
        completedAt: now,
      };

  await appendMessages(agentMessage ? [userMessage, agentMessage] : [userMessage], sessionId);
  broadcastToSession(sessionId, { type: 'user_message_appended', sessionId, message: userMessage });

  if (trimmedPrompt) {
    const autoTitle = await applyFirstPromptSessionTitle(sessionId, trimmedPrompt);
    broadcastSessionUpdated('user_message', autoTitle ? { sessionId, title: autoTitle } : { sessionId }, ws);
  }

  broadcastToSession(sessionId, {
    type: 'agent_mode_entered',
    sessionId,
    agentModeActive: true,
    agent: { id: profile.id, name: profile.name },
    idempotent: wasThisAgent,
    ...(agentMessage ? { message: agentMessage } : {}),
  });
  console.log(`[chat-ws] /${profile.id} enter session=${sessionId.slice(0, 8)} prompt=${trimmedPrompt ? 'yes' : 'no'}`);
  return true;
}

export async function handleAgentModeExit(
  ws: WebSocket,
  sessionId: string,
  options: {
    persistUserMessage?: boolean;
    rawContent?: string;
    clientMessageId?: string;
    agentId?: string;
  } = {},
): Promise<boolean> {
  await loadAgentModeForSession(sessionId, SESSIONS_DIR);
  const now = Date.now();
  const current = getAgentModeState(sessionId);
  const wasActive = current?.active === true;
  const requestedId = options.agentId?.trim();
  if (wasActive && requestedId && current?.agentId !== requestedId) {
    sendJSON(ws, { type: 'info', sessionId, message: `当前 Agent 是「${current?.name || current?.agentId}」，不是 /${requestedId}。` });
    return false;
  }

  const commandId = requestedId || current?.agentId || 'agent';
  const userMessage = options.persistUserMessage
    ? buildUserMessage(
        '',
        `/${commandId} exit`,
        isSafeIntentMessageId(options.clientMessageId) ? options.clientMessageId : randomUUID(),
        now,
      )
    : null;

  if (!wasActive) {
    if (userMessage) {
      await appendMessages([userMessage], sessionId);
      broadcastToSession(sessionId, { type: 'user_message_appended', sessionId, message: userMessage });
    }
    sendJSON(ws, { type: 'info', sessionId, message: '当前没有启用 Agent。' });
    broadcastToSession(sessionId, {
      type: 'agent_mode_exited',
      sessionId,
      agentModeActive: false,
      idempotent: true,
    });
    return true;
  }

  const name = current?.name || current?.agentId || '';
  await setAgentMode(sessionId, null, SESSIONS_DIR);
  const agentMessage = {
    role: 'agent' as const,
    content: `已退出 Agent「${name}」。`,
    id: randomUUID(),
    completedAt: now,
  };
  await appendMessages(userMessage ? [userMessage, agentMessage] : [agentMessage], sessionId);
  if (userMessage) {
    broadcastToSession(sessionId, { type: 'user_message_appended', sessionId, message: userMessage });
  }
  broadcastToSession(sessionId, {
    type: 'agent_mode_exited',
    sessionId,
    agentModeActive: false,
    message: agentMessage,
  });
  console.log(`[chat-ws] agent exit session=${sessionId.slice(0, 8)}`);
  return true;
}

/** 进入 Shell 协作时清掉用户 Agent。 */
export async function clearAgentModeForShellCollab(sessionId: string): Promise<void> {
  await loadAgentModeForSession(sessionId, SESSIONS_DIR);
  if (getAgentModeState(sessionId)?.active !== true) return;
  await setAgentMode(sessionId, null, SESSIONS_DIR);
  broadcastToSession(sessionId, {
    type: 'agent_mode_exited',
    sessionId,
    agentModeActive: false,
    reason: 'shell_collab',
  });
}

/** 本轮要套用的 Agent。配置已被删掉时退出模式并通知芯片。 */
export async function resolveActiveAgentForTurn(sessionId: string): Promise<AgentProfile | null> {
  await loadAgentModeForSession(sessionId, SESSIONS_DIR);
  const state = getAgentModeState(sessionId);
  if (!state?.active) return null;
  const profile = await readAgent(state.agentId, getAgentsDir());
  if (!profile) {
    await setAgentMode(sessionId, null, SESSIONS_DIR);
    broadcastToSession(sessionId, {
      type: 'agent_mode_exited',
      sessionId,
      agentModeActive: false,
      reason: 'missing',
    });
    return null;
  }
  if (profile.name !== state.name) {
    await setAgentMode(sessionId, { id: profile.id, name: profile.name }, SESSIONS_DIR);
    broadcastToSession(sessionId, {
      type: 'agent_mode_entered',
      sessionId,
      agentModeActive: true,
      agent: { id: profile.id, name: profile.name },
      idempotent: true,
    });
  }
  return profile;
}

export async function matchAgentCommand(content: string) {
  const ids = await listAgentCommandIds();
  return parseAgentCommand(content, ids);
}
