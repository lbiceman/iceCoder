/**
 * Long-Term Memory module using LanceDB for persistent vector storage.
 * Provides semantic similarity search for memory retrieval and
 * durable storage that survives system restarts.
 */

import * as lancedb from '@lancedb/lancedb';
import { Memory, MemoryType } from './types.js';

/**
 * Configuration for Long-Term Memory.
 */
export interface LongTermMemoryConfig {
  /** Maximum number of results to return from a query */
  maxResults: number;
  /** Minimum similarity threshold (0-1) for filtering results */
  similarityThreshold: number;
  /** File system path for LanceDB storage */
  dbPath: string;
}

/** Default configuration values */
const DEFAULT_CONFIG: LongTermMemoryConfig = {
  maxResults: 10,
  similarityThreshold: 0.5,
  dbPath: './data/memory',
};

/** Table name used for storing memories in LanceDB */
const TABLE_NAME = 'memories';

/**
 * Record structure stored in LanceDB.
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
 * LongTermMemory provides persistent memory storage backed by LanceDB.
 * Supports vector similarity search for semantic retrieval of memories.
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
   * Initialize the LanceDB connection.
   * Uses lazy initialization - called automatically on first operation.
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
   * Ensure the memories table exists, creating it on first use.
   * Uses lazy initialization pattern.
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
      // Table doesn't exist yet, will be created on first store
      this.table = null;
    }

    if (!this.table && embedding) {
      // Create table with initial data on first store
      // LanceDB infers schema from the first record
      this.table = await db.createTable(TABLE_NAME, [
        this.createPlaceholderRecord(embedding.length),
      ]);
      // Remove the placeholder record
      await this.table.delete('id = "__placeholder__"');
    }

    if (this.table) {
      this.initialized = true;
    }

    return this.table!;
  }

  /**
   * Create a placeholder record to initialize the table schema.
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
   * Convert a Memory object and embedding into a LanceDB record.
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
   * Convert a LanceDB record back into a Memory object.
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
   * Store a memory with its vector embedding in LanceDB.
   *
   * @param memory - The Memory object to store
   * @param embedding - The vector embedding for the memory content
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
   * Retrieve memories by vector similarity search.
   *
   * @param queryEmbedding - The query vector to search against
   * @param limit - Maximum number of results (defaults to config.maxResults)
   * @param threshold - Minimum similarity threshold (defaults to config.similarityThreshold)
   * @returns Array of Memory objects sorted by similarity (most similar first)
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

      // LanceDB uses L2 distance by default (lower = more similar)
      // Convert similarity threshold to distance threshold
      // For cosine distance: distance = 1 - similarity, so threshold distance = 1 - similarityThreshold
      const distanceThreshold = 1 - similarityThreshold;

      const results = await table
        .vectorSearch(queryEmbedding)
        .distanceType('cosine')
        .limit(maxResults)
        .toArray();

      // Filter by distance threshold (lower distance = higher similarity)
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
   * Delete a memory by its ID.
   *
   * @param memoryId - The unique identifier of the memory to delete
   * @returns true if deletion was successful
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
   * Restore all stored memories from LanceDB after system restart.
   * Returns the count of recovered memories.
   *
   * @returns Number of memories restored from persistent storage
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
   * Get all stored memories (useful for consolidation and decay operations).
   *
   * @returns Array of all stored Memory objects
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
   * Check if the long-term memory has been initialized with a table.
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}
