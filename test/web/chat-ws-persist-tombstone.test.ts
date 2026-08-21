import { describe, expect, it, vi } from 'vitest';
import type { UnifiedMessage } from '../../src/llm/types.js';
import {
  isSessionTombstoned,
  structuredCache,
  tombstoneSession,
} from '../../src/web/chat-ws-runtime.js';
import { saveStructuredMessages } from '../../src/web/chat-ws-persist.js';

describe('chat-ws-persist tombstone', () => {
  it('tombstone 之后 saveStructuredMessages 不再写入缓存', () => {
    const sid = `tombstone-${Date.now()}`;
    vi.useFakeTimers();
    try {
      tombstoneSession(sid);
      expect(isSessionTombstoned(sid)).toBe(true);
      saveStructuredMessages([{ role: 'user', content: 'x' }] as UnifiedMessage[], sid);
      expect(structuredCache.has(sid)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
