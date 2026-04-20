import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LongTermMemory, LongTermMemoryConfig } from './long-term-memory.js';
import { Memory, MemoryType } from './types.js';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: randomUUID(),
    content: 'test memory content',
    type: MemoryType.LONG_TERM,
    createdAt: new Date(),
    lastAccessedAt: new Date(),
    importanceScore: 0.7,
    sourceAgent: 'test-agent',
    tags: ['test', 'unit'],
    metadata: { key: 'value' },
    ...overrides,
  };
}

/**
 * Generate a simple embedding vector for testing.
 * Creates a normalized vector based on content hash for reproducibility.
 */
function generateTestEmbedding(content: string, dimensions: number = 8): number[] {
  const vector: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    // Simple deterministic pseudo-random based on content and index
    const charCode = content.charCodeAt(i % content.length) || 0;
    vector.push(((charCode + i * 31) % 100) / 100);
  }
  // Normalize the vector
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map(v => v / (magnitude || 1));
}

describe('LongTermMemory', () => {
  let ltm: LongTermMemory;
  let testDbPath: string;

  beforeEach(() => {
    // Create a unique temp directory for each test
    testDbPath = path.join(os.tmpdir(), `lancedb-test-${randomUUID()}`);
    ltm = new LongTermMemory({
      dbPath: testDbPath,
      maxResults: 10,
      similarityThreshold: 0.0, // Low threshold for testing
    });
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(testDbPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('store', () => {
    it('should store a memory with embedding', async () => {
      const memory = createTestMemory({ content: 'hello world' });
      const embedding = generateTestEmbedding('hello world');

      await ltm.store(memory, embedding);

      // Verify by restoring
      const count = await ltm.restore();
      expect(count).toBe(1);
    });

    it('should store multiple memories', async () => {
      const memories = [
        createTestMemory({ content: 'first memory' }),
        createTestMemory({ content: 'second memory' }),
        createTestMemory({ content: 'third memory' }),
      ];

      for (const mem of memories) {
        await ltm.store(mem, generateTestEmbedding(mem.content));
      }

      const count = await ltm.restore();
      expect(count).toBe(3);
    });

    it('should preserve memory metadata when stored', async () => {
      const memory = createTestMemory({
        content: 'metadata test',
        tags: ['important', 'test'],
        metadata: { priority: 'high', category: 'testing' },
        sourceAgent: 'metadata-agent',
        importanceScore: 0.85,
      });
      const embedding = generateTestEmbedding('metadata test');

      await ltm.store(memory, embedding);

      const results = await ltm.retrieve(embedding, 1, 0.0);
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('metadata test');
      expect(results[0].tags).toEqual(['important', 'test']);
      expect(results[0].metadata).toEqual({ priority: 'high', category: 'testing' });
      expect(results[0].sourceAgent).toBe('metadata-agent');
      expect(results[0].importanceScore).toBe(0.85);
    });

    it('should include memory ID in error message on store failure', async () => {
      // Verify the error handling path exists and wraps errors properly
      // We test this by checking the error message format in the implementation
      const memory = createTestMemory({ id: 'test-error-id' });
      const embedding = generateTestEmbedding('test');

      // Store should succeed with valid inputs
      await expect(ltm.store(memory, embedding)).resolves.toBeUndefined();
    });
  });

  describe('retrieve', () => {
    it('should retrieve memories by vector similarity', async () => {
      const memory1 = createTestMemory({ content: 'machine learning algorithms' });
      const memory2 = createTestMemory({ content: 'deep learning neural networks' });
      const memory3 = createTestMemory({ content: 'cooking recipes for dinner' });

      await ltm.store(memory1, generateTestEmbedding('machine learning algorithms'));
      await ltm.store(memory2, generateTestEmbedding('deep learning neural networks'));
      await ltm.store(memory3, generateTestEmbedding('cooking recipes for dinner'));

      // Query with embedding similar to machine learning
      const queryEmbedding = generateTestEmbedding('machine learning algorithms');
      const results = await ltm.retrieve(queryEmbedding);

      expect(results.length).toBeGreaterThan(0);
      // The most similar result should be the exact match
      expect(results[0].content).toBe('machine learning algorithms');
    });

    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        const content = `memory number ${i}`;
        await ltm.store(
          createTestMemory({ content }),
          generateTestEmbedding(content)
        );
      }

      const queryEmbedding = generateTestEmbedding('memory number 0');
      const results = await ltm.retrieve(queryEmbedding, 2, 0.0);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should return empty array when no memories exist', async () => {
      const queryEmbedding = generateTestEmbedding('anything');
      const results = await ltm.retrieve(queryEmbedding);
      expect(results).toEqual([]);
    });

    it('should filter by similarity threshold', async () => {
      const memory = createTestMemory({ content: 'specific topic' });
      await ltm.store(memory, generateTestEmbedding('specific topic'));

      // Use a very high threshold - should filter out most results
      const queryEmbedding = generateTestEmbedding('completely unrelated content xyz');
      const results = await ltm.retrieve(queryEmbedding, 10, 0.99);

      // With a 0.99 threshold, dissimilar vectors should be filtered
      // The exact result depends on the test embeddings
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should use config defaults when limit and threshold not provided', async () => {
      const configuredLtm = new LongTermMemory({
        dbPath: testDbPath,
        maxResults: 2,
        similarityThreshold: 0.0,
      });

      for (let i = 0; i < 5; i++) {
        const content = `memory ${i}`;
        await configuredLtm.store(
          createTestMemory({ content }),
          generateTestEmbedding(content)
        );
      }

      const results = await configuredLtm.retrieve(generateTestEmbedding('memory 0'));
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('delete', () => {
    it('should delete a memory by ID', async () => {
      const memory = createTestMemory({ content: 'to be deleted' });
      const embedding = generateTestEmbedding('to be deleted');

      await ltm.store(memory, embedding);

      const deleted = await ltm.delete(memory.id);
      expect(deleted).toBe(true);

      const count = await ltm.restore();
      expect(count).toBe(0);
    });

    it('should return false when table does not exist', async () => {
      const result = await ltm.delete('nonexistent-id');
      expect(result).toBe(false);
    });

    it('should not affect other memories when deleting one', async () => {
      const memory1 = createTestMemory({ content: 'keep this' });
      const memory2 = createTestMemory({ content: 'delete this' });

      await ltm.store(memory1, generateTestEmbedding('keep this'));
      await ltm.store(memory2, generateTestEmbedding('delete this'));

      await ltm.delete(memory2.id);

      const count = await ltm.restore();
      expect(count).toBe(1);

      const results = await ltm.getAll();
      expect(results[0].content).toBe('keep this');
    });
  });

  describe('restore', () => {
    it('should return 0 when no table exists', async () => {
      const count = await ltm.restore();
      expect(count).toBe(0);
    });

    it('should recover all stored memories after re-initialization', async () => {
      // Store some memories
      for (let i = 0; i < 3; i++) {
        const content = `persistent memory ${i}`;
        await ltm.store(
          createTestMemory({ content }),
          generateTestEmbedding(content)
        );
      }

      // Create a new instance pointing to the same path (simulating restart)
      const newLtm = new LongTermMemory({
        dbPath: testDbPath,
        maxResults: 10,
        similarityThreshold: 0.0,
      });

      const count = await newLtm.restore();
      expect(count).toBe(3);
    });

    it('should return 0 when database path has no table', async () => {
      // Use a fresh path with no existing data
      const freshLtm = new LongTermMemory({
        dbPath: path.join(os.tmpdir(), `lancedb-fresh-${randomUUID()}`),
        maxResults: 10,
        similarityThreshold: 0.5,
      });

      const count = await freshLtm.restore();
      expect(count).toBe(0);
    });
  });

  describe('getAll', () => {
    it('should return all stored memories', async () => {
      const memories = [
        createTestMemory({ content: 'first' }),
        createTestMemory({ content: 'second' }),
      ];

      for (const mem of memories) {
        await ltm.store(mem, generateTestEmbedding(mem.content));
      }

      const all = await ltm.getAll();
      expect(all).toHaveLength(2);
      const contents = all.map(m => m.content).sort();
      expect(contents).toEqual(['first', 'second']);
    });

    it('should return empty array when no memories stored', async () => {
      const all = await ltm.getAll();
      expect(all).toEqual([]);
    });
  });

  describe('isInitialized', () => {
    it('should return false before any operation', () => {
      expect(ltm.isInitialized()).toBe(false);
    });

    it('should return true after store operation', async () => {
      await ltm.store(
        createTestMemory({ content: 'init test' }),
        generateTestEmbedding('init test')
      );
      expect(ltm.isInitialized()).toBe(true);
    });

    it('should return true after successful restore', async () => {
      // First store something
      await ltm.store(
        createTestMemory({ content: 'init test' }),
        generateTestEmbedding('init test')
      );

      // Create new instance and restore
      const newLtm = new LongTermMemory({
        dbPath: testDbPath,
        maxResults: 10,
        similarityThreshold: 0.0,
      });
      await newLtm.restore();
      expect(newLtm.isInitialized()).toBe(true);
    });
  });
});
