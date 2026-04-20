/**
 * Unit tests for ProceduralMemory module.
 * Tests skill storage, execution recording, proficiency updates, mastery marking,
 * querying by name, and listing by proficiency.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProceduralMemory } from './procedural-memory.js';
import { MemoryType } from './types.js';

describe('ProceduralMemory', () => {
  let proceduralMemory: ProceduralMemory;

  beforeEach(() => {
    proceduralMemory = new ProceduralMemory();
  });

  describe('store()', () => {
    it('should store a skill with initial proficiency=0.1 and usageCount=0', async () => {
      const memory = await proceduralMemory.store({
        name: 'code-review',
        steps: ['read code', 'check style', 'verify logic'],
        lastUsedAt: new Date('2024-01-01'),
      });

      expect(memory.type).toBe(MemoryType.PROCEDURAL);
      expect(memory.metadata?.name).toBe('code-review');
      expect(memory.metadata?.steps).toEqual(['read code', 'check style', 'verify logic']);
      expect(memory.metadata?.proficiency).toBe(0.1);
      expect(memory.metadata?.usageCount).toBe(0);
      expect(memory.metadata?.mastered).toBe(false);
    });

    it('should generate a unique ID for each stored skill', async () => {
      const memory1 = await proceduralMemory.store({
        name: 'skill-a',
        steps: ['step1'],
        lastUsedAt: new Date(),
      });
      const memory2 = await proceduralMemory.store({
        name: 'skill-b',
        steps: ['step1'],
        lastUsedAt: new Date(),
      });

      expect(memory1.id).not.toBe(memory2.id);
    });
  });

  describe('recordExecution()', () => {
    it('should increment usage count on each execution', async () => {
      await proceduralMemory.store({
        name: 'testing',
        steps: ['write test', 'run test'],
        lastUsedAt: new Date(),
      });

      const result1 = await proceduralMemory.recordExecution('testing', true);
      expect(result1.usageCount).toBe(1);

      const result2 = await proceduralMemory.recordExecution('testing', true);
      expect(result2.usageCount).toBe(2);
    });

    it('should update proficiency based on success rate', async () => {
      await proceduralMemory.store({
        name: 'debugging',
        steps: ['identify bug', 'fix bug', 'verify fix'],
        lastUsedAt: new Date(),
      });

      // First execution: success
      const result1 = await proceduralMemory.recordExecution('debugging', true);
      // successRate = 1/1 = 1.0, newProficiency = 0.5 * 1.0 + 0.5 * 0.1 = 0.55
      expect(result1.proficiency).toBeCloseTo(0.55, 5);

      // Second execution: failure
      const result2 = await proceduralMemory.recordExecution('debugging', false);
      // successRate = 1/2 = 0.5, newProficiency = 0.5 * 0.5 + 0.5 * 0.55 = 0.525
      expect(result2.proficiency).toBeCloseTo(0.525, 5);
    });

    it('should mark skill as mastered when proficiency reaches 0.8', async () => {
      await proceduralMemory.store({
        name: 'refactoring',
        steps: ['identify smell', 'apply pattern', 'verify'],
        lastUsedAt: new Date(),
      });

      // Execute many successful times to reach mastery
      let result;
      for (let i = 0; i < 20; i++) {
        result = await proceduralMemory.recordExecution('refactoring', true);
      }

      expect(result!.mastered).toBe(true);
      expect(result!.proficiency).toBeGreaterThanOrEqual(0.8);
    });

    it('should not mark skill as mastered when proficiency is below 0.8', async () => {
      await proceduralMemory.store({
        name: 'new-skill',
        steps: ['step1'],
        lastUsedAt: new Date(),
      });

      // One successful execution: proficiency = 0.5 * 1.0 + 0.5 * 0.1 = 0.55
      const result = await proceduralMemory.recordExecution('new-skill', true);
      expect(result.mastered).toBe(false);
    });

    it('should throw error when skill is not found', async () => {
      await expect(
        proceduralMemory.recordExecution('nonexistent', true)
      ).rejects.toThrow('Skill not found: nonexistent');
    });

    it('should update lastUsedAt on execution', async () => {
      await proceduralMemory.store({
        name: 'timing-skill',
        steps: ['step1'],
        lastUsedAt: new Date('2020-01-01'),
      });

      const before = new Date();
      const result = await proceduralMemory.recordExecution('timing-skill', true);
      const after = new Date();

      expect(result.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.lastUsedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('queryByName()', () => {
    it('should return skill data for an existing skill', async () => {
      await proceduralMemory.store({
        name: 'query-test',
        steps: ['a', 'b', 'c'],
        lastUsedAt: new Date('2024-06-15'),
      });

      const skill = await proceduralMemory.queryByName('query-test');
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('query-test');
      expect(skill!.steps).toEqual(['a', 'b', 'c']);
      expect(skill!.proficiency).toBe(0.1);
      expect(skill!.usageCount).toBe(0);
      expect(skill!.mastered).toBe(false);
    });

    it('should return null for a non-existent skill', async () => {
      const skill = await proceduralMemory.queryByName('does-not-exist');
      expect(skill).toBeNull();
    });

    it('should return updated proficiency and usage stats after executions', async () => {
      await proceduralMemory.store({
        name: 'evolving-skill',
        steps: ['step1'],
        lastUsedAt: new Date(),
      });

      await proceduralMemory.recordExecution('evolving-skill', true);
      await proceduralMemory.recordExecution('evolving-skill', true);

      const skill = await proceduralMemory.queryByName('evolving-skill');
      expect(skill!.usageCount).toBe(2);
      expect(skill!.proficiency).toBeGreaterThan(0.1);
    });
  });

  describe('listByProficiency()', () => {
    it('should return all skills sorted by proficiency descending', async () => {
      await proceduralMemory.store({
        name: 'low-skill',
        steps: ['step1'],
        lastUsedAt: new Date(),
      });

      await proceduralMemory.store({
        name: 'high-skill',
        steps: ['step1'],
        lastUsedAt: new Date(),
      });

      // Boost high-skill proficiency
      await proceduralMemory.recordExecution('high-skill', true);
      await proceduralMemory.recordExecution('high-skill', true);
      await proceduralMemory.recordExecution('high-skill', true);

      const skills = await proceduralMemory.listByProficiency();
      expect(skills.length).toBe(2);
      expect(skills[0].name).toBe('high-skill');
      expect(skills[1].name).toBe('low-skill');
      expect(skills[0].proficiency).toBeGreaterThan(skills[1].proficiency);
    });

    it('should return empty array when no skills are stored', async () => {
      const skills = await proceduralMemory.listByProficiency();
      expect(skills).toEqual([]);
    });
  });

  describe('getAll()', () => {
    it('should return all stored memories', async () => {
      await proceduralMemory.store({
        name: 'skill-1',
        steps: ['s1'],
        lastUsedAt: new Date(),
      });
      await proceduralMemory.store({
        name: 'skill-2',
        steps: ['s2'],
        lastUsedAt: new Date(),
      });

      const all = await proceduralMemory.getAll();
      expect(all.length).toBe(2);
    });
  });

  describe('remove()', () => {
    it('should remove a memory by ID', async () => {
      const memory = await proceduralMemory.store({
        name: 'removable',
        steps: ['step1'],
        lastUsedAt: new Date(),
      });

      const removed = await proceduralMemory.remove(memory.id);
      expect(removed).toBe(true);

      const skill = await proceduralMemory.queryByName('removable');
      expect(skill).toBeNull();
    });

    it('should return false for non-existent memory ID', async () => {
      const removed = await proceduralMemory.remove('non-existent-id');
      expect(removed).toBe(false);
    });
  });
});
