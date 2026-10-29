/**
 * 把屏幕问号的截图和回答写进标题为「屏幕问号」的普通会话。
 * 不跟侧栏当前选中的会话走，任务会话也不收。
 */

import { randomUUID } from 'node:crypto';
import { appendMessages } from './chat-ws-persist.js';
import { broadcastSessionUpdated, broadcastSessionsIndexUpdated } from './chat-ws-broadcast.js';
import { buildSessionImageApiUrl, persistInlineImages } from './images-cache.js';
import { createSessionRecord } from './routes/sessions.js';
import {
  loadSessionIndex,
  mutateSessionIndex,
  type SessionMeta,
} from './session-index-store.js';
import type { ScreenPingAskInput } from './screen-ping-ask.js';

export const SCREEN_PING_SESSION_TITLE = '屏幕问号';

export function chooseScreenPingSession(
  sessions: Pick<SessionMeta, 'id' | 'title' | 'scheduledTaskId'>[],
): { id: string } | { create: true } {
  const named = sessions.find((session) => !session.scheduledTaskId && session.title === SCREEN_PING_SESSION_TITLE);
  if (named) return { id: named.id };
  return { create: true };
}

async function resolveScreenPingSessionId(): Promise<string> {
  const sessions = await loadSessionIndex();
  const choice = chooseScreenPingSession(sessions);
  if ('id' in choice) return choice.id;
  const created = await createSessionRecord(SCREEN_PING_SESSION_TITLE);
  return created.id;
}

/** 落盘截图并追加一轮用户图 + 助手回答。失败不抛给问号浮层。 */
export async function recordScreenPingTurn(input: ScreenPingAskInput, answer: string): Promise<void> {
  const sessionId = await resolveScreenPingSessionId();
  const saved = await persistInlineImages([input.imageDataUrl], sessionId);
  const imageUrl = saved[0] ? buildSessionImageApiUrl(sessionId, saved[0].absolutePath) : '';
  const now = Date.now();
  const userId = `ping-${randomUUID()}`;
  const appended = await appendMessages([
    {
      role: 'user',
      id: userId,
      content: '屏幕问号',
      ...(imageUrl ? { images: [imageUrl] } : {}),
      sentAt: now,
    },
    {
      role: 'agent',
      id: `ping-${randomUUID()}`,
      content: answer,
      completedAt: now,
    },
  ], sessionId);
  if (!appended) return;

  await mutateSessionIndex((index) => {
    const entry = index.find((session) => session.id === sessionId);
    if (!entry) return index;
    entry.updatedAt = now;
    entry.messageCount = Math.max(0, entry.messageCount) + 2;
    return index;
  });
  broadcastSessionsIndexUpdated();
  broadcastSessionUpdated('screen_ping', { sessionId });
}
