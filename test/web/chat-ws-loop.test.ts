import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import {
  enqueueAndMaybeKickoff,
  persistImplicitQueuedUserMessage,
  queuedTaskToPending,
  runSessionMessageLoop,
  type ChatRunDeps,
} from '../../src/web/chat-ws-loop.js';
import { handleChatMessage } from '../../src/web/chat-ws-turn.js';
import { ensureRunningTurn, clearRunningTurn } from '../../src/web/chat-ws-running-turn.js';
import { getSessionsDir, sessionProcessing } from '../../src/web/chat-ws-runtime.js';
import { getTaskQueueManager } from '../../src/session/task-queue.js';
import { subscribeWsToSession, clearBroadcastState, addChatClient } from '../../src/web/chat-ws-broadcast.js';

vi.mock('../../src/web/chat-ws-turn.js', () => ({
  handleChatMessage: vi.fn(async () => 'model_done'),
}));

function fakeWs() {
  const sent: unknown[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    sent,
    send(body: string) {
      sent.push(JSON.parse(body));
    },
  };
  return ws as unknown as WebSocket & { sent: unknown[] };
}

const dummyDeps: ChatRunDeps = {
  orchestrator: {} as never,
  toolRegistry: {} as never,
  toolExecutor: {} as never,
};

const usedSids: string[] = [];
function uniqueSid(): string {
  const sid = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  usedSids.push(sid);
  return sid;
}

afterEach(async () => {
  vi.mocked(handleChatMessage).mockReset();
  vi.mocked(handleChatMessage).mockResolvedValue('model_done');
  for (const sid of usedSids.splice(0)) {
    clearRunningTurn(sid);
    sessionProcessing.delete(sid);
    await getTaskQueueManager(getSessionsDir()).clearSession(sid);
    await fs.unlink(`${getSessionsDir()}/${sid}.json`).catch(() => {});
  }
  clearBroadcastState();
});

describe('chat-ws-loop', () => {
  it('queuedTaskToPending：implicit + messageId 跳过重复 append', () => {
    const ws = fakeWs();
    const pending = queuedTaskToPending({
      id: 't1',
      text: 'hello',
      messageId: 'm1',
      source: 'implicit',
      enqueuedAt: Date.now(),
    }, ws);
    expect(pending.skipUserMessageAppend).toBe(true);
    expect(queuedTaskToPending({
      id: 't2',
      text: 'hello',
      source: 'explicit',
      enqueuedAt: Date.now(),
    }, ws).skipUserMessageAppend).toBe(false);
  });

  it('会话 busy 时 enqueue 只入队不 kickoff', async () => {
    const sid = uniqueSid();
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    ensureRunningTurn(sid);
    await enqueueAndMaybeKickoff(dummyDeps, sid, ws, {
      text: 'queued while busy',
      source: 'implicit',
      messageId: 'm-busy',
    });
    const items = await getTaskQueueManager(getSessionsDir()).list(sid);
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('queued while busy');
    expect(handleChatMessage).not.toHaveBeenCalled();
  });

  it('persistImplicitQueuedUserMessage 只处理 implicit+messageId', async () => {
    const sid = uniqueSid();
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    await persistImplicitQueuedUserMessage(sid, ws, {
      text: 'no-id',
      source: 'implicit',
    });
    await persistImplicitQueuedUserMessage(sid, ws, {
      text: 'explicit',
      source: 'explicit',
      messageId: 'm-ex',
    });
    expect(ws.sent.some((m) => (m as { type?: string }).type === 'user_message_appended')).toBe(false);
  });

  it('persistImplicitQueuedUserMessage 对 implicit+messageId 落盘并广播', async () => {
    const sid = uniqueSid();
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    await persistImplicitQueuedUserMessage(sid, ws, {
      text: 'hello queued',
      source: 'implicit',
      messageId: 'm-ok',
    });
    const appended = ws.sent.find((m) => (m as { type?: string }).type === 'user_message_appended') as {
      message: { content: string; id: string };
    };
    expect(appended.message.id).toBe('m-ok');
    expect(appended.message.content).toContain('hello queued');
  });

  it('空闲 enqueue 会 kickoff 并消耗队列', async () => {
    const sid = uniqueSid();
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    addChatClient(ws);
    await enqueueAndMaybeKickoff(dummyDeps, sid, ws, {
      text: 'go now',
      source: 'implicit',
      messageId: 'm-go',
    });
    await vi.waitFor(() => {
      expect(handleChatMessage).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(async () => {
      expect(await getTaskQueueManager(getSessionsDir()).list(sid)).toHaveLength(0);
    });
    await vi.waitFor(() => {
      expect(sessionProcessing.has(sid)).toBe(false);
    });
    const runStates = ws.sent.filter((m) => (m as { type?: string }).type === 'session_run_state') as Array<{
      phase: string;
      sessionId: string;
    }>;
    expect(runStates[0]).toMatchObject({ sessionId: sid, phase: 'running' });
    expect(runStates[runStates.length - 1]).toMatchObject({ phase: 'done' });
  });

  it('model_done 会继续执行队列中下一项', async () => {
    const sid = uniqueSid();
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    addChatClient(ws);
    await getTaskQueueManager(getSessionsDir()).enqueue(sid, {
      text: 'second',
      source: 'explicit',
    });
    await runSessionMessageLoop(dummyDeps, sid, ws, {
      content: 'first',
      images: [],
      referencePaths: [],
      source: 'implicit',
      ws,
    });
    expect(handleChatMessage).toHaveBeenCalledTimes(2);
    expect(await getTaskQueueManager(getSessionsDir()).list(sid)).toHaveLength(0);
    expect(ws.sent.some((m) =>
      (m as { type?: string }).type === 'info'
      && String((m as { message?: string }).message).includes('正在执行排队任务'),
    )).toBe(true);
    const phases = ws.sent
      .filter((m) => (m as { type?: string }).type === 'session_run_state')
      .map((m) => (m as { phase: string }).phase);
    expect(phases.filter((p) => p === 'done')).toHaveLength(1);
    expect(phases[phases.length - 1]).toBe('done');
    expect(phases.includes('running')).toBe(true);
  });

  it('非 model_done 停止循环并保留剩余队列', async () => {
    const sid = uniqueSid();
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    vi.mocked(handleChatMessage).mockResolvedValue('user_abort');
    await getTaskQueueManager(getSessionsDir()).enqueue(sid, {
      text: 'second',
      source: 'explicit',
    });
    await runSessionMessageLoop(dummyDeps, sid, ws, {
      content: 'first',
      images: [],
      referencePaths: [],
      source: 'implicit',
      ws,
    });
    expect(handleChatMessage).toHaveBeenCalledTimes(1);
    const leftover = await getTaskQueueManager(getSessionsDir()).list(sid);
    expect(leftover).toHaveLength(1);
    expect(leftover[0].text).toBe('second');
  });

  it('handleChatMessage 抛错时广播 error 并结束循环', async () => {
    const sid = uniqueSid();
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    vi.mocked(handleChatMessage).mockRejectedValue(new Error('boom'));
    await getTaskQueueManager(getSessionsDir()).enqueue(sid, {
      text: 'second',
      source: 'explicit',
    });
    await runSessionMessageLoop(dummyDeps, sid, ws, {
      content: 'first',
      images: [],
      referencePaths: [],
      source: 'implicit',
      ws,
    });
    expect(handleChatMessage).toHaveBeenCalledTimes(1);
    expect(ws.sent.some((m) => (m as { type?: string }).type === 'error')).toBe(true);
    expect(await getTaskQueueManager(getSessionsDir()).list(sid)).toHaveLength(1);
    expect(sessionProcessing.has(sid)).toBe(false);
  });
});
