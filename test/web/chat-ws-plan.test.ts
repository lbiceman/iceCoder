import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import {
  handlePlanModeRoute,
  handlePlanModeExit,
  PLAN_MODE_ENTERED_MESSAGE,
  PLAN_MODE_EXITED_MESSAGE,
  PLAN_MODE_SHELL_BLOCKED_MESSAGE,
  queuePlanModeTransition,
  waitForPlanModeTransition,
} from '../../src/web/chat-ws-plan.js';
import { setShellCollabActive, resetShellCollabStoreForTests } from '../../src/session/shell-collab-store.js';
import { resetPlanModeStoreForTests, resolvePlanModeActive } from '../../src/session/plan-mode-store.js';
import { getSessionFile, SESSIONS_DIR } from '../../src/web/chat-ws-runtime.js';
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
  resetPlanModeStoreForTests();
  resetShellCollabStoreForTests();
});

describe('chat-ws-plan', () => {
  it('空闲首次 enter 广播 plan_mode_entered', async () => {
    const sid = `plan-enter-${Date.now()}`;
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    const ok = await handlePlanModeRoute(ws, sid, 'enter', '/plan');
    expect(ok).toBe(true);
    expect(ws.sent.some((m) => (m as { type?: string }).type === 'plan_mode_entered')).toBe(true);
    expect(ws.sent.some((m) => {
      const row = m as { type?: string; message?: { content?: string } };
      return row.type === 'plan_mode_entered' && row.message?.content === PLAN_MODE_ENTERED_MESSAGE;
    })).toBe(true);
    await expect(resolvePlanModeActive(sid, SESSIONS_DIR)).resolves.toBe(true);
    await fs.unlink(getSessionFile(sid)).catch(() => {});
    await fs.unlink(getSessionFile(sid).replace(/\.json$/, '.plan-mode.json')).catch(() => {});
  });

  it('X 退出不写用户气泡并广播 plan_mode_exited', async () => {
    const sid = `plan-exit-${Date.now()}`;
    const ws = fakeWs();
    subscribeWsToSession(ws, sid);
    await handlePlanModeRoute(ws, sid, 'enter', '/plan');
    ws.sent.length = 0;
    const ok = await handlePlanModeExit(ws, sid, { persistUserMessage: false });
    expect(ok).toBe(true);
    expect(ws.sent.some((m) => (m as { type?: string }).type === 'user_message_appended')).toBe(false);
    expect(ws.sent.some((m) => {
      const row = m as { type?: string; message?: { content?: string } };
      return row.type === 'plan_mode_exited' && row.message?.content === PLAN_MODE_EXITED_MESSAGE;
    })).toBe(true);
    await expect(resolvePlanModeActive(sid, SESSIONS_DIR)).resolves.toBe(false);
    await fs.unlink(getSessionFile(sid)).catch(() => {});
    await fs.unlink(getSessionFile(sid).replace(/\.json$/, '.plan-mode.json')).catch(() => {});
  });

  it('Shell 会话拒绝进入规划模式', async () => {
    const sid = `plan-shell-${Date.now()}`;
    const ws = fakeWs();
    await setShellCollabActive(sid, true, SESSIONS_DIR);
    const ok = await handlePlanModeRoute(ws, sid, 'enter', '/plan');
    expect(ok).toBe(false);
    expect(ws.sent[0]).toMatchObject({
      type: 'info',
      message: PLAN_MODE_SHELL_BLOCKED_MESSAGE,
    });
    await fs.unlink(getSessionFile(sid).replace(/\.json$/, '.shell-collab.json')).catch(() => {});
  });

  it('queuePlanModeTransition 串行执行', async () => {
    const order: number[] = [];
    const sid = 'plan-q';
    const p1 = queuePlanModeTransition(sid, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const p2 = queuePlanModeTransition(sid, async () => {
      order.push(2);
    });
    await Promise.all([p1, p2]);
    await waitForPlanModeTransition(sid);
    expect(order).toEqual([1, 2]);
  });
});
