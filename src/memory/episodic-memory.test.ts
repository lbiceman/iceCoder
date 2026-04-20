/**
 * Unit tests for EpisodicMemory module.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EpisodicMemory } from './episodic-memory.js';
import { EpisodicEvent, MemoryType } from './types.js';

describe('EpisodicMemory', () => {
  let episodicMemory: EpisodicMemory;

  beforeEach(() => {
    episodicMemory = new EpisodicMemory();
  });

  describe('store()', () => {
    it('should store an episodic event and return a Memory object', async () => {
      const event: EpisodicEvent = {
        description: 'Agent completed requirement analysis',
        occurredAt: new Date('2024-01-15T10:00:00Z'),
        participants: ['agent-1', 'orchestrator'],
      };

      const memory = await episodicMemory.store(event, 'agent-1');

      expect(memory.id).toBeDefined();
      expect(memory.content).toBe('Agent completed requirement analysis');
      expect(memory.type).toBe(MemoryType.EPISODIC);
      expect(memory.sourceAgent).toBe('agent-1');
      expect(memory.metadata?.description).toBe('Agent completed requirement analysis');
      expect(memory.metadata?.occurredAt).toBe('2024-01-15T10:00:00.000Z');
      expect(memory.metadata?.participants).toEqual(['agent-1', 'orchestrator']);
    });

    it('should store event with optional fields', async () => {
      const event: EpisodicEvent = {
        description: 'Pipeline stage failed',
        occurredAt: new Date('2024-01-15T10:00:00Z'),
        endedAt: new Date('2024-01-15T10:05:00Z'),
        participants: ['testing-agent'],
        emotion: 'concern',
      };

      const memory = await episodicMemory.store(event, 'testing-agent');

      expect(memory.metadata?.endedAt).toBe('2024-01-15T10:05:00.000Z');
      expect(memory.metadata?.emotion).toBe('concern');
    });

    it('should throw error when description is empty', async () => {
      const event: EpisodicEvent = {
        description: '',
        occurredAt: new Date('2024-01-15T10:00:00Z'),
        participants: [],
      };

      await expect(episodicMemory.store(event, 'agent-1')).rejects.toThrow(
        'Missing required field: description'
      );
    });

    it('should throw error when description is whitespace only', async () => {
      const event: EpisodicEvent = {
        description: '   ',
        occurredAt: new Date('2024-01-15T10:00:00Z'),
        participants: [],
      };

      await expect(episodicMemory.store(event, 'agent-1')).rejects.toThrow(
        'Missing required field: description'
      );
    });

    it('should throw error when occurredAt is missing', async () => {
      const event = {
        description: 'Some event',
        occurredAt: null,
        participants: [],
      } as unknown as EpisodicEvent;

      await expect(episodicMemory.store(event, 'agent-1')).rejects.toThrow(
        'Missing required field: occurredAt'
      );
    });
  });

  describe('queryByTimeRange()', () => {
    it('should return events within the specified time range', async () => {
      const events: EpisodicEvent[] = [
        { description: 'Event 1', occurredAt: new Date('2024-01-10T10:00:00Z'), participants: [] },
        { description: 'Event 2', occurredAt: new Date('2024-01-15T10:00:00Z'), participants: [] },
        { description: 'Event 3', occurredAt: new Date('2024-01-20T10:00:00Z'), participants: [] },
        { description: 'Event 4', occurredAt: new Date('2024-01-25T10:00:00Z'), participants: [] },
      ];

      for (const event of events) {
        await episodicMemory.store(event, 'agent-1');
      }

      const results = await episodicMemory.queryByTimeRange(
        new Date('2024-01-12T00:00:00Z'),
        new Date('2024-01-22T00:00:00Z')
      );

      expect(results).toHaveLength(2);
      expect(results[0].metadata?.description).toBe('Event 2');
      expect(results[1].metadata?.description).toBe('Event 3');
    });

    it('should return events sorted by occurredAt ascending', async () => {
      // Store events out of order
      await episodicMemory.store(
        { description: 'Late event', occurredAt: new Date('2024-01-20T10:00:00Z'), participants: [] },
        'agent-1'
      );
      await episodicMemory.store(
        { description: 'Early event', occurredAt: new Date('2024-01-10T10:00:00Z'), participants: [] },
        'agent-1'
      );
      await episodicMemory.store(
        { description: 'Middle event', occurredAt: new Date('2024-01-15T10:00:00Z'), participants: [] },
        'agent-1'
      );

      const results = await episodicMemory.queryByTimeRange(
        new Date('2024-01-01T00:00:00Z'),
        new Date('2024-01-31T00:00:00Z')
      );

      expect(results).toHaveLength(3);
      expect(results[0].metadata?.description).toBe('Early event');
      expect(results[1].metadata?.description).toBe('Middle event');
      expect(results[2].metadata?.description).toBe('Late event');
    });

    it('should return empty array when no events match the time range', async () => {
      await episodicMemory.store(
        { description: 'Event', occurredAt: new Date('2024-01-10T10:00:00Z'), participants: [] },
        'agent-1'
      );

      const results = await episodicMemory.queryByTimeRange(
        new Date('2024-02-01T00:00:00Z'),
        new Date('2024-02-28T00:00:00Z')
      );

      expect(results).toHaveLength(0);
    });
  });

  describe('queryByParticipant()', () => {
    it('should return all events for a given participant', async () => {
      await episodicMemory.store(
        { description: 'Event A', occurredAt: new Date('2024-01-10T10:00:00Z'), participants: ['alice', 'bob'] },
        'agent-1'
      );
      await episodicMemory.store(
        { description: 'Event B', occurredAt: new Date('2024-01-11T10:00:00Z'), participants: ['bob', 'charlie'] },
        'agent-1'
      );
      await episodicMemory.store(
        { description: 'Event C', occurredAt: new Date('2024-01-12T10:00:00Z'), participants: ['alice'] },
        'agent-1'
      );

      const aliceEvents = await episodicMemory.queryByParticipant('alice');
      expect(aliceEvents).toHaveLength(2);
      expect(aliceEvents.map((m) => m.metadata?.description)).toContain('Event A');
      expect(aliceEvents.map((m) => m.metadata?.description)).toContain('Event C');

      const bobEvents = await episodicMemory.queryByParticipant('bob');
      expect(bobEvents).toHaveLength(2);

      const charlieEvents = await episodicMemory.queryByParticipant('charlie');
      expect(charlieEvents).toHaveLength(1);
      expect(charlieEvents[0].metadata?.description).toBe('Event B');
    });

    it('should return empty array when participant has no events', async () => {
      await episodicMemory.store(
        { description: 'Event', occurredAt: new Date('2024-01-10T10:00:00Z'), participants: ['alice'] },
        'agent-1'
      );

      const results = await episodicMemory.queryByParticipant('unknown');
      expect(results).toHaveLength(0);
    });
  });

  describe('consolidateEvents()', () => {
    it('should merge multiple events into a summary record', async () => {
      const m1 = await episodicMemory.store(
        { description: 'Started analysis', occurredAt: new Date('2024-01-10T10:00:00Z'), participants: ['agent-1'] },
        'agent-1'
      );
      const m2 = await episodicMemory.store(
        { description: 'Completed analysis', occurredAt: new Date('2024-01-10T11:00:00Z'), participants: ['agent-1', 'agent-2'] },
        'agent-1'
      );

      const consolidated = await episodicMemory.consolidateEvents([m1.id, m2.id]);

      expect(consolidated.content).toBe('Started analysis; Completed analysis');
      expect(consolidated.type).toBe(MemoryType.EPISODIC);
      expect(consolidated.metadata?.consolidatedFrom).toEqual([m1.id, m2.id]);
      expect(consolidated.metadata?.participants).toContain('agent-1');
      expect(consolidated.metadata?.participants).toContain('agent-2');
    });

    it('should use earliest occurredAt and latest endedAt', async () => {
      const m1 = await episodicMemory.store(
        { description: 'First', occurredAt: new Date('2024-01-10T10:00:00Z'), endedAt: new Date('2024-01-10T10:30:00Z'), participants: [] },
        'agent-1'
      );
      const m2 = await episodicMemory.store(
        { description: 'Second', occurredAt: new Date('2024-01-10T11:00:00Z'), endedAt: new Date('2024-01-10T12:00:00Z'), participants: [] },
        'agent-1'
      );

      const consolidated = await episodicMemory.consolidateEvents([m1.id, m2.id]);

      expect(consolidated.metadata?.occurredAt).toBe('2024-01-10T10:00:00.000Z');
      expect(consolidated.metadata?.endedAt).toBe('2024-01-10T12:00:00.000Z');
    });

    it('should throw error when no matching events are found', async () => {
      await expect(
        episodicMemory.consolidateEvents(['non-existent-id'])
      ).rejects.toThrow('No matching events found for consolidation');
    });
  });

  describe('getAll()', () => {
    it('should return all stored memories', async () => {
      await episodicMemory.store(
        { description: 'Event 1', occurredAt: new Date('2024-01-10T10:00:00Z'), participants: [] },
        'agent-1'
      );
      await episodicMemory.store(
        { description: 'Event 2', occurredAt: new Date('2024-01-11T10:00:00Z'), participants: [] },
        'agent-1'
      );

      const all = await episodicMemory.getAll();
      expect(all).toHaveLength(2);
    });
  });

  describe('remove()', () => {
    it('should remove a memory by ID', async () => {
      const memory = await episodicMemory.store(
        { description: 'To remove', occurredAt: new Date('2024-01-10T10:00:00Z'), participants: [] },
        'agent-1'
      );

      const removed = await episodicMemory.remove(memory.id);
      expect(removed).toBe(true);

      const all = await episodicMemory.getAll();
      expect(all).toHaveLength(0);
    });

    it('should return false when memory ID does not exist', async () => {
      const removed = await episodicMemory.remove('non-existent');
      expect(removed).toBe(false);
    });
  });
});
