import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  addChatClient,
  broadcastMcpReady,
  broadcastSessionUpdated,
  broadcastToSession,
  broadcastToSessionExcept,
  broadcastTunnelReady,
  clearBroadcastState,
  getMcpReadySnapshot,
  getSubscribedSessionId,
  getTunnelReadySnapshot,
  pickSessionWs,
  removeChatClient,
  sendJSON,
  subscribeWsToSession,
  unsubscribeWsFromAll,
} from '../../src/web/chat-ws-broadcast.js';

function fakeWs(open = true) {
  const sent: unknown[] = [];
  const ws = {
    readyState: open ? WebSocket.OPEN : WebSocket.CLOSED,
    sent,
    send(body: string) {
      sent.push(JSON.parse(body));
    },
  };
  return ws as unknown as WebSocket & { sent: unknown[] };
}

afterEach(() => {
  clearBroadcastState();
});

describe('chat-ws-broadcast', () => {
  it('subscribe 后 broadcastToSession 只发给该 session 的连接', () => {
    const a = fakeWs();
    const b = fakeWs();
    subscribeWsToSession(a, 's1');
    subscribeWsToSession(b, 's2');
    broadcastToSession('s1', { type: 'pong' });
    expect(a.sent).toEqual([{ type: 'pong' }]);
    expect(b.sent).toEqual([]);
  });

  it('关闭的连接不会收到广播', () => {
    const ws = fakeWs(false);
    subscribeWsToSession(ws, 's1');
    broadcastToSession('s1', { type: 'pong' });
    expect(ws.sent).toEqual([]);
    sendJSON(ws, { type: 'pong' });
    expect(ws.sent).toEqual([]);
  });

  it('switch 订阅会从旧 session 集合移除', () => {
    const ws = fakeWs();
    subscribeWsToSession(ws, 'old');
    subscribeWsToSession(ws, 'neu');
    expect(getSubscribedSessionId(ws)).toBe('neu');
    broadcastToSession('old', { type: 'info', message: 'x' });
    broadcastToSession('neu', { type: 'pong' });
    expect(ws.sent).toEqual([{ type: 'pong' }]);
  });

  it('unsubscribeWsFromAll 后不再收到事件', () => {
    const ws = fakeWs();
    subscribeWsToSession(ws, 's1');
    unsubscribeWsFromAll(ws);
    broadcastToSession('s1', { type: 'pong' });
    expect(ws.sent).toEqual([]);
    expect(getSubscribedSessionId(ws)).toBeUndefined();
  });

  it('pickSessionWs 优先 OPEN 的 fallback，否则找订阅者', () => {
    const closed = fakeWs(false);
    const open = fakeWs();
    subscribeWsToSession(open, 's1');
    expect(pickSessionWs('s1', closed)).toBe(open);
    expect(pickSessionWs('s1', open)).toBe(open);
  });

  it('broadcastToSessionExcept 跳过发送方', () => {
    const a = fakeWs();
    const b = fakeWs();
    subscribeWsToSession(a, 's1');
    subscribeWsToSession(b, 's1');
    broadcastToSessionExcept('s1', { type: 'info', message: 'x' }, a);
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([{ type: 'info', message: 'x' }]);
  });

  it('session_updated 无 title 时排除 except；有 title 时全员通知', () => {
    const a = fakeWs();
    const b = fakeWs();
    addChatClient(a);
    addChatClient(b);
    broadcastSessionUpdated('user_message', { sessionId: 's1' }, a);
    expect(a.sent).toEqual([]);
    expect(b.sent[0]).toMatchObject({ type: 'session_updated', reason: 'user_message' });
    a.sent.length = 0;
    b.sent.length = 0;
    broadcastSessionUpdated('user_message', { sessionId: 's1', title: 'Hello' }, a);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('mcp/tunnel 快照写入后可供晚到连接读取', () => {
    broadcastMcpReady({ ok: true, toolCount: 3, readyServers: 1 });
    broadcastTunnelReady({ url: 'https://example.trycloudflare.com' });
    expect(getMcpReadySnapshot()).toMatchObject({ ok: true, toolCount: 3 });
    expect(getTunnelReadySnapshot()).toEqual({ url: 'https://example.trycloudflare.com' });
    const late = fakeWs();
    addChatClient(late);
    sendJSON(late, { type: 'connected', mcpReady: getMcpReadySnapshot() });
    expect(late.sent[0]).toMatchObject({ type: 'connected', mcpReady: { ok: true, toolCount: 3 } });
  });

  it('removeChatClient 后全局广播不再发给该连接', () => {
    const ws = fakeWs();
    addChatClient(ws);
    removeChatClient(ws);
    broadcastMcpReady({ ok: false, toolCount: 0, readyServers: 0, errorMessage: 'x' });
    expect(ws.sent).toEqual([]);
  });
});
