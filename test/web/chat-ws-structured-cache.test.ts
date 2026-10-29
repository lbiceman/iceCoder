import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { getOrLoadCachedMessages } from '../../src/web/chat-ws-persist.js';
import {
  evictIdleStructuredCaches,
  getActiveSessionId,
  getCachedMessages,
  getSessionsDir,
  getStructuredSessionFile,
  saveTimerMap,
  sessionProcessing,
  setActiveSessionId,
  setCachedMessages,
  structuredCache,
} from '../../src/web/chat-ws-runtime.js';
import { writeStructuredMessagesFile } from '../../src/web/session-structured-io.js';

const base = `cache-evict-${Date.now()}`;
const idle = `${base}-idle`;
const busy = `${base}-busy`;
const unsaved = `${base}-unsaved`;
const target = `${base}-target`;
const ELEVEN_MINUTES = 11 * 60_000;

afterEach(async () => {
  for (const sid of [idle, busy, unsaved, target]) {
    setCachedMessages(sid, undefined);
    await fs.unlink(getStructuredSessionFile(sid)).catch(() => {});
  }
  sessionProcessing.delete(busy);
  const timer = saveTimerMap.get(unsaved);
  if (timer) clearTimeout(timer);
  saveTimerMap.delete(unsaved);
});

describe('structuredCache idle eviction', () => {
  it('evicts idle sessions but keeps active, running and unsaved ones', () => {
    const messages = [{ role: 'user', content: 'x' }] as UnifiedMessage[];
    const active = getActiveSessionId();
    for (const sid of [active, idle, busy, unsaved]) setCachedMessages(sid, messages);
    sessionProcessing.add(busy);
    saveTimerMap.set(unsaved, setTimeout(() => {}, 60_000));

    expect(evictIdleStructuredCaches(Date.now() + 5_000)).toEqual([]);
    const evicted = evictIdleStructuredCaches(Date.now() + ELEVEN_MINUTES);
    expect(evicted).toEqual([idle]);
    expect(structuredCache.has(idle)).toBe(false);
    for (const sid of [active, busy, unsaved]) expect(structuredCache.has(sid)).toBe(true);
    setCachedMessages(active, undefined);
  });

  it('reloads an evicted session from disk when a turn needs it', async () => {
    const messages = [{ role: 'user', content: '磁盘上的历史' }] as UnifiedMessage[];
    await writeStructuredMessagesFile(getSessionsDir(), idle, messages);
    setCachedMessages(idle, messages);
    evictIdleStructuredCaches(Date.now() + ELEVEN_MINUTES);
    expect(getCachedMessages(idle)).toBeUndefined();

    const loaded = await getOrLoadCachedMessages(idle);
    expect(loaded?.map((m) => m.content)).toEqual(['磁盘上的历史']);
    expect(getCachedMessages(idle)).toBe(loaded);
  });

  it('does not hand another session\'s messages to a focus that was reverted after eviction', async () => {
    const original = getActiveSessionId();
    try {
      await writeStructuredMessagesFile(getSessionsDir(), idle, [{ role: 'user', content: '会话 A' }] as UnifiedMessage[]);
      setActiveSessionId(idle);
      setCachedMessages(idle, [{ role: 'user', content: '会话 A' }] as UnifiedMessage[]);
      setActiveSessionId(target);
      setCachedMessages(target, [{ role: 'user', content: '会话 B' }] as UnifiedMessage[]);
      expect(evictIdleStructuredCaches(Date.now() + ELEVEN_MINUTES)).toContain(idle);

      setActiveSessionId(idle);
      expect(getCachedMessages(idle)).toBeUndefined();
      const loaded = await getOrLoadCachedMessages(idle);
      expect(loaded?.map((m) => m.content)).toEqual(['会话 A']);
    } finally {
      setActiveSessionId(original);
    }
  });
});
