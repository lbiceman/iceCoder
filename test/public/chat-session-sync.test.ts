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
  fetchStructuredMessages(callback: (messages: unknown[]) => void): void;
  setSessionId(id: string): void;
}

function loadChatSession(options?: {
  storedMessages?: unknown[];
  fetchImpl?: (url?: string) => Promise<unknown>;
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

  it('切换会话后忽略过期的服务端消息请求', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    const session = loadChatSession({
      fetchImpl: () => pending.then(() => ({
        ok: true,
        json: () => Promise.resolve({ messages: [{ role: 'user', id: 'from-a', content: 'A' }] }),
      })),
    });
    session.initSession();

    let called = false;
    session.fetchServerMessages(() => { called = true; });
    session.setSessionId('other');
    resolveFetch(undefined);
    await pending;
    await Promise.resolve();
    await Promise.resolve();

    expect(called).toBe(false);
  });

  it('空会话不因 structured 为空告警；有历史时只告警一次', async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(String(args[0] ?? '')); };
    try {
      const emptySession = loadChatSession({
        fetchImpl: (url?: string) => {
          if (String(url).includes('/structured')) {
            return Promise.resolve({ json: () => Promise.resolve({ messages: [] }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: [] }) });
        },
      });
      emptySession.initSession();
      await new Promise<void>((resolve) => emptySession.fetchStructuredMessages(() => resolve()));
      expect(warns.some((w) => w.includes('structured messages 为空'))).toBe(false);

      const withHistory = loadChatSession({
        storedMessages: [{ role: 'user', id: 'u1', content: 'hi' }],
        fetchImpl: (url?: string) => {
          if (String(url).includes('/structured')) {
            return Promise.resolve({ json: () => Promise.resolve({ messages: [] }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: [] }) });
        },
      });
      withHistory.initSession();
      await new Promise<void>((resolve) => withHistory.fetchStructuredMessages(() => resolve()));
      await new Promise<void>((resolve) => withHistory.fetchStructuredMessages(() => resolve()));
      expect(warns.filter((w) => w.includes('structured messages 为空'))).toHaveLength(1);
    } finally {
      console.warn = origWarn;
    }
  });
});
