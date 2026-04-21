/**
 * 短期记忆实现。
 * 提供具有可配置容量和基于 TTL 过期机制的固定大小队列。
 * 淘汰策略：最低重要性评分优先，相同时选择最早访问时间的。
 */

import { Memory } from './types.js';

/**
 * 短期记忆的配置。
 */
export interface ShortTermMemoryConfig {
  /** 队列可容纳的最大记忆数量。 */
  capacity: number;
  /** 每条记忆条目的存活时间（毫秒）。 */
  ttl: number;
}

/**
 * 跟踪过期时间的内部记忆条目。
 */
interface MemoryEntry {
  memory: Memory;
  expiresAt: number;
}

/**
 * ShortTermMemory 管理具有 TTL 过期和基于重要性淘汰的固定大小记忆队列。
 */
export class ShortTermMemory {
  private queue: MemoryEntry[] = [];
  private config: ShortTermMemoryConfig;

  constructor(config: ShortTermMemoryConfig) {
    this.config = config;
  }

  /**
   * 将记忆存储到短期队列中。
   * 先清理过期条目，如果达到容量则淘汰，然后添加新记忆。
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
   * 检索匹配查询字符串的记忆。
   * 先清理过期条目，对内容执行子字符串匹配，
   * 并更新匹配记忆的 lastAccessedAt。
   *
   * @param query - 用于匹配记忆内容的搜索字符串
   * @param limit - 返回的最大结果数（默认：10）
   * @returns 按重要性评分降序排列的匹配记忆数组
   */
  async retrieve(query: string, limit: number = 10): Promise<Memory[]> {
    this.cleanExpired();

    const lowerQuery = query.toLowerCase();
    const matched: MemoryEntry[] = [];

    for (const entry of this.queue) {
      if (entry.memory.content.toLowerCase().includes(lowerQuery)) {
    // 更新访问时的 lastAccessedAt
        entry.memory.lastAccessedAt = new Date();
        matched.push(entry);
      }
    }

    // 按重要性评分降序排列
    matched.sort((a, b) => b.memory.importanceScore - a.memory.importanceScore);

    return matched.slice(0, limit).map(entry => entry.memory);
  }

  /**
   * 获取队列中所有未过期的记忆。
   */
  async getAll(): Promise<Memory[]> {
    this.cleanExpired();
    return this.queue.map(entry => entry.memory);
  }

  /**
   * 按 ID 移除特定记忆。
   * @returns 如果找到并移除了记忆返回 true，否则返回 false。
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
   * 淘汰策略：移除重要性评分最低的记忆。
   * 如果评分相同，移除 lastAccessedAt 最早的。
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
   * 移除所有 TTL 已过期的记忆。
   */
  private cleanExpired(): void {
    const now = Date.now();
    this.queue = this.queue.filter(entry => entry.expiresAt > now);
  }
}
