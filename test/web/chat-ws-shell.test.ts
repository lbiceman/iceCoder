import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import {
  handleShellCollabRoute,
  SHELL_COLLAB_BUSY_ENTER_MESSAGE,
  SHELL_COLLAB_EXIT_DISABLED_MESSAGE,
  queueShellCollabTransition,
  waitForShellCollabTransition,
} from '../../src/web/chat-ws-shell.js';
import { ensureRunningTurn, clearRunningTurn } from '../../src/web/chat-ws-running-turn.js';
import { getSessionFile } from '../../src/web/chat-ws-runtime.js';
import { clearBroadcastState, subscribeWsToSession } from '../../src/web/chat-ws-broadcast.js';

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

afterEach(() => {
  clearBroadcastState();
});

describe('chat-ws-shell', () => {
  it('exit 被禁用并回写用户气泡', async () => {
    const sid = `shell-exit-${Date.now()}`;
    const ws = fakeWs();
    const ok = await handleShellCollabRoute(ws, sid, 'exit', '/shell exit');
    expect(ok).toBe(true);
    expect(ws.sent[0]).toMatchObject({
      type: 'info',
      message: SHELL_COLLAB_EXIT_DISABLED_MESSAGE,
    });
    await fs.unlink(getSessionFile(sid)).catch(() => {});
  });

  it('busy 会话拒绝首次进入', async () => {
    const sid = `shell-busy-${Date.now()}`;
    const ws = fakeWs();
    ensureRunningTurn(sid);
    const ok = await handleShellCollabRoute(ws, sid, 'enter', '/shell');
    expect(ok).toBe(false);
    expect(ws.sent[0]).toMatchObject({
      type: 'info',
      message: SHELL_COLLAB_BUSY_ENTER_MESSAGE,
    });
    clearRunningTurn(sid);
  });

  it('空闲首次 enter 广播 shell_collab_entered', async () => {
    const sid = `shell-enter-${Date.now()}`;
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const ok = await handleShellCollabRoute(ws, sid, 'enter', '/shell');
    expect(ok).toBe(true);
    expect(ws.sent.some((m) => (m as { type?: string }).type === 'shell_collab_entered')).toBe(true);
    await fs.unlink(getSessionFile(sid)).catch(() => {});
    await fs.unlink(getSessionFile(sid).replace(/\.json$/, '.shell-collab.json')).catch(() => {});
  });

  it('queueShellCollabTransition 串行执行', async () => {
    const order: number[] = [];
    const sid = 'shell-q';
    const p1 = queueShellCollabTransition(sid, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const p2 = queueShellCollabTransition(sid, async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    await waitForShellCollabTransition(sid);
    expect(order).toEqual([1, 2]);
  });
});
