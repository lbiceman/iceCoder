import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import {
  enqueueAndMaybeKickoff,
  type ChatRunDeps,
} from '../../src/web/chat-ws-loop.js';
import { handleChatMessage } from '../../src/web/chat-ws-turn.js';
import { clearRunningTurn, ensureRunningTurn } from '../../src/web/chat-ws-running-turn.js';
import {
  getActiveSessionId,
  getSessionsDir,
  sessionAbortControllers,
  sessionProcessing,
  setActiveSessionId,
} from '../../src/web/chat-ws-runtime.js';
import { getTaskQueueManager } from '../../src/session/task-queue.js';
import {
  addChatClient,
  clearBroadcastState,
  getSubscribedSessionId,
  subscribeWsToSession,
} from '../../src/web/chat-ws-broadcast.js';
import { createInboundMessageHandler } from '../../src/web/chat-ws-inbound.js';
import { drainAlsoNotesForRun, clearPendingNotesForSession } from '../../src/session/pending-note.js';

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
function uniqueSid(prefix = 'iso'): string {
  const sid = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  usedSids.push(sid);
  return sid;
}

afterEach(async () => {
  vi.mocked(handleChatMessage).mockReset();
  vi.mocked(handleChatMessage).mockResolvedValue('model_done');
  for (const sid of usedSids.splice(0)) {
    clearRunningTurn(sid);
    sessionProcessing.delete(sid);
    sessionAbortControllers.delete(sid);
    clearPendingNotesForSession(sid);
    await getTaskQueueManager(getSessionsDir()).clearSession(sid);
    await fs.unlink(`${getSessionsDir()}/${sid}.json`).catch(() => {});
  }
  clearBroadcastState();
});

describe('多会话隔离', () => {
  it('A 与 B 可同时 processing，互不 abort', async () => {
    const a = uniqueSid('iso-a');
    const b = uniqueSid('iso-b');
    const wsA = fakeWs();
    const wsB = fakeWs();
    subscribeWsToSession(wsA, a);
    subscribeWsToSession(wsB, b);
    addChatClient(wsA);
    addChatClient(wsB);

    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    vi.mocked(handleChatMessage).mockImplementation(async (opts: { runSessionId?: string }) => {
      if (opts.runSessionId === a) await gateA;
      else await gateB;
      return 'model_done';
    });

    void enqueueAndMaybeKickoff(dummyDeps, a, wsA, {
      text: 'task-a',
      source: 'implicit',
      messageId: 'm-a',
    });
    await vi.waitFor(() => {
      expect(sessionProcessing.has(a)).toBe(true);
    });

    void enqueueAndMaybeKickoff(dummyDeps, b, wsB, {
      text: 'task-b',
      source: 'implicit',
      messageId: 'm-b',
    });
    await vi.waitFor(() => {
      expect(sessionProcessing.has(b)).toBe(true);
    });
    expect(sessionProcessing.has(a)).toBe(true);

    releaseA();
    releaseB();
    await vi.waitFor(() => {
      expect(sessionProcessing.has(a)).toBe(false);
      expect(sessionProcessing.has(b)).toBe(false);
    });
  });

  it('B 的 /also 不会写入 A 的 pending-note', async () => {
    const a = uniqueSid('also-a');
    const b = uniqueSid('also-b');
    const wsA = fakeWs();
    const wsB = fakeWs();
    subscribeWsToSession(wsA, a);
    subscribeWsToSession(wsB, b);
    ensureRunningTurn(a);
    const handler = createInboundMessageHandler(dummyDeps);

    await handler(wsB, Buffer.from(JSON.stringify({ type: 'message', content: '/also 补给 B' })));
    expect(wsB.sent.some((m) => (m as { type?: string }).type === 'also_rejected')).toBe(true);
    expect(drainAlsoNotesForRun(a)).toHaveLength(0);
    expect(drainAlsoNotesForRun(b)).toHaveLength(0);

    await handler(wsA, Buffer.from(JSON.stringify({ type: 'message', content: '/also 补给 A' })));
    expect(drainAlsoNotesForRun(a).map((n) => n.text)).toEqual(['补给 A']);
    expect(drainAlsoNotesForRun(b)).toHaveLength(0);
  });

  it('看 B 时 A 结束的 session_run_state 仍能到达 B 的连接', async () => {
    const a = uniqueSid('run-a');
    const b = uniqueSid('run-b');
    const wsA = fakeWs();
    const wsB = fakeWs();
    subscribeWsToSession(wsA, a);
    subscribeWsToSession(wsB, b);
    addChatClient(wsA);
    addChatClient(wsB);

    await enqueueAndMaybeKickoff(dummyDeps, a, wsA, {
      text: 'task-a',
      source: 'implicit',
      messageId: 'm-a',
    });
    await vi.waitFor(() => {
      expect(sessionProcessing.has(a)).toBe(false);
    });

    const bRunStates = wsB.sent.filter((m) => (m as { type?: string }).type === 'session_run_state') as Array<{
      sessionId: string;
      phase: string;
    }>;
    expect(bRunStates.some((m) => m.sessionId === a && m.phase === 'running')).toBe(true);
    expect(bRunStates.some((m) => m.sessionId === a && m.phase === 'done')).toBe(true);
  });

  it('切走订阅后 A 继续跑完，任务向事件不再打到当前连接', async () => {
    const a = uniqueSid('iso-leave-a');
    const b = uniqueSid('iso-goto-b');
    const ws = fakeWs();
    subscribeWsToSession(ws, a);
    addChatClient(ws);
    const prevFocused = getActiveSessionId();

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    vi.mocked(handleChatMessage).mockImplementation(async () => {
      await gateA;
      return 'model_done';
    });

    void enqueueAndMaybeKickoff(dummyDeps, a, ws, {
      text: 'task-a',
      source: 'implicit',
      messageId: 'm-leave-a',
    });
    await vi.waitFor(() => {
      expect(sessionProcessing.has(a)).toBe(true);
    });

    const handler = createInboundMessageHandler(dummyDeps);
    try {
      await handler(ws, Buffer.from(JSON.stringify({ type: 'switch_session', sessionId: b })));
      expect(getSubscribedSessionId(ws)).toBe(b);
      expect(sessionProcessing.has(a)).toBe(true);

      ws.sent.length = 0;
      releaseA();
      await vi.waitFor(() => {
        expect(sessionProcessing.has(a)).toBe(false);
      });

      const types = ws.sent.map((m) => (m as { type?: string }).type);
      expect(types).not.toContain('status');
      expect(types).not.toContain('stream');
      expect(types).not.toContain('step');
      expect(ws.sent.some((m) => {
        const row = m as { type?: string; sessionId?: string; phase?: string };
        return row.type === 'session_run_state' && row.sessionId === a && row.phase === 'done';
      })).toBe(true);
    } finally {
      releaseA();
      setActiveSessionId(prevFocused);
    }
  });

  it('A 忙碌时 B 的隐式 /next 立即 kickoff，不写入 A 队列', async () => {
    const a = uniqueSid('next-busy-a');
    const b = uniqueSid('next-idle-b');
    const wsA = fakeWs();
    const wsB = fakeWs();
    subscribeWsToSession(wsA, a);
    subscribeWsToSession(wsB, b);
    addChatClient(wsA);
    addChatClient(wsB);

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    vi.mocked(handleChatMessage).mockImplementation(async (opts: { runSessionId?: string }) => {
      if (opts.runSessionId === a) await gateA;
      return 'model_done';
    });

    void enqueueAndMaybeKickoff(dummyDeps, a, wsA, {
      text: 'task-a',
      source: 'implicit',
      messageId: 'm-a-busy',
    });
    await vi.waitFor(() => {
      expect(sessionProcessing.has(a)).toBe(true);
    });

    const handler = createInboundMessageHandler(dummyDeps);
    try {
      await handler(wsB, Buffer.from(JSON.stringify({
        type: 'message',
        content: 'task-b-next',
        messageId: '550e8400-e29b-41d4-a716-446655440001',
      })));

      await vi.waitFor(() => {
        expect(sessionProcessing.has(b)).toBe(true);
      });
      expect(sessionProcessing.has(a)).toBe(true);
      const aQueue = await getTaskQueueManager(getSessionsDir()).list(a);
      expect(aQueue.map((item) => item.text)).not.toContain('task-b-next');
      expect(vi.mocked(handleChatMessage).mock.calls.some((call) => call[0]?.runSessionId === b)).toBe(true);
    } finally {
      releaseA();
      await vi.waitFor(() => {
        expect(sessionProcessing.has(a)).toBe(false);
        expect(sessionProcessing.has(b)).toBe(false);
      });
    }
  });
});
