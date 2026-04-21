/**
 * 长期记忆模块，使用 LanceDB 进行持久化向量存储。
 * 提供基于语义相似度的记忆检索搜索，
 * 以及在系统重启后仍然存在的持久化存储。
 */

import * as lancedb from '@lancedb/lancedb';
import { Memory, MemoryType } from './types.js';

/**
 * 长期记忆的配置。
 */
export interface LongTermMemoryConfig {
  /** 查询返回的最大结果数 */
  maxResults: number;
  /** 过滤结果的最小相似度阈值 (0-1) */
  similarityThreshold: number;
  /** LanceDB 存储的文件系统路径 */
  dbPath: string;
}

/** 默认配置值 */
const DEFAULT_CONFIG: LongTermMemoryConfig = {
  maxResults: 10,
  similarityThreshold: 0.5,
  dbPath: './data/memory',
};

/** 在 LanceDB 中存储记忆使用的表名 */
const TABLE_NAME = 'memories';

/**
 * 存储在 LanceDB 中的记录结构。
 */
interface MemoryRecord {
  id: string;
  content: string;
  type: string;
  vector: number[];
  importanceScore: number;
  sourceAgent: string;
  tags: string;
  createdAt: string;
  lastAccessedAt: string;
  metadata: string;
  [key: string]: unknown;
}

/**
 * LongTermMemory 提供由 LanceDB 支持的持久化记忆存储。
 * 支持向量相似度搜索以实现语义化记忆检索。
 */
export class LongTermMemory {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private config: LongTermMemoryConfig;
  private initialized: boolean = false;

  constructor(config?: Partial<LongTermMemoryConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化 LanceDB 连接。
   * 使用延迟初始化 - 在首次操作时自动调用。
   */
  private async ensureConnection(): Promise<lancedb.Connection> {
    if (this.db) {
      return this.db;
    }

    try {
      this.db = await lancedb.connect(this.config.dbPath);
      return this.db;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to connect to LanceDB at "${this.config.dbPath}": ${message}`
      );
    }
  }

  /**
   * 确保记忆表存在，首次使用时创建。
   * 使用延迟初始化模式。
   */
  private async ensureTable(embedding?: number[]): Promise<lancedb.Table> {
    if (this.table) {
      return this.table;
    }

    const db = await this.ensureConnection();

    try {
      const tableNames = await db.tableNames();
      if (tableNames.includes(TABLE_NAME)) {
        this.table = await db.openTable(TABLE_NAME);
      }
    } catch (error) {
    // 表尚不存在，将在首次存储时创建
      this.table = null;
    }

    if (!this.table && embedding) {
      // 首次存储时使用初始数据创建表
      // LanceDB 从第一条记录推断 schema
      this.table = await db.createTable(TABLE_NAME, [
        this.createPlaceholderRecord(embedding.length),
      ]);
      // 移除占位记录
      await this.table.delete('id = "__placeholder__"');
    }

    if (this.table) {
      this.initialized = true;
    }

    return this.table!;
  }

  /**
   * 创建占位记录以初始化表结构。
   */
  private createPlaceholderRecord(vectorDimension: number): MemoryRecord {
    return {
      id: '__placeholder__',
      content: '',
      type: MemoryType.LONG_TERM,
      vector: new Array(vectorDimension).fill(0),
      importanceScore: 0,
      sourceAgent: '',
      tags: '[]',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      metadata: '{}',
    };
  }

  /**
   * 将 Memory 对象和嵌入向量转换为 LanceDB 记录。
   */
  private memoryToRecord(memory: Memory, embedding: number[]): MemoryRecord {
    return {
      id: memory.id,
      content: memory.content,
      type: memory.type,
      vector: embedding,
      importanceScore: memory.importanceScore,
      sourceAgent: memory.sourceAgent,
      tags: JSON.stringify(memory.tags),
      createdAt: memory.createdAt.toISOString(),
      lastAccessedAt: memory.lastAccessedAt.toISOString(),
      metadata: JSON.stringify(memory.metadata ?? {}),
    };
  }

  /**
   * 将 LanceDB 记录转换回 Memory 对象。
   */
  private recordToMemory(record: Record<string, any>): Memory {
    return {
      id: record.id,
      content: record.content,
      type: record.type as MemoryType,
      createdAt: new Date(record.createdAt),
      lastAccessedAt: new Date(record.lastAccessedAt),
      importanceScore: record.importanceScore,
      sourceAgent: record.sourceAgent,
      tags: JSON.parse(record.tags),
      metadata: JSON.parse(record.metadata),
    };
  }

  /**
   * 将记忆及其向量嵌入存储到 LanceDB。
   *
   * @param memory - 要存储的 Memory 对象
   * @param embedding - 记忆内容的向量嵌入
   */
  async store(memory: Memory, embedding: number[]): Promise<void> {
    try {
      const table = await this.ensureTable(embedding);
      const record = this.memoryToRecord(memory, embedding);
      await table.add([record]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to store memory "${memory.id}": ${message}`);
    }
  }

  /**
   * 通过向量相似度搜索检索记忆。
   *
   * @param queryEmbedding - 用于搜索的查询向量
   * @param limit - 最大结果数（默认为 config.maxResults）
   * @param threshold - 最小相似度阈值（默认为 config.similarityThreshold）
   * @returns 按相似度排序的 Memory 对象数组（最相似的在前）
   */
  async retrieve(
    queryEmbedding: number[],
    limit?: number,
    threshold?: number
  ): Promise<Memory[]> {
    const maxResults = limit ?? this.config.maxResults;
    const similarityThreshold = threshold ?? this.config.similarityThreshold;

    try {
      const table = await this.ensureTable(queryEmbedding);
      if (!table) {
        return [];
      }

      // LanceDB 默认使用 L2 距离（越低越相似）
      // 将相似度阈值转换为距离阈值
      // 对于余弦距离：distance = 1 - similarity，所以阈值距离 = 1 - similarityThreshold
      const distanceThreshold = 1 - similarityThreshold;

      const results = await table
        .vectorSearch(queryEmbedding)
        .distanceType('cosine')
        .limit(maxResults)
        .toArray();

      // 按距离阈值过滤（距离越低 = 相似度越高）
      const filtered = results.filter(
        (row: any) => row._distance <= distanceThreshold
      );

      return filtered.map((row: any) => this.recordToMemory(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to retrieve memories: ${message}`);
    }
  }

  /**
   * 按 ID 删除记忆。
   *
   * @param memoryId - 要删除的记忆的唯一标识符
   * @returns 如果删除成功返回 true
   */
  async delete(memoryId: string): Promise<boolean> {
    try {
      const table = await this.ensureTable();
      if (!table) {
        return false;
      }

      await table.delete(`id = "${memoryId}"`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete memory "${memoryId}": ${message}`);
    }
  }

  /**
   * 系统重启后从 LanceDB 恢复所有存储的记忆。
   * 返回恢复的记忆数量。
   *
   * @returns 从持久化存储恢复的记忆数量
   */
  async restore(): Promise<number> {
    try {
      const db = await this.ensureConnection();

      const tableNames = await db.tableNames();
      if (!tableNames.includes(TABLE_NAME)) {
        return 0;
      }

      this.table = await db.openTable(TABLE_NAME);
      this.initialized = true;

      const count = await this.table.countRows();
      return count;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to restore memories from LanceDB: ${message}`
      );
    }
  }

  /**
   * 获取所有存储的记忆（用于合并和衰减操作）。
   *
   * @returns 所有存储的 Memory 对象数组
   */
  async getAll(): Promise<Memory[]> {
    try {
      const table = await this.ensureTable();
      if (!table) {
        return [];
      }

      const results = await table.query().toArray();
      return results.map((row: any) => this.recordToMemory(row));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get all memories: ${message}`);
    }
  }

  /**
   * 检查长期记忆是否已初始化表。
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}
