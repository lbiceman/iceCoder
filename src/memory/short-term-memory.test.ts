import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShortTermMemory, ShortTermMemoryConfig } from './short-term-memory.js';
import { Memory, MemoryType } from './types.js';

function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    content: 'test content',
    type: MemoryType.SHORT_TERM,
    createdAt: new Date(),
    lastAccessedAt: new Date(),
    importanceScore: 0.5,
    sourceAgent: 'test-agent',
    tags: [],
    ...overrides,
  };
}

describe('ShortTermMemory', () => {
  let stm: ShortTermMemory;
  const defaultConfig: ShortTermMemoryConfig = {
    capacity: 5,
    ttl: 60000, // 60 seconds
  };

  beforeEach(() => {
    stm = new ShortTermMemory(defaultConfig);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('store', () => {
    it('should store a memory in the queue', async () => {
      const memory = createTestMemory();
      await stm.store(memory);
      const all = await stm.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(memory.id);
    });

    it('should store multiple memories up to capacity', async () => {
      for (let i = 0; i < 5; i++) {
        await stm.store(createTestMemory({ id: `mem-${i}` }));
      }
      const all = await stm.getAll();
      expect(all).toHaveLength(5);
    });

    it('should evict when at capacity', async () => {
      for (let i = 0; i < 5; i++) {
        await stm.store(createTestMemory({ id: `mem-${i}`, importanceScore: 0.5 }));
      }
      const newMemory = createTestMemory({ id: 'mem-new', importanceScore: 0.9 });
      await stm.store(newMemory);
      const all = await stm.getAll();
      expect(all).toHaveLength(5);
      expect(all.some(m => m.id === 'mem-new')).toBe(true);
    });

    it('should set TTL on each memory entry', async () => {
      const config: ShortTermMemoryConfig = { capacity: 5, ttl: 1000 };
      const shortTtlStm = new ShortTermMemory(config);

      await shortTtlStm.store(createTestMemory({ id: 'mem-1' }));
      let all = await shortTtlStm.getAll();
      expect(all).toHaveLength(1);

      // Advance time past TTL
      vi.advanceTimersByTime(1001);
      all = await shortTtlStm.getAll();
      expect(all).toHaveLength(0);
    });
  });

  describe('eviction policy', () => {
    it('should evict memory with lowest importance score', async () => {
      await stm.store(createTestMemory({ id: 'high', importanceScore: 0.9 }));
      await stm.store(createTestMemory({ id: 'low', importanceScore: 0.1 }));
      await stm.store(createTestMemory({ id: 'mid', importanceScore: 0.5 }));
      await stm.store(createTestMemory({ id: 'mid2', importanceScore: 0.5 }));
      await stm.store(createTestMemory({ id: 'mid3', importanceScore: 0.5 }));

      // Queue is full (5), store one more
      await stm.store(createTestMemory({ id: 'new', importanceScore: 0.6 }));

      const all = await stm.getAll();
      expect(all).toHaveLength(5);
      // 'low' should have been evicted
      expect(all.some(m => m.id === 'low')).toBe(false);
      expect(all.some(m => m.id === 'new')).toBe(true);
    });

    it('should evict memory with earliest lastAccessedAt when scores are tied', async () => {
      const earlier = new Date('2024-01-01T00:00:00Z');
      const later = new Date('2024-01-01T12:00:00Z');

      await stm.store(createTestMemory({ id: 'early', importanceScore: 0.3, lastAccessedAt: earlier }));
      await stm.store(createTestMemory({ id: 'late', importanceScore: 0.3, lastAccessedAt: later }));
      await stm.store(createTestMemory({ id: 'high1', importanceScore: 0.8 }));
      await stm.store(createTestMemory({ id: 'high2', importanceScore: 0.8 }));
      await stm.store(createTestMemory({ id: 'high3', importanceScore: 0.8 }));

      // Queue is full, store one more
      await stm.store(createTestMemory({ id: 'new', importanceScore: 0.5 }));

      const all = await stm.getAll();
      // 'early' should be evicted (same score as 'late' but earlier access)
      expect(all.some(m => m.id === 'early')).toBe(false);
      expect(all.some(m => m.id === 'late')).toBe(true);
    });
  });

  describe('TTL expiration', () => {
    it('should auto-remove expired memories on store', async () => {
      const config: ShortTermMemoryConfig = { capacity: 10, ttl: 2000 };
      const ttlStm = new ShortTermMemory(config);

      await ttlStm.store(createTestMemory({ id: 'old' }));
      vi.advanceTimersByTime(2001);

      // Storing a new memory triggers cleanup
      await ttlStm.store(createTestMemory({ id: 'new' }));
      const all = await ttlStm.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('new');
    });

    it('should auto-remove expired memories on retrieve', async () => {
      const config: ShortTermMemoryConfig = { capacity: 10, ttl: 2000 };
      const ttlStm = new ShortTermMemory(config);

      await ttlStm.store(createTestMemory({ id: 'old', content: 'findme' }));
      vi.advanceTimersByTime(2001);

      const results = await ttlStm.retrieve('findme');
      expect(results).toHaveLength(0);
    });

    it('should keep non-expired memories', async () => {
      const config: ShortTermMemoryConfig = { capacity: 10, ttl: 5000 };
      const ttlStm = new ShortTermMemory(config);

      await ttlStm.store(createTestMemory({ id: 'mem1' }));
      vi.advanceTimersByTime(2000);
      await ttlStm.store(createTestMemory({ id: 'mem2' }));
      vi.advanceTimersByTime(2000);

      // mem1 has been alive for 4000ms (not expired), mem2 for 2000ms
      const all = await ttlStm.getAll();
      expect(all).toHaveLength(2);

      // Advance 1001ms more - mem1 expires at 5000ms total
      vi.advanceTimersByTime(1001);
      const allAfter = await ttlStm.getAll();
      expect(allAfter).toHaveLength(1);
      expect(allAfter[0].id).toBe('mem2');
    });
  });

  describe('retrieve', () => {
    it('should return memories matching query by content substring', async () => {
      await stm.store(createTestMemory({ id: 'match1', content: 'hello world' }));
      await stm.store(createTestMemory({ id: 'match2', content: 'hello there' }));
      await stm.store(createTestMemory({ id: 'nomatch', content: 'goodbye' }));

      const results = await stm.retrieve('hello');
      expect(results).toHaveLength(2);
      expect(results.every(m => m.content.includes('hello'))).toBe(true);
    });

    it('should be case-insensitive', async () => {
      await stm.store(createTestMemory({ id: 'upper', content: 'HELLO WORLD' }));
      await stm.store(createTestMemory({ id: 'lower', content: 'hello world' }));

      const results = await stm.retrieve('Hello');
      expect(results).toHaveLength(2);
    });

    it('should update lastAccessedAt on access', async () => {
      const originalDate = new Date('2024-01-01T00:00:00Z');
      await stm.store(createTestMemory({ id: 'mem1', content: 'findme', lastAccessedAt: originalDate }));

      vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
      const results = await stm.retrieve('findme');

      expect(results).toHaveLength(1);
      expect(results[0].lastAccessedAt.getTime()).toBeGreaterThan(originalDate.getTime());
    });

    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await stm.store(createTestMemory({ id: `mem-${i}`, content: 'common content' }));
      }

      const results = await stm.retrieve('common', 2);
      expect(results).toHaveLength(2);
    });

    it('should sort results by importance score descending', async () => {
      await stm.store(createTestMemory({ id: 'low', content: 'search term', importanceScore: 0.2 }));
      await stm.store(createTestMemory({ id: 'high', content: 'search term', importanceScore: 0.9 }));
      await stm.store(createTestMemory({ id: 'mid', content: 'search term', importanceScore: 0.5 }));

      const results = await stm.retrieve('search term');
      expect(results[0].id).toBe('high');
      expect(results[1].id).toBe('mid');
      expect(results[2].id).toBe('low');
    });

    it('should return empty array when no matches found', async () => {
      await stm.store(createTestMemory({ content: 'hello world' }));
      const results = await stm.retrieve('nonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('retrieve performance', () => {
    it('should return results within 50ms for a queue at capacity', async () => {
      const largeConfig: ShortTermMemoryConfig = { capacity: 1000, ttl: 60000 };
      const largeStm = new ShortTermMemory(largeConfig);

      // Fill with 1000 memories
      for (let i = 0; i < 1000; i++) {
        await largeStm.store(createTestMemory({
          id: `mem-${i}`,
          content: `memory content number ${i} with some additional text for searching`,
        }));
      }

      vi.useRealTimers();
      const start = performance.now();
      await largeStm.retrieve('number 500');
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('getAll', () => {
    it('should return all non-expired memories', async () => {
      await stm.store(createTestMemory({ id: 'mem1' }));
      await stm.store(createTestMemory({ id: 'mem2' }));
      const all = await stm.getAll();
      expect(all).toHaveLength(2);
    });

    it('should return empty array when queue is empty', async () => {
      const all = await stm.getAll();
      expect(all).toHaveLength(0);
    });
  });

  describe('remove', () => {
    it('should remove a memory by ID and return true', async () => {
      await stm.store(createTestMemory({ id: 'to-remove' }));
      await stm.store(createTestMemory({ id: 'to-keep' }));

      const result = await stm.remove('to-remove');
      expect(result).toBe(true);

      const all = await stm.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('to-keep');
    });

    it('should return false when memory ID is not found', async () => {
      await stm.store(createTestMemory({ id: 'existing' }));
      const result = await stm.remove('nonexistent');
      expect(result).toBe(false);
    });
  });
});
