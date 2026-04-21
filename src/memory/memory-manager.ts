/**
 * MemoryManager 协调所有五个记忆子模块，提供统一的
 * 存储、检索、更新和删除记忆的接口。
 * 根据记忆类型将操作路由到正确的子模块。
 * 实现记忆合并、衰减、重要性提升和关联发现。
 */

import { Memory, MemoryType, EpisodicEvent, Triple, Concept, Skill } from './types.js';
import { createMemory, calculateImportanceScore } from './memory.js';
import { ShortTermMemory, ShortTermMemoryConfig } from './short-term-memory.js';
import { LongTermMemory, LongTermMemoryConfig } from './long-term-memory.js';
import { EpisodicMemory } from './episodic-memory.js';
import { SemanticMemory } from './semantic-memory.js';
import { ProceduralMemory } from './procedural-memory.js';

/**
 * MemoryManager 的配置。
 */
export interface MemoryManagerConfig {
  shortTerm?: Partial<ShortTermMemoryConfig>;
  longTerm?: Partial<LongTermMemoryConfig>;
  /** 合并的重要性评分阈值（短期 → 长期） */
  consolidationThreshold?: number;
  /** 衰减间隔（毫秒） */
  decayInterval?: number;
}

/**
 * 两个记忆之间的关联链接。
 */
export interface MemoryAssociation {
  sourceId: string;
  targetId: string;
  strength: number; // 0-1 表示关联强度
  type: 'content_similarity' | 'temporal_proximity' | 'both';
}

/** 默认 MemoryManager 配置 */
const DEFAULT_CONFIG: Required<MemoryManagerConfig> = {
  shortTerm: { capacity: 100, ttl: 300000 },
  longTerm: { maxResults: 10, similarityThreshold: 0.5, dbPath: './data/memory' },
  consolidationThreshold: 0.6,
  decayInterval: 60000,
};

/**
 * 与 LongTermMemory 一起使用的简单哈希嵌入维度。
 */
const EMBEDDING_DIMENSION = 128;

/**
 * MemoryManager 为所有记忆操作提供统一接口，
 * 根据记忆类型路由到适当的子模块。
 * 实现合并、衰减、重要性提升和关联发现。
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
   * 存储记忆，根据类型路由到正确的子模块。
   *
   * @param content - 要存储的内容
   * @param type - 决定使用哪个子模块的记忆类型
   * @param metadata - 可选的记忆元数据
   * @returns 创建的 Memory 对象
   * @throws 如果记忆类型不支持则抛出错误
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
   * 检索匹配查询的记忆，可选按类型过滤。
   *
   * @param query - 搜索查询字符串
   * @param type - 可选的记忆类型过滤（不指定则查询所有）
   * @param limit - 返回的最大结果数
   * @returns 匹配的 Memory 对象数组
   */
  async retrieve(query: string, type?: MemoryType, limit: number = 10): Promise<Memory[]> {
    if (type) {
      this.validateMemoryType(type);
      return this.retrieveFromModule(query, type, limit);
    }

    // 查询所有子模块并合并结果
    const results: Memory[] = [];

    const shortTermResults = await this.shortTermMemory.retrieve(query, limit);
    results.push(...shortTermResults);

    // 对于长期记忆，使用查询的简单嵌入
    try {
      const queryEmbedding = this.generateSimpleEmbedding(query);
      const longTermResults = await this.longTermMemory.retrieve(queryEmbedding, limit);
      results.push(...longTermResults);
    } catch {
      // 长期记忆可能尚未初始化
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

    // 按重要性评分降序排列并限制数量
    results.sort((a, b) => b.importanceScore - a.importanceScore);
    return results.slice(0, limit);
  }

  /**
   * 按 ID 删除记忆。尝试所有子模块，因为可能不知道记忆在哪个模块中。
   *
   * @param memoryId - 要删除的记忆的唯一标识符
   * @returns 如果找到并删除了记忆返回 true，否则返回 false
   */
  async delete(memoryId: string): Promise<boolean> {
    // 尝试短期记忆
    const shortTermDeleted = await this.shortTermMemory.remove(memoryId);
    if (shortTermDeleted) return true;

    // 尝试情景记忆
    const episodicDeleted = await this.episodicMemory.remove(memoryId);
    if (episodicDeleted) return true;

    // 尝试语义记忆
    const semanticDeleted = await this.semanticMemory.remove(memoryId);
    if (semanticDeleted) return true;

    // 尝试程序性记忆
    const proceduralDeleted = await this.proceduralMemory.remove(memoryId);
    if (proceduralDeleted) return true;

    // 最后尝试长期记忆（LanceDB 删除不指示行是否存在）
    // 先检查记忆是否存在于长期存储中
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
   * 按 ID 更新记忆。在所有子模块中查找记忆并应用部分更新。
   *
   * @param memoryId - 要更新的记忆的唯一标识符
   * @param updates - 要更新的部分 Memory 字段
   * @returns 更新后的 Memory 对象
   * @throws 如果记忆未找到则抛出错误
   */
  async update(memoryId: string, updates: Partial<Memory>): Promise<Memory> {
    // 在所有子模块中搜索记忆
    const allMemories = await this.getAllMemories();
    const memory = allMemories.find(m => m.id === memoryId);

    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }

    // 应用更新
    if (updates.content !== undefined) memory.content = updates.content;
    if (updates.importanceScore !== undefined) memory.importanceScore = updates.importanceScore;
    if (updates.tags !== undefined) memory.tags = updates.tags;
    if (updates.metadata !== undefined) memory.metadata = updates.metadata;
    if (updates.lastAccessedAt !== undefined) memory.lastAccessedAt = updates.lastAccessedAt;

    return memory;
  }

  /**
   * 将短期记忆合并到长期记忆。
   * 将重要性评分超过可配置阈值的记忆通过压缩传输到长期记忆，
   * 然后从短期记忆中移除。
   *
   * @returns 合并的记忆数量
   */
  async consolidate(): Promise<number> {
    const shortTermMemories = await this.shortTermMemory.getAll();
    let consolidatedCount = 0;

    for (const memory of shortTermMemories) {
      if (memory.importanceScore >= this.config.consolidationThreshold) {
        // 生成嵌入并存储到长期记忆
        const embedding = this.generateSimpleEmbedding(memory.content);
        try {
          await this.longTermMemory.store(memory, embedding);
          // 成功传输后从短期记忆中移除
          await this.shortTermMemory.remove(memory.id);
          consolidatedCount++;
        } catch {
          // 如果长期存储失败，保留在短期记忆中
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

      // 只有经过一段时间才进行衰减
      if (timeSinceLastAccess <= 0) {
        continue;
      }

      // 根据当前重要性评分确定衰减率
      let decayRate: number;
      if (memory.importanceScore > 0.7) {
        decayRate = 0.95; // slow decay
      } else if (memory.importanceScore >= 0.3) {
        decayRate = 0.90; // medium decay
      } else {
        decayRate = 0.80; // fast decay
      }

      // 应用指数衰减
      const decayExponent = timeSinceLastAccess / this.config.decayInterval;
      const newScore = memory.importanceScore * Math.pow(decayRate, decayExponent);

      // 检查记忆是否应被移除（评分实际为 0）
      if (newScore < 0.001) {
        memoriesToRemove.push({ id: memory.id, type: memory.type });
        affectedCount++;
      } else if (newScore !== memory.importanceScore) {
        // 更新重要性评分
        memory.importanceScore = newScore;
        affectedCount++;
      }
    }

    // 移除已衰减到 0 的记忆
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

    // 跟踪访问次数
    const currentCount = (this.accessCounts.get(memoryId) ?? 0) + 1;
    this.accessCounts.set(memoryId, currentCount);

    // 计算提升值：min(0.1 * (accessCount / 10), 0.2)
    const boost = Math.min(0.1 * (currentCount / 10), 0.2);

    // 应用提升，截断到 [0, 1]
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

    // 内容相似度阈值（Jaccard 指数）
    const CONTENT_SIMILARITY_THRESHOLD = 0.3;
    // 时间邻近度阈值（5 分钟内）
    const TEMPORAL_PROXIMITY_MS = 5 * 60 * 1000;

    for (let i = 0; i < allMemories.length; i++) {
      for (let j = i + 1; j < allMemories.length; j++) {
        const memA = allMemories[i];
        const memB = allMemories[j];

        // 检查关联是否已存在
        const existingAssoc = this.associations.find(
          a => (a.sourceId === memA.id && a.targetId === memB.id) ||
               (a.sourceId === memB.id && a.targetId === memA.id)
        );
        if (existingAssoc) {
          continue;
        }

        // 计算内容相似度（词重叠 / Jaccard）
        const contentSimilarity = this.calculateWordOverlap(memA.content, memB.content);

        // 计算时间邻近度
        const timeDiff = Math.abs(memA.createdAt.getTime() - memB.createdAt.getTime());
        const isTemporallyClose = timeDiff <= TEMPORAL_PROXIMITY_MS;

        // 确定关联类型和强度
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
