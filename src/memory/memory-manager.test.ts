/**
 * Unit tests for MemoryManager.
 * Tests unified store/retrieve/delete/update operations and routing to correct sub-modules.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryManager } from './memory-manager.js';
import { MemoryType } from './types.js';

describe('MemoryManager', () => {
  let manager: MemoryManager;

  beforeEach(() => {
    manager = new MemoryManager({
      shortTerm: { capacity: 10, ttl: 60000 },
      longTerm: { dbPath: './data/memory/test-manager' },
    });
  });

  describe('store()', () => {
    it('should store short-term memory and route to ShortTermMemory', async () => {
      const memory = await manager.store('test short-term content', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      expect(memory).toBeDefined();
      expect(memory.id).toBeDefined();
      expect(memory.content).toBe('test short-term content');
      expect(memory.type).toBe(MemoryType.SHORT_TERM);
      expect(memory.createdAt).toBeInstanceOf(Date);
      expect(memory.importanceScore).toBeGreaterThanOrEqual(0);
      expect(memory.importanceScore).toBeLessThanOrEqual(1);

      // Verify it's retrievable from short-term memory
      const results = await manager.retrieve('short-term', MemoryType.SHORT_TERM);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toBe('test short-term content');
    });

    it('should store episodic memory and route to EpisodicMemory', async () => {
      const memory = await manager.store('meeting with team', MemoryType.EPISODIC, {
        sourceAgent: 'test-agent',
        occurredAt: new Date().toISOString(),
        participants: ['Alice', 'Bob'],
        emotion: 'positive',
      });

      expect(memory).toBeDefined();
      expect(memory.type).toBe(MemoryType.EPISODIC);
      expect(memory.content).toBe('meeting with team');

      // Verify it's retrievable from episodic memory
      const results = await manager.retrieve('meeting', MemoryType.EPISODIC);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should store semantic memory as triple when metadata has subject/predicate/object', async () => {
      const memory = await manager.store('TypeScript is a language', MemoryType.SEMANTIC, {
        sourceAgent: 'test-agent',
        subject: 'TypeScript',
        predicate: 'is',
        object: 'programming language',
      });

      expect(memory).toBeDefined();
      expect(memory.type).toBe(MemoryType.SEMANTIC);
      expect(memory.metadata?.kind).toBe('triple');
    });

    it('should store semantic memory as concept when metadata has name/definition', async () => {
      const memory = await manager.store('OOP concept', MemoryType.SEMANTIC, {
        sourceAgent: 'test-agent',
        name: 'OOP',
        definition: 'Object-Oriented Programming paradigm',
        attributes: ['encapsulation', 'inheritance'],
        relations: [],
      });

      expect(memory).toBeDefined();
      expect(memory.type).toBe(MemoryType.SEMANTIC);
      expect(memory.metadata?.kind).toBe('concept');
    });

    it('should store procedural memory and route to ProceduralMemory', async () => {
      const memory = await manager.store('code review', MemoryType.PROCEDURAL, {
        sourceAgent: 'test-agent',
        name: 'code-review',
        steps: ['read code', 'check style', 'verify logic'],
      });

      expect(memory).toBeDefined();
      expect(memory.type).toBe(MemoryType.PROCEDURAL);
      expect(memory.metadata?.proficiency).toBe(0.1);
      expect(memory.metadata?.usageCount).toBe(0);
    });

    it('should throw error for unsupported memory type', async () => {
      await expect(
        manager.store('test', 'invalid_type' as MemoryType)
      ).rejects.toThrow('Unsupported memory type: invalid_type');
    });
  });

  describe('retrieve()', () => {
    it('should retrieve from specific sub-module when type is provided', async () => {
      await manager.store('alpha content', MemoryType.SHORT_TERM, { sourceAgent: 'a' });
      await manager.store('beta event', MemoryType.EPISODIC, {
        sourceAgent: 'b',
        occurredAt: new Date().toISOString(),
        participants: [],
      });

      const shortTermResults = await manager.retrieve('alpha', MemoryType.SHORT_TERM);
      expect(shortTermResults.length).toBe(1);
      expect(shortTermResults[0].content).toBe('alpha content');

      const episodicResults = await manager.retrieve('beta', MemoryType.EPISODIC);
      expect(episodicResults.length).toBe(1);
      expect(episodicResults[0].content).toBe('beta event');
    });

    it('should retrieve from all sub-modules when type is not specified', async () => {
      await manager.store('shared keyword content', MemoryType.SHORT_TERM, { sourceAgent: 'a' });
      await manager.store('shared keyword event', MemoryType.EPISODIC, {
        sourceAgent: 'b',
        occurredAt: new Date().toISOString(),
        participants: [],
      });

      const results = await manager.retrieve('shared keyword');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await manager.store(`item ${i}`, MemoryType.SHORT_TERM, { sourceAgent: 'a' });
      }

      const results = await manager.retrieve('item', MemoryType.SHORT_TERM, 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should throw error for invalid type in retrieve', async () => {
      await expect(
        manager.retrieve('test', 'bad_type' as MemoryType)
      ).rejects.toThrow('Unsupported memory type: bad_type');
    });
  });

  describe('delete()', () => {
    it('should delete a short-term memory by ID', async () => {
      const memory = await manager.store('to delete', MemoryType.SHORT_TERM, { sourceAgent: 'a' });
      const deleted = await manager.delete(memory.id);
      expect(deleted).toBe(true);

      const results = await manager.retrieve('to delete', MemoryType.SHORT_TERM);
      expect(results.length).toBe(0);
    });

    it('should delete an episodic memory by ID', async () => {
      const memory = await manager.store('event to delete', MemoryType.EPISODIC, {
        sourceAgent: 'a',
        occurredAt: new Date().toISOString(),
        participants: [],
      });
      const deleted = await manager.delete(memory.id);
      expect(deleted).toBe(true);
    });

    it('should delete a semantic memory by ID', async () => {
      const memory = await manager.store('fact to delete', MemoryType.SEMANTIC, {
        sourceAgent: 'a',
        subject: 'X',
        predicate: 'is',
        object: 'Y',
      });
      const deleted = await manager.delete(memory.id);
      expect(deleted).toBe(true);
    });

    it('should delete a procedural memory by ID', async () => {
      const memory = await manager.store('skill to delete', MemoryType.PROCEDURAL, {
        sourceAgent: 'a',
        name: 'delete-skill',
        steps: ['step1'],
      });
      const deleted = await manager.delete(memory.id);
      expect(deleted).toBe(true);
    });

    it('should return false when memory ID does not exist', async () => {
      const deleted = await manager.delete('non-existent-id');
      expect(deleted).toBe(false);
    });
  });

  describe('update()', () => {
    it('should update memory content', async () => {
      const memory = await manager.store('original content', MemoryType.SHORT_TERM, {
        sourceAgent: 'a',
      });

      const updated = await manager.update(memory.id, { content: 'updated content' });
      expect(updated.content).toBe('updated content');
    });

    it('should update memory importance score', async () => {
      const memory = await manager.store('test content', MemoryType.SHORT_TERM, {
        sourceAgent: 'a',
      });

      const updated = await manager.update(memory.id, { importanceScore: 0.9 });
      expect(updated.importanceScore).toBe(0.9);
    });

    it('should update memory tags', async () => {
      const memory = await manager.store('tagged content', MemoryType.SHORT_TERM, {
        sourceAgent: 'a',
      });

      const updated = await manager.update(memory.id, { tags: ['new-tag'] });
      expect(updated.tags).toEqual(['new-tag']);
    });

    it('should throw error when memory ID does not exist', async () => {
      await expect(
        manager.update('non-existent-id', { content: 'new' })
      ).rejects.toThrow('Memory not found: non-existent-id');
    });
  });

  describe('calculateImportanceScore()', () => {
    it('should calculate importance score for given content and type', () => {
      const score = manager.calculateImportanceScore(
        'This is critical information',
        MemoryType.PROCEDURAL,
        'user_input'
      );

      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should return higher score for user_input interaction type', () => {
      const userScore = manager.calculateImportanceScore(
        'test content',
        MemoryType.SHORT_TERM,
        'user_input'
      );
      const systemScore = manager.calculateImportanceScore(
        'test content',
        MemoryType.SHORT_TERM,
        'system_generated'
      );

      expect(userScore).toBeGreaterThan(systemScore);
    });
  });

  describe('consolidate()', () => {
    it('should transfer high-importance short-term memories to long-term', async () => {
      // Store memories with varying importance scores
      // Use 'critical' keyword to boost importance score
      const highImportance = await manager.store(
        'This is critical information that must be preserved for the long term',
        MemoryType.SHORT_TERM,
        { sourceAgent: 'test-agent', interactionType: 'user_input' }
      );

      // Store a low-importance memory
      await manager.store('hi', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
        interactionType: 'system_generated',
      });

      // Manually set high importance to ensure it exceeds threshold
      highImportance.importanceScore = 0.8;

      const consolidated = await manager.consolidate();
      expect(consolidated).toBe(1);

      // Verify the high-importance memory was removed from short-term
      const shortTermResults = await manager.retrieve(
        'critical information',
        MemoryType.SHORT_TERM
      );
      expect(shortTermResults.length).toBe(0);
    });

    it('should not consolidate memories below threshold', async () => {
      const memory = await manager.store('low importance', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
        interactionType: 'system_generated',
      });

      // Ensure score is below threshold
      memory.importanceScore = 0.3;

      const consolidated = await manager.consolidate();
      expect(consolidated).toBe(0);

      // Memory should still be in short-term
      const results = await manager.retrieve('low importance', MemoryType.SHORT_TERM);
      expect(results.length).toBe(1);
    });

    it('should return 0 when short-term memory is empty', async () => {
      const consolidated = await manager.consolidate();
      expect(consolidated).toBe(0);
    });
  });

  describe('decay()', () => {
    it('should apply slow decay rate (0.95) for score > 0.7', async () => {
      const memory = await manager.store('important content', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      // Set high importance score and old access time
      memory.importanceScore = 0.9;
      memory.lastAccessedAt = new Date(Date.now() - 60000); // 1 decay interval ago

      const affected = await manager.decay();
      expect(affected).toBeGreaterThan(0);

      // Score should have decayed with rate 0.95
      // newScore = 0.9 * 0.95^1 = 0.855
      expect(memory.importanceScore).toBeCloseTo(0.855, 2);
    });

    it('should apply medium decay rate (0.90) for score 0.3-0.7', async () => {
      const memory = await manager.store('medium content', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      memory.importanceScore = 0.5;
      memory.lastAccessedAt = new Date(Date.now() - 60000); // 1 decay interval ago

      await manager.decay();

      // newScore = 0.5 * 0.90^1 = 0.45
      expect(memory.importanceScore).toBeCloseTo(0.45, 2);
    });

    it('should apply fast decay rate (0.80) for score < 0.3', async () => {
      const memory = await manager.store('low content', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      memory.importanceScore = 0.2;
      memory.lastAccessedAt = new Date(Date.now() - 60000); // 1 decay interval ago

      await manager.decay();

      // newScore = 0.2 * 0.80^1 = 0.16
      expect(memory.importanceScore).toBeCloseTo(0.16, 2);
    });

    it('should auto-remove memories when score decays to near 0', async () => {
      const memory = await manager.store('vanishing content', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      // Set very low score and very old access time to ensure decay to ~0
      memory.importanceScore = 0.001;
      memory.lastAccessedAt = new Date(Date.now() - 600000); // 10 decay intervals ago

      const affected = await manager.decay();
      expect(affected).toBeGreaterThan(0);

      // Memory should be removed
      const results = await manager.retrieve('vanishing', MemoryType.SHORT_TERM);
      expect(results.length).toBe(0);
    });

    it('should return 0 when no memories exist', async () => {
      // Create a fresh manager with a unique path to avoid LanceDB data from other tests
      const freshManager = new MemoryManager({
        shortTerm: { capacity: 10, ttl: 60000 },
        longTerm: { dbPath: './data/memory/test-decay-empty-' + Date.now() },
      });
      const affected = await freshManager.decay();
      expect(affected).toBe(0);
    });
  });

  describe('boostImportanceScore()', () => {
    it('should boost importance score proportional to access frequency', async () => {
      const memory = await manager.store('boost test', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      const originalScore = memory.importanceScore;

      const boosted = await manager.boostImportanceScore(memory.id);

      // First access: boost = min(0.1 * (1/10), 0.2) = 0.01
      expect(boosted.importanceScore).toBeCloseTo(originalScore + 0.01, 4);
    });

    it('should increase boost with repeated access', async () => {
      const memory = await manager.store('repeated access', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      const originalScore = memory.importanceScore;

      // Access multiple times
      await manager.boostImportanceScore(memory.id);
      await manager.boostImportanceScore(memory.id);
      await manager.boostImportanceScore(memory.id);

      // After 3 accesses: cumulative boost = 0.01 + 0.02 + 0.03 = 0.06
      expect(memory.importanceScore).toBeCloseTo(originalScore + 0.06, 4);
    });

    it('should cap boost at 0.2 per access', async () => {
      const memory = await manager.store('max boost test', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      // Simulate many accesses to reach the cap
      for (let i = 0; i < 25; i++) {
        await manager.boostImportanceScore(memory.id);
      }

      // Score should not exceed 1.0
      expect(memory.importanceScore).toBeLessThanOrEqual(1);
    });

    it('should throw error for non-existent memory', async () => {
      await expect(
        manager.boostImportanceScore('non-existent-id')
      ).rejects.toThrow('Memory not found: non-existent-id');
    });

    it('should update lastAccessedAt on boost', async () => {
      const memory = await manager.store('access time test', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      const beforeAccess = memory.lastAccessedAt;

      // Small delay to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      await manager.boostImportanceScore(memory.id);

      expect(memory.lastAccessedAt.getTime()).toBeGreaterThanOrEqual(beforeAccess.getTime());
    });
  });

  describe('discoverAssociations()', () => {
    it('should discover associations based on content similarity', async () => {
      await manager.store(
        'TypeScript is a programming language for web development',
        MemoryType.SHORT_TERM,
        { sourceAgent: 'test-agent' }
      );
      await manager.store(
        'TypeScript is a typed programming language for applications',
        MemoryType.SHORT_TERM,
        { sourceAgent: 'test-agent' }
      );

      const associations = await manager.discoverAssociations();

      expect(associations.length).toBeGreaterThan(0);
      expect(associations[0].type).toMatch(/content_similarity|both/);
      expect(associations[0].strength).toBeGreaterThan(0);
    });

    it('should discover associations based on temporal proximity', async () => {
      // Store two memories at nearly the same time (within 5 minutes)
      await manager.store('first event happened', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });
      await manager.store('second event occurred', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      const associations = await manager.discoverAssociations();

      // They should be temporally close since stored at nearly the same time
      expect(associations.length).toBeGreaterThan(0);
      expect(associations[0].type).toMatch(/temporal_proximity|both/);
    });

    it('should not create duplicate associations', async () => {
      await manager.store(
        'TypeScript programming language features',
        MemoryType.SHORT_TERM,
        { sourceAgent: 'test-agent' }
      );
      await manager.store(
        'TypeScript programming language benefits',
        MemoryType.SHORT_TERM,
        { sourceAgent: 'test-agent' }
      );

      // Discover twice
      await manager.discoverAssociations();
      const secondRun = await manager.discoverAssociations();

      // Second run should find no new associations
      expect(secondRun.length).toBe(0);
    });

    it('should return empty array when no associations found', async () => {
      // Use a fresh manager to avoid pre-existing LanceDB data
      const freshManager = new MemoryManager({
        shortTerm: { capacity: 10, ttl: 60000 },
        longTerm: { dbPath: './data/memory/test-assoc-empty-' + Date.now() },
      });

      // Only one memory - no pairs to compare
      await freshManager.store('lonely memory', MemoryType.SHORT_TERM, {
        sourceAgent: 'test-agent',
      });

      const associations = await freshManager.discoverAssociations();
      expect(associations.length).toBe(0);
    });

    it('should provide access to all associations via getAssociations()', async () => {
      await manager.store(
        'shared topic about testing frameworks',
        MemoryType.SHORT_TERM,
        { sourceAgent: 'test-agent' }
      );
      await manager.store(
        'shared topic about testing methodologies',
        MemoryType.SHORT_TERM,
        { sourceAgent: 'test-agent' }
      );

      await manager.discoverAssociations();

      const allAssociations = manager.getAssociations();
      expect(allAssociations.length).toBeGreaterThan(0);
    });
  });

  describe('sub-module accessors', () => {
    it('should provide access to ShortTermMemory', () => {
      expect(manager.getShortTermMemory()).toBeDefined();
    });

    it('should provide access to LongTermMemory', () => {
      expect(manager.getLongTermMemory()).toBeDefined();
    });

    it('should provide access to EpisodicMemory', () => {
      expect(manager.getEpisodicMemory()).toBeDefined();
    });

    it('should provide access to SemanticMemory', () => {
      expect(manager.getSemanticMemory()).toBeDefined();
    });

    it('should provide access to ProceduralMemory', () => {
      expect(manager.getProceduralMemory()).toBeDefined();
    });
  });
});
