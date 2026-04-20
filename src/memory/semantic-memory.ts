/**
 * Semantic Memory module for storing and querying knowledge as triples and concepts.
 * Supports subject-predicate-object triples, concept definitions, and knowledge graph traversal.
 */

import { Memory, MemoryType, Triple, Concept } from './types.js';
import { createMemory } from './memory.js';

/**
 * SemanticMemory manages fact-based and conceptual knowledge.
 * It stores knowledge as subject-predicate-object triples and concept definitions,
 * and supports queries by subject, predicate, and depth-limited knowledge graph traversal.
 */
export class SemanticMemory {
  private memories: Memory[] = [];

  /**
   * Store a subject-predicate-object triple as a Memory object.
   * Validates that subject, predicate, and object are all non-empty.
   *
   * @param triple - The triple to store
   * @param sourceAgent - The name of the agent storing this triple
   * @returns The created Memory object
   * @throws Error if subject, predicate, or object is empty
   */
  async storeTriple(triple: Triple, sourceAgent: string): Promise<Memory> {
    if (!triple.subject || triple.subject.trim() === '') {
      throw new Error('Missing required field: subject');
    }

    if (!triple.predicate || triple.predicate.trim() === '') {
      throw new Error('Missing required field: predicate');
    }

    if (!triple.object || triple.object.trim() === '') {
      throw new Error('Missing required field: object');
    }

    const content = `${triple.subject} ${triple.predicate} ${triple.object}`;

    const memory = createMemory({
      content,
      type: MemoryType.SEMANTIC,
      sourceAgent,
      tags: [triple.subject, triple.predicate, triple.object],
      metadata: {
        kind: 'triple',
        subject: triple.subject,
        predicate: triple.predicate,
        object: triple.object,
      },
    });

    this.memories.push(memory);
    return memory;
  }

  /**
   * Store a concept definition as a Memory object.
   *
   * @param concept - The concept to store
   * @param sourceAgent - The name of the agent storing this concept
   * @returns The created Memory object
   */
  async storeConcept(concept: Concept, sourceAgent: string): Promise<Memory> {
    const content = `${concept.name}: ${concept.definition}`;

    const memory = createMemory({
      content,
      type: MemoryType.SEMANTIC,
      sourceAgent,
      tags: [concept.name, ...concept.attributes],
      metadata: {
        kind: 'concept',
        name: concept.name,
        definition: concept.definition,
        attributes: concept.attributes,
        relations: concept.relations,
      },
    });

    this.memories.push(memory);
    return memory;
  }

  /**
   * Query all triples where the subject matches the given value.
   *
   * @param subject - The subject to search for
   * @returns Array of Triple objects matching the subject
   */
  async queryBySubject(subject: string): Promise<Triple[]> {
    return this.memories
      .filter(
        (memory) =>
          memory.metadata?.kind === 'triple' &&
          memory.metadata?.subject === subject
      )
      .map((memory) => ({
        subject: memory.metadata!.subject as string,
        predicate: memory.metadata!.predicate as string,
        object: memory.metadata!.object as string,
      }));
  }

  /**
   * Query all triples where the predicate matches the given value.
   *
   * @param predicate - The predicate to search for
   * @returns Array of Triple objects matching the predicate
   */
  async queryByPredicate(predicate: string): Promise<Triple[]> {
    return this.memories
      .filter(
        (memory) =>
          memory.metadata?.kind === 'triple' &&
          memory.metadata?.predicate === predicate
      )
      .map((memory) => ({
        subject: memory.metadata!.subject as string,
        predicate: memory.metadata!.predicate as string,
        object: memory.metadata!.object as string,
      }));
  }

  /**
   * Query the knowledge graph starting from a concept, traversing relations
   * up to a specified maximum depth using BFS.
   *
   * @param startConcept - The name of the concept to start traversal from
   * @param maxDepth - Maximum depth of traversal (0 returns only the start concept)
   * @returns Array of Concept objects reachable within maxDepth
   */
  async queryKnowledgeGraph(
    startConcept: string,
    maxDepth: number
  ): Promise<Concept[]> {
    const visited = new Set<string>();
    const result: Concept[] = [];

    // BFS queue: each entry is [conceptName, currentDepth]
    const queue: [string, number][] = [[startConcept, 0]];

    while (queue.length > 0) {
      const [conceptName, depth] = queue.shift()!;

      if (visited.has(conceptName)) {
        continue;
      }

      visited.add(conceptName);

      // Find the concept memory
      const conceptMemory = this.memories.find(
        (memory) =>
          memory.metadata?.kind === 'concept' &&
          memory.metadata?.name === conceptName
      );

      if (!conceptMemory) {
        continue;
      }

      const concept: Concept = {
        name: conceptMemory.metadata!.name as string,
        definition: conceptMemory.metadata!.definition as string,
        attributes: conceptMemory.metadata!.attributes as string[],
        relations: conceptMemory.metadata!.relations as {
          target: string;
          type: string;
        }[],
      };

      result.push(concept);

      // If we haven't reached max depth, enqueue related concepts
      if (depth < maxDepth) {
        for (const relation of concept.relations) {
          if (!visited.has(relation.target)) {
            queue.push([relation.target, depth + 1]);
          }
        }
      }
    }

    return result;
  }

  /**
   * Get all stored semantic memories.
   *
   * @returns Array of all stored Memory objects
   */
  async getAll(): Promise<Memory[]> {
    return [...this.memories];
  }

  /**
   * Remove a memory by its ID.
   *
   * @param memoryId - The ID of the memory to remove
   * @returns true if the memory was found and removed, false otherwise
   */
  async remove(memoryId: string): Promise<boolean> {
    const index = this.memories.findIndex((m) => m.id === memoryId);
    if (index === -1) {
      return false;
    }
    this.memories.splice(index, 1);
    return true;
  }
}
