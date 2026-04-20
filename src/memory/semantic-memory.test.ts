import { describe, it, expect, beforeEach } from 'vitest';
import { SemanticMemory } from './semantic-memory.js';
import { MemoryType } from './types.js';

describe('SemanticMemory', () => {
  let semanticMemory: SemanticMemory;

  beforeEach(() => {
    semanticMemory = new SemanticMemory();
  });

  describe('storeTriple()', () => {
    it('should store a valid triple and return a Memory object', async () => {
      const triple = { subject: 'TypeScript', predicate: 'is', object: 'a programming language' };
      const memory = await semanticMemory.storeTriple(triple, 'test-agent');

      expect(memory.id).toBeDefined();
      expect(memory.type).toBe(MemoryType.SEMANTIC);
      expect(memory.sourceAgent).toBe('test-agent');
      expect(memory.metadata?.kind).toBe('triple');
      expect(memory.metadata?.subject).toBe('TypeScript');
      expect(memory.metadata?.predicate).toBe('is');
      expect(memory.metadata?.object).toBe('a programming language');
    });

    it('should throw error when subject is empty', async () => {
      const triple = { subject: '', predicate: 'is', object: 'something' };
      await expect(semanticMemory.storeTriple(triple, 'test-agent')).rejects.toThrow(
        'Missing required field: subject'
      );
    });

    it('should throw error when subject is whitespace only', async () => {
      const triple = { subject: '   ', predicate: 'is', object: 'something' };
      await expect(semanticMemory.storeTriple(triple, 'test-agent')).rejects.toThrow(
        'Missing required field: subject'
      );
    });

    it('should throw error when predicate is empty', async () => {
      const triple = { subject: 'Node.js', predicate: '', object: 'something' };
      await expect(semanticMemory.storeTriple(triple, 'test-agent')).rejects.toThrow(
        'Missing required field: predicate'
      );
    });

    it('should throw error when object is empty', async () => {
      const triple = { subject: 'Node.js', predicate: 'uses', object: '' };
      await expect(semanticMemory.storeTriple(triple, 'test-agent')).rejects.toThrow(
        'Missing required field: object'
      );
    });
  });

  describe('storeConcept()', () => {
    it('should store a concept and return a Memory object', async () => {
      const concept = {
        name: 'TypeScript',
        definition: 'A typed superset of JavaScript',
        attributes: ['typed', 'compiled', 'object-oriented'],
        relations: [{ target: 'JavaScript', type: 'extends' }],
      };
      const memory = await semanticMemory.storeConcept(concept, 'test-agent');

      expect(memory.id).toBeDefined();
      expect(memory.type).toBe(MemoryType.SEMANTIC);
      expect(memory.sourceAgent).toBe('test-agent');
      expect(memory.metadata?.kind).toBe('concept');
      expect(memory.metadata?.name).toBe('TypeScript');
      expect(memory.metadata?.definition).toBe('A typed superset of JavaScript');
      expect(memory.metadata?.attributes).toEqual(['typed', 'compiled', 'object-oriented']);
      expect(memory.metadata?.relations).toEqual([{ target: 'JavaScript', type: 'extends' }]);
    });
  });

  describe('queryBySubject()', () => {
    it('should return triples matching the given subject', async () => {
      await semanticMemory.storeTriple({ subject: 'Node.js', predicate: 'is', object: 'a runtime' }, 'agent');
      await semanticMemory.storeTriple({ subject: 'Node.js', predicate: 'uses', object: 'V8 engine' }, 'agent');
      await semanticMemory.storeTriple({ subject: 'Python', predicate: 'is', object: 'a language' }, 'agent');

      const results = await semanticMemory.queryBySubject('Node.js');

      expect(results).toHaveLength(2);
      expect(results[0].subject).toBe('Node.js');
      expect(results[1].subject).toBe('Node.js');
    });

    it('should return empty array when no triples match', async () => {
      await semanticMemory.storeTriple({ subject: 'Node.js', predicate: 'is', object: 'a runtime' }, 'agent');

      const results = await semanticMemory.queryBySubject('Rust');
      expect(results).toHaveLength(0);
    });

    it('should not return concepts when querying by subject', async () => {
      await semanticMemory.storeConcept(
        { name: 'Node.js', definition: 'A runtime', attributes: [], relations: [] },
        'agent'
      );

      const results = await semanticMemory.queryBySubject('Node.js');
      expect(results).toHaveLength(0);
    });
  });

  describe('queryByPredicate()', () => {
    it('should return triples matching the given predicate', async () => {
      await semanticMemory.storeTriple({ subject: 'Node.js', predicate: 'uses', object: 'V8' }, 'agent');
      await semanticMemory.storeTriple({ subject: 'Deno', predicate: 'uses', object: 'V8' }, 'agent');
      await semanticMemory.storeTriple({ subject: 'Node.js', predicate: 'is', object: 'a runtime' }, 'agent');

      const results = await semanticMemory.queryByPredicate('uses');

      expect(results).toHaveLength(2);
      expect(results[0].predicate).toBe('uses');
      expect(results[1].predicate).toBe('uses');
    });

    it('should return empty array when no triples match the predicate', async () => {
      await semanticMemory.storeTriple({ subject: 'Node.js', predicate: 'is', object: 'a runtime' }, 'agent');

      const results = await semanticMemory.queryByPredicate('extends');
      expect(results).toHaveLength(0);
    });
  });

  describe('queryKnowledgeGraph()', () => {
    beforeEach(async () => {
      // Build a small knowledge graph:
      // TypeScript -> extends -> JavaScript
      // JavaScript -> runs_on -> V8
      // V8 -> developed_by -> Google
      await semanticMemory.storeConcept(
        {
          name: 'TypeScript',
          definition: 'A typed superset of JavaScript',
          attributes: ['typed', 'compiled'],
          relations: [{ target: 'JavaScript', type: 'extends' }],
        },
        'agent'
      );
      await semanticMemory.storeConcept(
        {
          name: 'JavaScript',
          definition: 'A dynamic programming language',
          attributes: ['dynamic', 'interpreted'],
          relations: [{ target: 'V8', type: 'runs_on' }],
        },
        'agent'
      );
      await semanticMemory.storeConcept(
        {
          name: 'V8',
          definition: 'A JavaScript engine',
          attributes: ['fast', 'JIT-compiled'],
          relations: [{ target: 'Google', type: 'developed_by' }],
        },
        'agent'
      );
      await semanticMemory.storeConcept(
        {
          name: 'Google',
          definition: 'A technology company',
          attributes: ['large', 'innovative'],
          relations: [],
        },
        'agent'
      );
    });

    it('should return only the start concept at depth 0', async () => {
      const results = await semanticMemory.queryKnowledgeGraph('TypeScript', 0);

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('TypeScript');
    });

    it('should traverse one level at depth 1', async () => {
      const results = await semanticMemory.queryKnowledgeGraph('TypeScript', 1);

      expect(results).toHaveLength(2);
      expect(results.map((c) => c.name)).toContain('TypeScript');
      expect(results.map((c) => c.name)).toContain('JavaScript');
    });

    it('should traverse two levels at depth 2', async () => {
      const results = await semanticMemory.queryKnowledgeGraph('TypeScript', 2);

      expect(results).toHaveLength(3);
      expect(results.map((c) => c.name)).toContain('TypeScript');
      expect(results.map((c) => c.name)).toContain('JavaScript');
      expect(results.map((c) => c.name)).toContain('V8');
    });

    it('should traverse the full graph at sufficient depth', async () => {
      const results = await semanticMemory.queryKnowledgeGraph('TypeScript', 10);

      expect(results).toHaveLength(4);
      expect(results.map((c) => c.name)).toContain('Google');
    });

    it('should return empty array when start concept does not exist', async () => {
      const results = await semanticMemory.queryKnowledgeGraph('Rust', 5);
      expect(results).toHaveLength(0);
    });

    it('should not revisit already visited concepts (handles cycles)', async () => {
      // Add a cycle: Google -> uses -> TypeScript
      await semanticMemory.storeConcept(
        {
          name: 'CyclicA',
          definition: 'Concept A',
          attributes: [],
          relations: [{ target: 'CyclicB', type: 'links_to' }],
        },
        'agent'
      );
      await semanticMemory.storeConcept(
        {
          name: 'CyclicB',
          definition: 'Concept B',
          attributes: [],
          relations: [{ target: 'CyclicA', type: 'links_to' }],
        },
        'agent'
      );

      const results = await semanticMemory.queryKnowledgeGraph('CyclicA', 10);

      expect(results).toHaveLength(2);
      expect(results.map((c) => c.name)).toContain('CyclicA');
      expect(results.map((c) => c.name)).toContain('CyclicB');
    });
  });

  describe('getAll()', () => {
    it('should return all stored memories', async () => {
      await semanticMemory.storeTriple({ subject: 'A', predicate: 'is', object: 'B' }, 'agent');
      await semanticMemory.storeConcept(
        { name: 'C', definition: 'def', attributes: [], relations: [] },
        'agent'
      );

      const all = await semanticMemory.getAll();
      expect(all).toHaveLength(2);
    });
  });

  describe('remove()', () => {
    it('should remove a memory by ID', async () => {
      const memory = await semanticMemory.storeTriple(
        { subject: 'A', predicate: 'is', object: 'B' },
        'agent'
      );

      const removed = await semanticMemory.remove(memory.id);
      expect(removed).toBe(true);

      const all = await semanticMemory.getAll();
      expect(all).toHaveLength(0);
    });

    it('should return false when memory ID does not exist', async () => {
      const removed = await semanticMemory.remove('non-existent-id');
      expect(removed).toBe(false);
    });
  });
});
