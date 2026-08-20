import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  subscribeWsToSession,
  unsubscribeWsFromAll,
  clearBroadcastState,
  hasSessionSubscribers,
} from '../../src/web/chat-ws-broadcast.js';
import { createToolConfirmHandler } from '../../src/web/chat-ws-confirm.js';

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

describe('chat-ws-confirm 无订阅者暂停超时', () => {
  it('无订阅者不超时；subscribe 后恢复计时', async () => {
    vi.useFakeTimers();
    try {
      const sid = 'confirm-pause-sid';
      expect(hasSessionSubscribers(sid)).toBe(false);
      const pending = createToolConfirmHandler(sid)('fs_operation', {});
      let settled: boolean | undefined;
      void pending.then((v) => { settled = v; });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBeUndefined();

      const ws = fakeWs();
      subscribeWsToSession(ws, sid);
      expect(hasSessionSubscribers(sid)).toBe(true);

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toBe(false);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribe 后暂停，再 subscribe 才继续计时', async () => {
    vi.useFakeTimers();
    try {
      const sid = 'confirm-pause-resume';
      const ws = fakeWs();
      subscribeWsToSession(ws, sid);
      const pending = createToolConfirmHandler(sid)('fs_operation', {});
      let settled: boolean | undefined;
      void pending.then((v) => { settled = v; });

      unsubscribeWsFromAll(ws);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBeUndefined();

      subscribeWsToSession(ws, sid);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
