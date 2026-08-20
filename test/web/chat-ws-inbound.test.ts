import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import { createInboundMessageHandler } from '../../src/web/chat-ws-inbound.js';
import { subscribeWsToSession, clearBroadcastState, getSubscribedSessionId, addChatClient } from '../../src/web/chat-ws-broadcast.js';
import {
  getSessionFile,
  getSessionsDir,
  sessionAbortControllers,
  sessionProcessing,
  setActiveSessionId,
  getActiveSessionId,
  setSessionRunPhase,
  getSessionRunPhase,
} from '../../src/web/chat-ws-runtime.js';
import {
  ensureRunningTurn,
  clearRunningTurn,
  getRunningTurn,
} from '../../src/web/chat-ws-running-turn.js';
import { createToolConfirmHandler, handleConfirmReply } from '../../src/web/chat-ws-confirm.js';
import { PENDING_NOTE_USAGE_MESSAGE } from '../../src/session/pending-note.js';
import { getTaskQueueManager } from '../../src/session/task-queue.js';
import {
  enqueueAndMaybeKickoff,
  persistImplicitQueuedUserMessage,
  runSessionMessageLoop,
} from '../../src/web/chat-ws-loop.js';

vi.mock('../../src/web/chat-ws-loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/chat-ws-loop.js')>();
  return {
    ...actual,
    enqueueAndMaybeKickoff: vi.fn(async () => {}),
    persistImplicitQueuedUserMessage: vi.fn(async () => {}),
    runSessionMessageLoop: vi.fn(async () => {}),
  };
});

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

const dummyDeps = {
  orchestrator: {} as never,
  toolRegistry: {} as never,
  toolExecutor: {} as never,
};

const usedSids: string[] = [];
function uniqueSid(prefix: string): string {
  const sid = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  usedSids.push(sid);
  return sid;
}

afterEach(async () => {
  clearBroadcastState();
  vi.mocked(enqueueAndMaybeKickoff).mockClear();
  vi.mocked(persistImplicitQueuedUserMessage).mockClear();
  vi.mocked(runSessionMessageLoop).mockClear();
  for (const sid of usedSids.splice(0)) {
    clearRunningTurn(sid);
    sessionProcessing.delete(sid);
    sessionAbortControllers.delete(sid);
    setSessionRunPhase(sid, 'idle');
    await fs.unlink(getSessionFile(sid)).catch(() => {});
    await fs.unlink(getSessionFile(sid).replace(/\.json$/, '.structured.json')).catch(() => {});
    await getTaskQueueManager(getSessionsDir()).clearSession(sid).catch(() => {});
  }
});

describe('chat-ws-inbound', () => {
  it('ping → pong', async () => {
    const ws = fakeWs();
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'ping' })));
    expect(ws.sent).toEqual([{ type: 'pong' }]);
  });

  it('非法 JSON → 消息格式错误', async () => {
    const ws = fakeWs();
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from('not-json'));
    expect(ws.sent).toEqual([{ type: 'error', message: '消息格式错误' }]);
  });

  it('未知 type 不回包', async () => {
    const ws = fakeWs();
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'not_a_real_type' })));
    expect(ws.sent).toEqual([]);
  });

  it('空 message 不入队', async () => {
    const ws = fakeWs();
    subscribeWsToSession(ws, uniqueSid('inbound-empty'));
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '   ' })));
    expect(ws.sent).toEqual([]);
    expect(enqueueAndMaybeKickoff).not.toHaveBeenCalled();
  });

  it('/next 无正文返回用法', async () => {
    const ws = fakeWs();
    subscribeWsToSession(ws, uniqueSid('inbound-next'));
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '/next' })));
    expect(ws.sent[0]).toMatchObject({ type: 'info', message: '用法: /next <任务描述>' });
    expect(enqueueAndMaybeKickoff).not.toHaveBeenCalled();
  });

  it('/also 无运行中任务被拒绝', async () => {
    const sid = uniqueSid('inbound-also-idle');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '/also 补充约束' })));
    expect(ws.sent[0]).toMatchObject({
      type: 'also_rejected',
      sessionId: sid,
    });
  });

  it('getRunningTurn 在 also 拒绝路径不会被误创建', async () => {
    const sid = uniqueSid('inbound-also-no-create');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    expect(getRunningTurn(sid)).toBeUndefined();
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '/also x' })));
    expect(getRunningTurn(sid)).toBeUndefined();
  });

  it('/also 无文本返回用法', async () => {
    const ws = fakeWs();
    subscribeWsToSession(ws, uniqueSid('inbound-also-usage'));
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '/also' })));
    expect(ws.sent[0]).toMatchObject({ type: 'info', message: PENDING_NOTE_USAGE_MESSAGE });
  });

  it('/also 在运行中任务上广播 also_note_appended', async () => {
    const sid = uniqueSid('inbound-also-run');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    ensureRunningTurn(sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '/also 用 pnpm' })));
    const note = ws.sent.find((m) => (m as { type?: string }).type === 'also_note_appended') as {
      message: { content: string; alsoNote?: boolean };
    };
    expect(note.message.content).toBe('用 pnpm');
    expect(note.message.alsoNote).toBe(true);
  });

  it('~open 在 processing 时拒绝', async () => {
    const sid = uniqueSid('inbound-open-busy');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    sessionProcessing.add(sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '~open' })));
    expect(ws.sent[0]).toMatchObject({ type: 'info', message: '当前有任务进行中，请稍后再试 /open' });
    expect(runSessionMessageLoop).not.toHaveBeenCalled();
  });

  it('~open 空闲时走 runSessionMessageLoop 不入队', async () => {
    const sid = uniqueSid('inbound-open-idle');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '~open' })));
    expect(runSessionMessageLoop).toHaveBeenCalledTimes(1);
    expect(enqueueAndMaybeKickoff).not.toHaveBeenCalled();
  });

  it('/open 空闲时走 runSessionMessageLoop 不入队', async () => {
    const sid = uniqueSid('inbound-slash-open-idle');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'message', content: '/open' })));
    expect(runSessionMessageLoop).toHaveBeenCalledTimes(1);
    expect(enqueueAndMaybeKickoff).not.toHaveBeenCalled();
  });

  it('普通 message 会 persist + enqueue', async () => {
    const sid = uniqueSid('inbound-msg');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({
      type: 'message',
      content: 'hello world',
      messageId: '550e8400-e29b-41d4-a716-446655440000',
    })));
    expect(persistImplicitQueuedUserMessage).toHaveBeenCalledTimes(1);
    expect(enqueueAndMaybeKickoff).toHaveBeenCalledTimes(1);
    const enqueueArgs = vi.mocked(enqueueAndMaybeKickoff).mock.calls[0];
    expect(enqueueArgs[1]).toBe(sid);
    expect(enqueueArgs[3]).toMatchObject({
      text: 'hello world',
      source: 'implicit',
      messageId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('stop 会 abort 当前会话 harness', async () => {
    const sid = uniqueSid('inbound-stop');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const ctrl = new AbortController();
    sessionAbortControllers.set(sid, ctrl);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'stop' })));
    expect(ctrl.signal.aborted).toBe(true);
    expect(sessionAbortControllers.has(sid)).toBe(true);
  });

  it('switch_session 目标等于当前订阅时直接 ok', async () => {
    const ws = fakeWs();
    const sid = uniqueSid('inbound-switch-same');
    subscribeWsToSession(ws, sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({
      type: 'switch_session',
      sessionId: sid,
    })));
    expect(ws.sent[0]).toMatchObject({ type: 'session_switched', ok: true, sessionId: sid });
    expect(sessionAbortControllers.has(sid)).toBe(false);
  });

  it('switch_session 空 sessionId 视为当前会话', async () => {
    const ws = fakeWs();
    const sid = uniqueSid('inbound-switch-empty');
    subscribeWsToSession(ws, sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'switch_session', sessionId: '' })));
    expect(ws.sent[0]).toMatchObject({ type: 'session_switched', ok: true, sessionId: sid });
  });

  it('switch_session 切走不 abort leaving 会话', async () => {
    const leaving = uniqueSid('inbound-leave');
    const target = uniqueSid('inbound-target');
    const ws = fakeWs();
    subscribeWsToSession(ws, leaving);
    sessionProcessing.add(leaving);
    const ctrl = new AbortController();
    sessionAbortControllers.set(leaving, ctrl);
    const prevFocused = getActiveSessionId();
    const handler = createInboundMessageHandler(dummyDeps);
    try {
      await handler(ws, Buffer.from(JSON.stringify({ type: 'switch_session', sessionId: target })));
      expect(ctrl.signal.aborted).toBe(false);
      expect(sessionAbortControllers.get(leaving)).toBe(ctrl);
      const switched = ws.sent.find((m) =>
        (m as { type?: string; ok?: boolean }).type === 'session_switched'
        && (m as { ok?: boolean }).ok === true,
      ) as { sessionId: string; canRestore?: boolean };
      expect(switched.sessionId).toBe(target);
      expect(typeof switched.canRestore).toBe('boolean');
    } finally {
      setActiveSessionId(prevFocused);
    }
  });

  it('switch_session 幂等看订阅 id，不看进程级 activeSessionId', async () => {
    const leaving = uniqueSid('inbound-sub');
    const focused = uniqueSid('inbound-focused');
    const target = uniqueSid('inbound-goto');
    const ws = fakeWs();
    subscribeWsToSession(ws, leaving);
    const prevFocused = getActiveSessionId();
    setActiveSessionId(focused);
    try {
      const handler = createInboundMessageHandler(dummyDeps);
      await handler(ws, Buffer.from(JSON.stringify({ type: 'switch_session', sessionId: target })));
      expect(getSubscribedSessionId(ws)).toBe(target);
      expect(ws.sent.some((m) =>
        (m as { type?: string; ok?: boolean }).type === 'session_switched'
        && (m as { ok?: boolean }).ok === true,
      )).toBe(true);
    } finally {
      setActiveSessionId(prevFocused);
    }
  });

  it('restore_runtime / delete_user_message 缺少 messageId', async () => {
    const ws = fakeWs();
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'restore_runtime' })));
    await handler(ws, Buffer.from(JSON.stringify({ type: 'delete_user_message' })));
    expect(ws.sent[0]).toMatchObject({ type: 'restore_failed', error: '缺少 messageId。' });
    expect(ws.sent[1]).toMatchObject({ type: 'delete_message_failed', error: '缺少 messageId。' });
  });

  it('bg_task_stop 缺少 taskId', async () => {
    const ws = fakeWs();
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'bg_task_stop' })));
    expect(ws.sent[0]).toMatchObject({ type: 'bg_task_stop_result', ok: false, error: 'missing taskId' });
  });

  it('restore_runtime 在运行中被拒绝', async () => {
    const sid = uniqueSid('inbound-restore-busy');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    ensureRunningTurn(sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({
      type: 'restore_runtime',
      messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })));
    expect(ws.sent[0]).toMatchObject({
      type: 'restore_failed',
      error: '运行中，请等待当前任务完成后再回滚。',
    });
  });

  it('delete_user_message 在运行中被拒绝', async () => {
    const sid = uniqueSid('inbound-del-busy');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    ensureRunningTurn(sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({
      type: 'delete_user_message',
      messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    })));
    expect(ws.sent[0]).toMatchObject({
      type: 'delete_message_failed',
      error: '运行中，请等待当前任务完成后再删除。',
    });
  });

  it('confirm_reply 走 first-win 并广播 confirm_resolved', async () => {
    const sid = uniqueSid('inbound-confirm');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const pending = createToolConfirmHandler(sid)('fs_operation', { path: '/tmp' });
    const confirmEvt = ws.sent.find((m) => (m as { type?: string }).type === 'confirm') as { confirmId: string };
    expect(confirmEvt.confirmId).toBeTruthy();
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({
      type: 'confirm_reply',
      confirmId: confirmEvt.confirmId,
      approved: true,
    })));
    await expect(pending).resolves.toBe(true);
    expect(ws.sent.some((m) => (m as { type?: string }).type === 'confirm_resolved')).toBe(true);
    handleConfirmReply(confirmEvt.confirmId, false, sid);
  });

  it('clear_session 回 session_cleared', async () => {
    const sid = uniqueSid('inbound-clear');
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'clear_session' })));
    expect(ws.sent[0]).toMatchObject({ type: 'session_cleared', ok: true, sessionId: sid, bgTasks: [] });
  });

  it('ack_session_run 将 done 广播为 idle，全员可见', async () => {
    const sid = uniqueSid('inbound-ack-done');
    const ws = fakeWs();
    const watcher = fakeWs();
    subscribeWsToSession(ws, sid);
    addChatClient(watcher);
    setSessionRunPhase(sid, 'done');
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'ack_session_run', sessionId: sid })));
    expect(getSessionRunPhase(sid)).toBe('idle');
    expect(watcher.sent.some((m) => {
      const row = m as { type?: string; sessionId?: string; phase?: string };
      return row.type === 'session_run_state' && row.sessionId === sid && row.phase === 'idle';
    })).toBe(true);
  });

  it('ack_session_run 不能清 running，也不能清未订阅会话', async () => {
    const a = uniqueSid('inbound-ack-run');
    const b = uniqueSid('inbound-ack-other');
    const ws = fakeWs();
    subscribeWsToSession(ws, a);
    setSessionRunPhase(a, 'running');
    setSessionRunPhase(b, 'error');
    const handler = createInboundMessageHandler(dummyDeps);
    await handler(ws, Buffer.from(JSON.stringify({ type: 'ack_session_run', sessionId: a })));
    expect(getSessionRunPhase(a)).toBe('running');
    await handler(ws, Buffer.from(JSON.stringify({ type: 'ack_session_run', sessionId: b })));
    expect(getSessionRunPhase(b)).toBe('error');
  });
});
