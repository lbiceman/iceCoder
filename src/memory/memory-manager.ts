/**
 * MemoryManager coordinates all five memory sub-modules, providing a unified
 * interface for storing, retrieving, updating, and deleting memories.
 * Routes operations to the correct sub-module based on memory type.
 * Implements memory consolidation, decay, importance boosting, and association discovery.
 */

import { Memory, MemoryType, EpisodicEvent, Triple, Concept, Skill } from './types.js';
import { createMemory, calculateImportanceScore } from './memory.js';
import { ShortTermMemory, ShortTermMemoryConfig } from './short-term-memory.js';
import { LongTermMemory, LongTermMemoryConfig } from './long-term-memory.js';
import { EpisodicMemory } from './episodic-memory.js';
import { SemanticMemory } from './semantic-memory.js';
import { ProceduralMemory } from './procedural-memory.js';

/**
 * Configuration for the MemoryManager.
 */
export interface MemoryManagerConfig {
  shortTerm?: Partial<ShortTermMemoryConfig>;
  longTerm?: Partial<LongTermMemoryConfig>;
  /** Importance score threshold for consolidation (short-term → long-term) */
  consolidationThreshold?: number;
  /** Decay interval in milliseconds */
  decayInterval?: number;
}

/**
 * Association link between two memories.
 */
export interface MemoryAssociation {
  sourceId: string;
  targetId: string;
  strength: number; // 0-1 representing association strength
  type: 'content_similarity' | 'temporal_proximity' | 'both';
}

/** Default MemoryManager configuration */
const DEFAULT_CONFIG: Required<MemoryManagerConfig> = {
  shortTerm: { capacity: 100, ttl: 300000 },
  longTerm: { maxResults: 10, similarityThreshold: 0.5, dbPath: './data/memory' },
  consolidationThreshold: 0.6,
  decayInterval: 60000,
};

/**
 * Dimension for simple hash-based embeddings used with LongTermMemory.
 */
const EMBEDDING_DIMENSION = 128;

/**
 * MemoryManager provides a unified interface for all memory operations,
 * routing to the appropriate sub-module based on memory type.
 * Implements consolidation, decay, importance boosting, and association discovery.
 */
export class MemoryManager {
  private shortTermMemory: ShortTermMemory;
  private longTermMemory: LongTermMemory;
  private episodicMemory: EpisodicMemory;
  private semanticMemory: SemanticMemory;
  private proceduralMemory: ProceduralMemory;
  private config: Required<MemoryManagerConfig>;
  private associations: MemoryAssociation[] = [];
  private accessCounts: Map<string, number> = new Map();

  constructor(config?: MemoryManagerConfig) {
    this.config = {
      shortTerm: { ...DEFAULT_CONFIG.shortTerm, ...config?.shortTerm },
      longTerm: { ...DEFAULT_CONFIG.longTerm, ...config?.longTerm },
      consolidationThreshold: config?.consolidationThreshold ?? DEFAULT_CONFIG.consolidationThreshold,
      decayInterval: config?.decayInterval ?? DEFAULT_CONFIG.decayInterval,
    };

    this.shortTermMemory = new ShortTermMemory({
      capacity: (this.config.shortTerm as ShortTermMemoryConfig).capacity,
      ttl: (this.config.shortTerm as ShortTermMemoryConfig).ttl,
    });

    this.longTermMemory = new LongTermMemory(this.config.longTerm as Partial<LongTermMemoryConfig>);
    this.episodicMemory = new EpisodicMemory();
    this.semanticMemory = new SemanticMemory();
    this.proceduralMemory = new ProceduralMemory();
  }

  /**
   * Store a memory, routing to the correct sub-module based on type.
   *
   * @param content - The content to store
   * @param type - The memory type determining which sub-module to use
   * @param metadata - Optional metadata for the memory
   * @returns The created Memory object
   * @throws Error if the memory type is not supported
   */
  async store(content: string, type: MemoryType, metadata?: Record<string, any>): Promise<Memory> {
    this.validateMemoryType(type);

    switch (type) {
      case MemoryType.SHORT_TERM:
        return this.storeShortTerm(content, metadata);

      case MemoryType.LONG_TERM:
        return this.storeLongTerm(content, metadata);

      case MemoryType.EPISODIC:
        return this.storeEpisodic(content, metadata);

      case MemoryType.SEMANTIC:
        return this.storeSemantic(content, metadata);

      case MemoryType.PROCEDURAL:
        return this.storeProcedural(content, metadata);

      default:
        throw new Error(`Unsupported memory type: ${type}`);
    }
  }

  /**
   * Retrieve memories matching a query, optionally filtered by type.
   *
   * @param query - Search query string
   * @param type - Optional memory type to filter by (queries all if not specified)
   * @param limit - Maximum number of results to return
   * @returns Array of matching Memory objects
   */
  async retrieve(query: string, type?: MemoryType, limit: number = 10): Promise<Memory[]> {
    if (type) {
      this.validateMemoryType(type);
      return this.retrieveFromModule(query, type, limit);
    }

    // Query all sub-modules and merge results
    const results: Memory[] = [];

    const shortTermResults = await this.shortTermMemory.retrieve(query, limit);
    results.push(...shortTermResults);

    // For long-term memory, use a simple embedding of the query
    try {
      const queryEmbedding = this.generateSimpleEmbedding(query);
      const longTermResults = await this.longTermMemory.retrieve(queryEmbedding, limit);
      results.push(...longTermResults);
    } catch {
      // Long-term memory may not be initialized yet
    }

    const episodicAll = await this.episodicMemory.getAll();
    const episodicMatched = episodicAll
      .filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit);
    results.push(...episodicMatched);

    const semanticAll = await this.semanticMemory.getAll();
    const semanticMatched = semanticAll
      .filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit);
    results.push(...semanticMatched);

    const proceduralAll = await this.proceduralMemory.getAll();
    const proceduralMatched = proceduralAll
      .filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit);
    results.push(...proceduralMatched);

    // Sort by importance score descending and limit
    results.sort((a, b) => b.importanceScore - a.importanceScore);
    return results.slice(0, limit);
  }

  /**
   * Delete a memory by its ID. Tries all sub-modules since we may not know
   * which module holds the memory.
   *
   * @param memoryId - The unique identifier of the memory to delete
   * @returns true if the memory was found and deleted, false otherwise
   */
  async delete(memoryId: string): Promise<boolean> {
    // Try short-term memory
    const shortTermDeleted = await this.shortTermMemory.remove(memoryId);
    if (shortTermDeleted) return true;

    // Try episodic memory
    const episodicDeleted = await this.episodicMemory.remove(memoryId);
    if (episodicDeleted) return true;

    // Try semantic memory
    const semanticDeleted = await this.semanticMemory.remove(memoryId);
    if (semanticDeleted) return true;

    // Try procedural memory
    const proceduralDeleted = await this.proceduralMemory.remove(memoryId);
    if (proceduralDeleted) return true;

    // Try long-term memory last (LanceDB delete doesn't indicate if row existed)
    // First check if the memory exists in long-term storage
    try {
      const allLongTerm = await this.longTermMemory.getAll();
      const exists = allLongTerm.some(m => m.id === memoryId);
      if (exists) {
        await this.longTermMemory.delete(memoryId);
        return true;
      }
    } catch {
      // Long-term memory may not be initialized
    }

    return false;
  }

  /**
   * Update a memory by its ID. Finds the memory across all sub-modules
   * and applies the partial updates.
   *
   * @param memoryId - The unique identifier of the memory to update
   * @param updates - Partial Memory fields to update
   * @returns The updated Memory object
   * @throws Error if the memory is not found
   */
  async update(memoryId: string, updates: Partial<Memory>): Promise<Memory> {
    // Search all sub-modules for the memory
    const allMemories = await this.getAllMemories();
    const memory = allMemories.find(m => m.id === memoryId);

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    // Apply updates
    if (updates.content !== undefined) memory.content = updates.content;
    if (updates.importanceScore !== undefined) memory.importanceScore = updates.importanceScore;
    if (updates.tags !== undefined) memory.tags = updates.tags;
    if (updates.metadata !== undefined) memory.metadata = updates.metadata;
    if (updates.lastAccessedAt !== undefined) memory.lastAccessedAt = updates.lastAccessedAt;

    return memory;
  }

  /**
   * Consolidate short-term memories to long-term memory.
   * Transfers memories with importance score above the configurable threshold
   * to long-term memory with compression, then removes them from short-term.
   *
   * @returns Number of memories consolidated
   */
  async consolidate(): Promise<number> {
    const shortTermMemories = await this.shortTermMemory.getAll();
    let consolidatedCount = 0;

    for (const memory of shortTermMemories) {
      if (memory.importanceScore >= this.config.consolidationThreshold) {
        // Generate embedding and store in long-term memory
        const embedding = this.generateSimpleEmbedding(memory.content);
        try {
          await this.longTermMemory.store(memory, embedding);
          // Remove from short-term memory after successful transfer
          await this.shortTermMemory.remove(memory.id);
          consolidatedCount++;
        } catch {
          // If long-term storage fails, keep in short-term
        }
      }
    }

    return consolidatedCount;
  }

  /**
   * Apply decay to memory importance scores using segmented exponential decay.
   * 
   * Formula: newScore = currentScore * decayRate ^ (timeSinceLastAccess / decayInterval)
   * 
   * Decay rates:
   * - ImportanceScore > 0.7: decayRate = 0.95 (slow decay)
   * - 0.3 <= ImportanceScore <= 0.7: decayRate = 0.90 (medium decay)
   * - ImportanceScore < 0.3: decayRate = 0.80 (fast decay)
   * 
   * Memories with score decaying to near 0 (< 0.001) are auto-removed.
   *
   * @returns Number of memories affected by decay
   */
  async decay(): Promise<number> {
    const allMemories = await this.getAllMemories();
    let affectedCount = 0;
    const now = Date.now();
    const memoriesToRemove: { id: string; type: MemoryType }[] = [];

    for (const memory of allMemories) {
      const timeSinceLastAccess = now - memory.lastAccessedAt.getTime();

      // Only decay if some time has passed
      if (timeSinceLastAccess <= 0) {
        continue;
      }

      // Determine decay rate based on current importance score
      let decayRate: number;
      if (memory.importanceScore > 0.7) {
        decayRate = 0.95; // slow decay
      } else if (memory.importanceScore >= 0.3) {
        decayRate = 0.90; // medium decay
      } else {
        decayRate = 0.80; // fast decay
      }

      // Apply exponential decay
      const decayExponent = timeSinceLastAccess / this.config.decayInterval;
      const newScore = memory.importanceScore * Math.pow(decayRate, decayExponent);

      // Check if memory should be removed (score effectively 0)
      if (newScore < 0.001) {
        memoriesToRemove.push({ id: memory.id, type: memory.type });
        affectedCount++;
      } else if (newScore !== memory.importanceScore) {
        // Update the importance score
        memory.importanceScore = newScore;
        affectedCount++;
      }
    }

    // Remove memories that have decayed to 0
    for (const { id } of memoriesToRemove) {
      await this.delete(id);
    }

    return affectedCount;
  }

  /**
   * Boost the importance score of a memory based on repeated access.
   * The boost is proportional to access frequency.
   * Formula: boost = min(0.1 * (accessCount / 10), 0.2)
   *
   * @param memoryId - The ID of the memory to boost
   * @returns The updated Memory object
   * @throws Error if the memory is not found
   */
  async boostImportanceScore(memoryId: string): Promise<Memory> {
    const allMemories = await this.getAllMemories();
    const memory = allMemories.find(m => m.id === memoryId);

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    // Track access count
    const currentCount = (this.accessCounts.get(memoryId) ?? 0) + 1;
    this.accessCounts.set(memoryId, currentCount);

    // Calculate boost: min(0.1 * (accessCount / 10), 0.2)
    const boost = Math.min(0.1 * (currentCount / 10), 0.2);

    // Apply boost, clamping to [0, 1]
    memory.importanceScore = Math.min(1, memory.importanceScore + boost);
    memory.lastAccessedAt = new Date();

    return memory;
  }

  /**
   * Discover associations between memories based on content similarity
   * and temporal proximity. Creates association links in metadata.
   *
   * Content similarity is measured by word overlap (Jaccard similarity).
   * Temporal proximity is measured by closeness of creation timestamps.
   *
   * @returns Array of discovered associations
   */
  async discoverAssociations(): Promise<MemoryAssociation[]> {
    const allMemories = await this.getAllMemories();
    const newAssociations: MemoryAssociation[] = [];

    // Threshold for content similarity (Jaccard index)
    const CONTENT_SIMILARITY_THRESHOLD = 0.3;
    // Threshold for temporal proximity (within 5 minutes)
    const TEMPORAL_PROXIMITY_MS = 5 * 60 * 1000;

    for (let i = 0; i < allMemories.length; i++) {
      for (let j = i + 1; j < allMemories.length; j++) {
        const memA = allMemories[i];
        const memB = allMemories[j];

        // Check if association already exists
        const existingAssoc = this.associations.find(
          a => (a.sourceId === memA.id && a.targetId === memB.id) ||
               (a.sourceId === memB.id && a.targetId === memA.id)
        );
        if (existingAssoc) {
          continue;
        }

        // Calculate content similarity (word overlap / Jaccard)
        const contentSimilarity = this.calculateWordOverlap(memA.content, memB.content);

        // Calculate temporal proximity
        const timeDiff = Math.abs(memA.createdAt.getTime() - memB.createdAt.getTime());
        const isTemporallyClose = timeDiff <= TEMPORAL_PROXIMITY_MS;

        // Determine association type and strength
        const hasContentSimilarity = contentSimilarity >= CONTENT_SIMILARITY_THRESHOLD;

        if (hasContentSimilarity && isTemporallyClose) {
          const strength = (contentSimilarity + (1 - timeDiff / TEMPORAL_PROXIMITY_MS)) / 2;
          const association: MemoryAssociation = {
            sourceId: memA.id,
            targetId: memB.id,
            strength: Math.min(1, strength),
            type: 'both',
          };
          newAssociations.push(association);
          this.associations.push(association);
        } else if (hasContentSimilarity) {
          const association: MemoryAssociation = {
            sourceId: memA.id,
            targetId: memB.id,
            strength: contentSimilarity,
            type: 'content_similarity',
          };
          newAssociations.push(association);
          this.associations.push(association);
        } else if (isTemporallyClose) {
          const strength = 1 - timeDiff / TEMPORAL_PROXIMITY_MS;
          const association: MemoryAssociation = {
            sourceId: memA.id,
            targetId: memB.id,
            strength,
            type: 'temporal_proximity',
          };
          newAssociations.push(association);
          this.associations.push(association);
        }
      }
    }

    return newAssociations;
  }

  /**
   * Get all discovered associations.
   */
  getAssociations(): MemoryAssociation[] {
    return [...this.associations];
  }

  /**
   * Get the access count for a specific memory.
   */
  getAccessCount(memoryId: string): number {
    return this.accessCounts.get(memoryId) ?? 0;
  }

  /**
   * Calculate the importance score for a memory.
   *
   * @param content - The memory content
   * @param type - The memory type
   * @param interactionType - Optional interaction type
   * @returns The calculated importance score (0-1)
   */
  calculateImportanceScore(content: string, type: MemoryType, interactionType?: string): number {
    return calculateImportanceScore(content, type, interactionType);
  }

  /**
   * Get the ShortTermMemory sub-module (for direct access when needed).
   */
  getShortTermMemory(): ShortTermMemory {
    return this.shortTermMemory;
  }

  /**
   * Get the LongTermMemory sub-module (for direct access when needed).
   */
  getLongTermMemory(): LongTermMemory {
    return this.longTermMemory;
  }

  /**
   * Get the EpisodicMemory sub-module (for direct access when needed).
   */
  getEpisodicMemory(): EpisodicMemory {
    return this.episodicMemory;
  }

  /**
   * Get the SemanticMemory sub-module (for direct access when needed).
   */
  getSemanticMemory(): SemanticMemory {
    return this.semanticMemory;
  }

  /**
   * Get the ProceduralMemory sub-module (for direct access when needed).
   */
  getProceduralMemory(): ProceduralMemory {
    return this.proceduralMemory;
  }

  // --- Private helper methods ---

  /**
   * Validate that the given type is a valid MemoryType.
   */
  private validateMemoryType(type: MemoryType): void {
    const validTypes = Object.values(MemoryType);
    if (!validTypes.includes(type)) {
      throw new Error(`Unsupported memory type: ${type}`);
    }
  }

  /**
   * Store content in short-term memory.
   */
  private async storeShortTerm(content: string, metadata?: Record<string, any>): Promise<Memory> {
    const memory = createMemory({
      content,
      type: MemoryType.SHORT_TERM,
      sourceAgent: metadata?.sourceAgent ?? 'unknown',
      tags: metadata?.tags ?? [],
      metadata,
      interactionType: metadata?.interactionType,
    });

    await this.shortTermMemory.store(memory);
    return memory;
  }

  /**
   * Store content in long-term memory with a simple hash-based embedding.
   */
  private async storeLongTerm(content: string, metadata?: Record<string, any>): Promise<Memory> {
    const memory = createMemory({
      content,
      type: MemoryType.LONG_TERM,
      sourceAgent: metadata?.sourceAgent ?? 'unknown',
      tags: metadata?.tags ?? [],
      metadata,
      interactionType: metadata?.interactionType,
    });

    const embedding = this.generateSimpleEmbedding(content);
    await this.longTermMemory.store(memory, embedding);
    return memory;
  }

  /**
   * Store content in episodic memory by creating an EpisodicEvent from metadata.
   */
  private async storeEpisodic(content: string, metadata?: Record<string, any>): Promise<Memory> {
    const event: EpisodicEvent = {
      description: content,
      occurredAt: metadata?.occurredAt ? new Date(metadata.occurredAt) : new Date(),
      endedAt: metadata?.endedAt ? new Date(metadata.endedAt) : undefined,
      participants: metadata?.participants ?? [],
      emotion: metadata?.emotion,
    };

    const sourceAgent = metadata?.sourceAgent ?? 'unknown';
    return this.episodicMemory.store(event, sourceAgent);
  }

  /**
   * Store content in semantic memory by creating a Triple or Concept from metadata.
   */
  private async storeSemantic(content: string, metadata?: Record<string, any>): Promise<Memory> {
    const sourceAgent = metadata?.sourceAgent ?? 'unknown';

    // If metadata contains triple fields, store as triple
    if (metadata?.subject && metadata?.predicate && metadata?.object) {
      const triple: Triple = {
        subject: metadata.subject,
        predicate: metadata.predicate,
        object: metadata.object,
      };
      return this.semanticMemory.storeTriple(triple, sourceAgent);
    }

    // If metadata contains concept fields, store as concept
    if (metadata?.name && metadata?.definition) {
      const concept: Concept = {
        name: metadata.name,
        definition: metadata.definition,
        attributes: metadata.attributes ?? [],
        relations: metadata.relations ?? [],
      };
      return this.semanticMemory.storeConcept(concept, sourceAgent);
    }

    // Default: store as a triple with content as subject
    const triple: Triple = {
      subject: content,
      predicate: 'is',
      object: 'knowledge',
    };
    return this.semanticMemory.storeTriple(triple, sourceAgent);
  }

  /**
   * Store content in procedural memory by creating a Skill from metadata.
   */
  private async storeProcedural(content: string, metadata?: Record<string, any>): Promise<Memory> {
    const skill: Omit<Skill, 'proficiency' | 'usageCount' | 'mastered'> = {
      name: metadata?.name ?? content,
      steps: metadata?.steps ?? [content],
      lastUsedAt: metadata?.lastUsedAt ? new Date(metadata.lastUsedAt) : new Date(),
    };

    return this.proceduralMemory.store(skill);
  }

  /**
   * Retrieve memories from a specific sub-module.
   */
  private async retrieveFromModule(query: string, type: MemoryType, limit: number): Promise<Memory[]> {
    switch (type) {
      case MemoryType.SHORT_TERM:
        return this.shortTermMemory.retrieve(query, limit);

      case MemoryType.LONG_TERM: {
        const queryEmbedding = this.generateSimpleEmbedding(query);
        return this.longTermMemory.retrieve(queryEmbedding, limit);
      }

      case MemoryType.EPISODIC: {
        const all = await this.episodicMemory.getAll();
        return all
          .filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
          .slice(0, limit);
      }

      case MemoryType.SEMANTIC: {
        const all = await this.semanticMemory.getAll();
        return all
          .filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
          .slice(0, limit);
      }

      case MemoryType.PROCEDURAL: {
        const all = await this.proceduralMemory.getAll();
        return all
          .filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
          .slice(0, limit);
      }

      default:
        return [];
    }
  }

  /**
   * Get all memories from all sub-modules.
   */
  private async getAllMemories(): Promise<Memory[]> {
    const results: Memory[] = [];

    const shortTermAll = await this.shortTermMemory.getAll();
    results.push(...shortTermAll);

    try {
      const longTermAll = await this.longTermMemory.getAll();
      results.push(...longTermAll);
    } catch {
      // Long-term memory may not be initialized
    }

    const episodicAll = await this.episodicMemory.getAll();
    results.push(...episodicAll);

    const semanticAll = await this.semanticMemory.getAll();
    results.push(...semanticAll);

    const proceduralAll = await this.proceduralMemory.getAll();
    results.push(...proceduralAll);

    return results;
  }

  /**
   * Generate a simple hash-based embedding for content.
   * This is a deterministic pseudo-embedding since we don't have an actual
   * embedding model. It produces consistent vectors for the same content.
   *
   * @param content - The text content to embed
   * @returns A fixed-dimension number array representing the embedding
   */
  private generateSimpleEmbedding(content: string): number[] {
    const embedding = new Array(EMBEDDING_DIMENSION).fill(0);

    for (let i = 0; i < content.length; i++) {
      const charCode = content.charCodeAt(i);
      const index = i % EMBEDDING_DIMENSION;
      embedding[index] += charCode;
    }

    // Normalize the embedding to unit length
    const magnitude = Math.sqrt(
      embedding.reduce((sum: number, val: number) => sum + val * val, 0)
    );

    if (magnitude === 0) {
      return embedding;
    }

    return embedding.map((val: number) => val / magnitude);
  }

  /**
   * Calculate word overlap (Jaccard similarity) between two text strings.
   * Used for content-based association discovery.
   *
   * @param textA - First text
   * @param textB - Second text
   * @returns Jaccard similarity coefficient (0-1)
   */
  private calculateWordOverlap(textA: string, textB: string): number {
    const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    if (wordsA.size === 0 || wordsB.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) {
        intersection++;
      }
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
