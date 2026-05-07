/**
 * 记忆文件扫描缓存（进程级，TTL 5秒）。
 *
 * 消除重复 I/O：recallRelevantMemories / LLMMemoryExtractor / MemoryDream
 * 等多个模块频繁调用 scanMemoryFiles，每次都遍历目录读取所有文件。
 *
 * 设计：
 * - TTL 缓存：5 秒内复用扫描结果
 * - 主动失效：写入/删除/淘汰记忆文件后，调用 invalidate() 立即失效
 * - 进程级单例：通过 getScannerCache() 获取
 */

import type { MemoryHeader } from './types.js';
import { scanMemoryFiles } from './memory-scanner.js';

/** 缓存条目 */
interface CacheEntry {
  memories: MemoryHeader[];
  timestamp: number;
}

/** 默认 TTL（30 秒） */
const DEFAULT_TTL_MS = 30_000;

/**
 * 记忆扫描缓存。
 */
export class MemoryScannerCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * 扫描记忆文件（带缓存）。
   *
   * 如果缓存未过期，直接返回缓存结果；
   * 否则调用 scanMemoryFiles 重新扫描，并更新缓存。
   */
  async scan(memoryDir: string, maxFiles: number = 200): Promise<MemoryHeader[]> {
    const now = Date.now();
    const cached = this.cache.get(memoryDir);

    if (cached && (now - cached.timestamp) < this.ttlMs) {
      // 缓存命中：截取到 maxFiles 并返回副本（防止外部修改缓存）
      return cached.memories.slice(0, maxFiles);
    }

    // 缓存未命中或已过期：重新扫描
    const memories = await scanMemoryFiles(memoryDir, maxFiles);
    this.cache.set(memoryDir, { memories, timestamp: now });
    return memories;
  }

  /**
   * 使指定目录的缓存失效。
   *
   * 在写入/删除/淘汰记忆文件后调用。
   */
  invalidate(memoryDir: string): void {
    this.cache.delete(memoryDir);
  }

  /**
   * 使所有目录的缓存失效。
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计。
   */
  getStats(): { dirCount: number; entries: Array<{ dir: string; age: number; memoryCount: number }> } {
    const now = Date.now();
    const entries = Array.from(this.cache.entries()).map(([dir, entry]) => ({
      dir,
      age: now - entry.timestamp,
      memoryCount: entry.memories.length,
    }));
    return { dirCount: this.cache.size, entries };
  }

  /**
   * 计算指定目录的记忆 manifest 指纹。
   *
   * 基于 filenames + mtimeMs 排序后拼接的快速 hash，
   * 用于检测 manifest 是否变化（触发去重 Set 清空）。
   * 如果缓存中没有该目录，返回空字符串。
   */
  getManifestHash(memoryDir: string): string {
    const cached = this.cache.get(memoryDir);
    if (!cached) return '';

    const sorted = cached.memories
      .map(m => `${m.filename}:${m.mtimeMs}`)
      .sort()
      .join('|');

    let hash = 0;
    for (let i = 0; i < sorted.length; i++) {
      hash = ((hash << 5) - hash + sorted.charCodeAt(i)) | 0;
    }
    return `${cached.memories.length}:${Math.abs(hash).toString(36)}`;
  }
}

// ─── 全局单例 ───

let globalScannerCache: MemoryScannerCache | null = null;

/**
 * 获取全局 MemoryScannerCache 实例。
 */
export function getScannerCache(): MemoryScannerCache {
  if (!globalScannerCache) {
    globalScannerCache = new MemoryScannerCache();
  }
  return globalScannerCache;
}

/**
 * 重置全局缓存（用于测试）。
 */
export function resetScannerCache(): void {
  globalScannerCache = null;
}
