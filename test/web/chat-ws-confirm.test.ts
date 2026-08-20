import { afterEach, describe, expect, it, vi } from 'vitest';

const broadcasts: unknown[] = [];

vi.mock('../../src/web/chat-ws-broadcast.js', () => ({
  broadcastToSession: (_sid: string, data: unknown) => {
    broadcasts.push(data);
  },
  hasSessionSubscribers: () => true,
  onAfterSubscribe: () => {},
  onAfterUnsubscribe: () => {},
  sendJSON: () => {},
}));

afterEach(() => {
  broadcasts.length = 0;
});

describe('chat-ws-confirm first-win', () => {
  it('同一 confirmId 第二次 reply 被忽略', async () => {
    const { createToolConfirmHandler, handleConfirmReply } = await import('../../src/web/chat-ws-confirm.js');
    const handler = createToolConfirmHandler('sess-a');
    const pending = handler('fs_operation', { path: '/tmp' });
    const confirmEvt = broadcasts.find((b) => (b as { type?: string }).type === 'confirm') as { confirmId: string };
    expect(confirmEvt.confirmId).toBeTruthy();

    handleConfirmReply(confirmEvt.confirmId, true, 'sess-a');
    handleConfirmReply(confirmEvt.confirmId, false, 'sess-a');
    await expect(pending).resolves.toBe(true);

    const resolved = broadcasts.filter((b) => (b as { type?: string }).type === 'confirm_resolved');
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as { approved: boolean }).approved).toBe(true);
  });

  it('旧客户端无 confirmId 时取该 session 最早 pending', async () => {
    const { createToolConfirmHandler, handleConfirmReply } = await import('../../src/web/chat-ws-confirm.js');
    const handler = createToolConfirmHandler('sess-b');
    const pending = handler('shell', { command: 'ls' });
    handleConfirmReply('', true, 'sess-b');
    await expect(pending).resolves.toBe(true);
  });

  it('60s 超时广播 confirm_timeout 并 resolve false', async () => {
    vi.useFakeTimers();
    try {
      const { createToolConfirmHandler } = await import('../../src/web/chat-ws-confirm.js');
      const handler = createToolConfirmHandler('sess-timeout');
      const pending = handler('fs_operation', {});
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toBe(false);
      expect(broadcasts.some((b) => (b as { type?: string }).type === 'confirm_timeout')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('其它 session 的 reply 不能赢走 confirm', async () => {
    const { createToolConfirmHandler, handleConfirmReply } = await import('../../src/web/chat-ws-confirm.js');
    const handler = createToolConfirmHandler('sess-c');
    const pending = handler('fs_operation', {});
    const confirmEvt = broadcasts.find((b) => (b as { type?: string }).type === 'confirm') as { confirmId: string };
    handleConfirmReply(confirmEvt.confirmId, true, 'other-session');
    handleConfirmReply(confirmEvt.confirmId, false, 'sess-c');
    await expect(pending).resolves.toBe(false);
  });

  it('purgeSessionConfirms 将未决 confirm resolve 为 false', async () => {
    const { createToolConfirmHandler, purgeSessionConfirms } = await import('../../src/web/chat-ws-confirm.js');
    const handler = createToolConfirmHandler('sess-purge');
    const pending = handler('fs_operation', {});
    purgeSessionConfirms('sess-purge');
    await expect(pending).resolves.toBe(false);
  });
});
