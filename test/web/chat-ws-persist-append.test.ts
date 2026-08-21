import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  appendMessages,
  saveStructuredMessages,
} from '../../src/web/chat-ws-persist.js';
import {
  getCachedMessages,
  getSessionFile,
  getSessionsDir,
  isSessionTombstoned,
  structuredCache,
  tombstoneSession,
} from '../../src/web/chat-ws-runtime.js';

const SID = `persist-append-${Date.now()}`;

afterEach(async () => {
  await fs.unlink(getSessionFile(SID)).catch(() => {});
  structuredCache.delete(SID);
});

describe('chat-ws-persist appendMessages', () => {
  it('tombstone 会话直接返回 true 且不写文件', async () => {
    tombstoneSession(`${SID}-dead`);
    expect(isSessionTombstoned(`${SID}-dead`)).toBe(true);
    const ok = await appendMessages([{ role: 'user', content: 'x', id: '1' }], `${SID}-dead`);
    expect(ok).toBe(true);
    await expect(fs.stat(getSessionFile(`${SID}-dead`))).rejects.toThrow();
  });

  it('空数组返回 true', async () => {
    expect(await appendMessages([], SID)).toBe(true);
  });

  it('user 缺 sentAt / agent 缺 completedAt 时自动打戳', async () => {
    const before = Date.now();
    await appendMessages([
      { role: 'user', content: 'hi', id: 'stamp-u' },
      { role: 'agent', content: 'yo', id: 'stamp-a' },
    ], SID);
    const raw = JSON.parse(await fs.readFile(getSessionFile(SID), 'utf-8')) as Array<Record<string, unknown>>;
    expect(typeof raw[0].sentAt).toBe('number');
    expect(raw[0].sentAt as number).toBeGreaterThanOrEqual(before);
    expect(typeof raw[1].completedAt).toBe('number');
  });

  it('同 id 合并并保留旧 referencePaths / skills / shellCommand', async () => {
    await appendMessages([{
      role: 'user',
      id: 'u1',
      content: 'first',
      referencePaths: ['a.ts'],
      skills: ['s.md'],
      shellCommand: 'ls',
    }], SID);
    await appendMessages([{
      role: 'user',
      id: 'u1',
      content: 'second',
    }], SID);
    const raw = JSON.parse(await fs.readFile(getSessionFile(SID), 'utf-8')) as Array<Record<string, unknown>>;
    expect(raw).toHaveLength(1);
    expect(raw[0].content).toBe('second');
    expect(raw[0].referencePaths).toEqual(['a.ts']);
    expect(raw[0].skills).toEqual(['s.md']);
    expect(raw[0].shellCommand).toBe('ls');
  });

  it('saveStructuredMessages 写入 structuredCache，不改非活跃 session 的 legacy 缓存', () => {
    vi.useFakeTimers();
    try {
      const prev = getCachedMessages();
      const msgs = [{ role: 'assistant' as const, content: 'hi' }];
      saveStructuredMessages(msgs, SID);
      expect(structuredCache.get(SID)).toEqual(msgs);
      expect(getCachedMessages()).toBe(prev);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getSessionsDir 与 session 文件路径一致', () => {
    expect(getSessionFile('abc')).toBe(path.join(getSessionsDir(), 'abc.json'));
  });
});
