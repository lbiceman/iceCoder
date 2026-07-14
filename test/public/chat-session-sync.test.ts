import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ChatSessionApi {
  initSession(): unknown[];
  getMessages(): unknown[];
  separateToolTraces(messages: unknown[]): { msgs: unknown[]; traces: Record<string, unknown[]> };
  applyServerChatSnapshot(
    separated: { msgs: unknown[]; traces: Record<string, unknown[]> },
    options: { authoritative?: boolean },
    isStreaming: boolean,
    wsProcessing: boolean,
  ): boolean;
  fetchServerMessages(
    callback: (messages: unknown[], result: { ok: boolean }) => void,
  ): void;
}

function loadChatSession(options?: {
  storedMessages?: unknown[];
  fetchImpl?: () => Promise<unknown>;
}): ChatSessionApi {
  const src = readFileSync(path.join(__dirname, '../../src/public/js/chat-session.js'), 'utf-8');
  const storage = new Map<string, string>();
  if (options?.storedMessages) {
    storage.set('ice-chat-messages:default', JSON.stringify(options.storedMessages));
  }
  const ctx = {
    window: {},
    localStorage: {
      getItem(key: string) { return storage.get(key) ?? null; },
      setItem(key: string, value: string) { storage.set(key, value); },
      removeItem(key: string) { storage.delete(key); },
    },
    fetch: options?.fetchImpl ?? (() => Promise.resolve({
      json: () => Promise.resolve({ messages: [] }),
    })),
    console,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(src, ctx);
  return (ctx.window as { ChatSession: ChatSessionApi }).ChatSession;
}

describe('ChatSession 服务端快照同步', () => {
  it('权威空快照会清除仅存在于 localStorage 的旧消息', () => {
    const session = loadChatSession({
      storedMessages: [{ role: 'user', id: 'stale-user', content: '旧消息' }],
    });
    session.initSession();

    const updated = session.applyServerChatSnapshot(
      session.separateToolTraces([]),
      { authoritative: true },
      false,
      false,
    );

    expect(updated).toBe(true);
    expect(session.getMessages()).toEqual([]);
  });

  it('非权威空快照不会清除本地消息', () => {
    const session = loadChatSession({
      storedMessages: [{ role: 'user', id: 'local-user', content: '待同步消息' }],
    });
    session.initSession();

    const updated = session.applyServerChatSnapshot(
      session.separateToolTraces([]),
      { authoritative: false },
      false,
      false,
    );

    expect(updated).toBe(false);
    expect(session.getMessages()).toHaveLength(1);
  });

  it('请求失败与成功的空会话使用不同结果状态', async () => {
    const successful = loadChatSession();
    const successResult = await new Promise<{ messages: unknown[]; ok: boolean }>((resolve) => {
      successful.fetchServerMessages((messages, result) => resolve({ messages, ok: result.ok }));
    });

    const failed = loadChatSession({
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    const failureResult = await new Promise<{ messages: unknown[]; ok: boolean }>((resolve) => {
      failed.fetchServerMessages((messages, result) => resolve({ messages, ok: result.ok }));
    });

    expect(successResult).toEqual({ messages: [], ok: true });
    expect(failureResult).toEqual({ messages: [], ok: false });
  });
});
