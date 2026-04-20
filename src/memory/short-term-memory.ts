/**
 * Short-Term Memory implementation.
 * Provides a fixed-size queue with configurable capacity and TTL-based expiration.
 * Eviction policy: lowest importance score, then earliest last access time.
 */

import { Memory } from './types.js';

/**
 * Configuration for Short-Term Memory.
 */
export interface ShortTermMemoryConfig {
  /** Maximum number of memories the queue can hold. */
  capacity: number;
  /** Time-to-live in milliseconds for each memory entry. */
  ttl: number;
}

/**
 * Internal memory entry that tracks expiration time.
 */
interface MemoryEntry {
  memory: Memory;
  expiresAt: number;
}

/**
 * ShortTermMemory manages a fixed-size queue of memories with TTL expiration
 * and importance-based eviction.
 */
export class ShortTermMemory {
  private queue: MemoryEntry[] = [];
  private config: ShortTermMemoryConfig;

  constructor(config: ShortTermMemoryConfig) {
    this.config = config;
  }

  /**
   * Store a memory in the short-term queue.
   * Cleans expired entries first, then evicts if at capacity, then adds the new memory.
   */
  async store(memory: Memory): Promise<void> {
    this.cleanExpired();

    if (this.queue.length >= this.config.capacity) {
      this.evict();
    }

    const entry: MemoryEntry = {
      memory,
      expiresAt: Date.now() + this.config.ttl,
    };

    this.queue.push(entry);
  }

  /**
   * Retrieve memories matching the query string.
   * Cleans expired entries first, performs substring matching on content,
   * and updates lastAccessedAt for matched memories.
   *
   * @param query - Search string to match against memory content
   * @param limit - Maximum number of results to return (default: 10)
   * @returns Array of matching memories sorted by importance score descending
   */
  async retrieve(query: string, limit: number = 10): Promise<Memory[]> {
    this.cleanExpired();

    const lowerQuery = query.toLowerCase();
    const matched: MemoryEntry[] = [];

    for (const entry of this.queue) {
      if (entry.memory.content.toLowerCase().includes(lowerQuery)) {
        // Update lastAccessedAt on access
        entry.memory.lastAccessedAt = new Date();
        matched.push(entry);
      }
    }

    // Sort by importance score descending
    matched.sort((a, b) => b.memory.importanceScore - a.memory.importanceScore);

    return matched.slice(0, limit).map(entry => entry.memory);
  }

  /**
   * Get all non-expired memories in the queue.
   */
  async getAll(): Promise<Memory[]> {
    this.cleanExpired();
    return this.queue.map(entry => entry.memory);
  }

  /**
   * Remove a specific memory by ID.
   * @returns true if the memory was found and removed, false otherwise.
   */
  async remove(memoryId: string): Promise<boolean> {
    const index = this.queue.findIndex(entry => entry.memory.id === memoryId);
    if (index === -1) {
      return false;
    }
    this.queue.splice(index, 1);
    return true;
  }

  /**
   * Eviction policy: remove the memory with the lowest importance score.
   * If tied, remove the one with the earliest lastAccessedAt.
   */
  private evict(): void {
    if (this.queue.length === 0) {
      return;
    }

    let evictIndex = 0;
    let lowestScore = this.queue[0].memory.importanceScore;
    let earliestAccess = this.queue[0].memory.lastAccessedAt.getTime();

    for (let i = 1; i < this.queue.length; i++) {
      const entry = this.queue[i];
      const score = entry.memory.importanceScore;
      const accessTime = entry.memory.lastAccessedAt.getTime();

      if (
        score < lowestScore ||
        (score === lowestScore && accessTime < earliestAccess)
      ) {
        evictIndex = i;
        lowestScore = score;
        earliestAccess = accessTime;
      }
    }

    this.queue.splice(evictIndex, 1);
  }

  /**
   * Remove all memories whose TTL has expired.
   */
  private cleanExpired(): void {
    const now = Date.now();
    this.queue = this.queue.filter(entry => entry.expiresAt > now);
  }
}
