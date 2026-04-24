/**
 * 异步记忆预取系统。
 * 
 * 异步预取机制：
 * 1. 在对话开始时异步预取相关记忆
 * 2. 使用相关性检索算法
 * 3. 不阻塞主流程
 * 4. 支持取消和清理
 */

import { EventEmitter } from 'events';
import type { MemoryHeader } from './types.js';
import type { MultiLevelMemoryLoader } from './multi-level-memory.js';

/**
 * 预取配置
 */
export interface PrefetchConfig {
  /** 预取超时时间（毫秒） */
  timeout: number;
  /** 最大预取数量 */
  maxPrefetch: number;
  /** 启用相关性检索 */
  enableRelevance: boolean;
  /** 相关性阈值（0-1） */
  relevanceThreshold: number;
}

/**
 * 默认配置
 */
const DEFAULT_PREFETCH_CONFIG: PrefetchConfig = {
  timeout: 5000,
  maxPrefetch: 20,
  enableRelevance: true,
  relevanceThreshold: 0.3,
};

/**
 * 预取结果
 */
export interface PrefetchResult {
  /** 预取是否成功 */
  success: boolean;
  /** 预取的记忆数量 */
  count: number;
  /** 错误信息（如果有） */
  error?: string;
  /** 预取耗时（毫秒） */
  duration: number;
}

/**
 * 相关性分析器
 */
export class RelevanceAnalyzer {
  /**
   * 计算查询与记忆的相关性分数（0-1）
   */
  calculateRelevance(query: string, memory: MemoryHeader): number {
    const queryLower = query.toLowerCase();
    let score = 0;

    // 1. 检查描述匹配
    if (memory.description) {
      const descLower = memory.description.toLowerCase();
      if (descLower.includes(queryLower)) {
        score += 0.4;
      } else {
        // 计算词重叠
        const queryWords = new Set(queryLower.split(/\s+/).filter(w => w.length > 2));
        const descWords = new Set(descLower.split(/\s+/).filter(w => w.length > 2));
        
        let overlap = 0;
        for (const word of queryWords) {
          if (descWords.has(word)) overlap++;
        }
        
        if (queryWords.size > 0) {
          score += (overlap / queryWords.size) * 0.3;
        }
      }
    }

    // 2. 检查文件名匹配
    const filenameLower = memory.filename.toLowerCase();
    if (filenameLower.includes(queryLower)) {
      score += 0.3;
    }

    // 3. 新鲜度加分（越新越相关）
    const ageDays = Math.floor((Date.now() - memory.mtimeMs) / 86400000);
    const freshnessScore = Math.max(0, 1 - (ageDays / 30)); // 30天内线性衰减
    score += freshnessScore * 0.3;

    return Math.min(1, score);
  }

  /**
   * 批量计算相关性并排序
   */
  rankMemoriesByRelevance(
    query: string,
    memories: MemoryHeader[],
    threshold: number = 0.3
  ): MemoryHeader[] {
    const scored = memories.map(memory => ({
      memory,
      score: this.calculateRelevance(query, memory),
    }));

    // 过滤并排序
    return scored
      .filter(item => item.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .map(item => item.memory);
  }
}

/**
 * 异步记忆预取器
 */
export class AsyncMemoryPrefetcher extends EventEmitter {
  private memoryLoader: MultiLevelMemoryLoader;
  private config: PrefetchConfig;
  private relevanceAnalyzer: RelevanceAnalyzer;
  private prefetchCache: Map<string, MemoryHeader[]> = new Map();
  private activePrefetches: Set<string> = new Set();

  constructor(
    memoryLoader: MultiLevelMemoryLoader,
    config?: Partial<PrefetchConfig>
  ) {
    super();
    this.memoryLoader = memoryLoader;
    this.config = { ...DEFAULT_PREFETCH_CONFIG, ...config };
    this.relevanceAnalyzer = new RelevanceAnalyzer();
  }

  /**
   * 异步预取相关记忆
   */
  async prefetch(query: string): Promise<PrefetchResult> {
    const startTime = Date.now();
    const cacheKey = query.toLowerCase();

    // 检查是否已有缓存
    if (this.prefetchCache.has(cacheKey)) {
      const cached = this.prefetchCache.get(cacheKey)!;
      return {
        success: true,
        count: cached.length,
        duration: Date.now() - startTime,
      };
    }

    // 检查是否已在预取中
    if (this.activePrefetches.has(cacheKey)) {
      return {
        success: false,
        count: 0,
        error: 'Prefetch already in progress',
        duration: Date.now() - startTime,
      };
    }

    this.activePrefetches.add(cacheKey);

    try {
      // 设置超时
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Prefetch timeout')), this.config.timeout);
      });

      // 执行预取
      const prefetchPromise = this.executePrefetch(query);
      
      const result = await Promise.race([prefetchPromise, timeoutPromise]);
      
      // 缓存结果
      this.prefetchCache.set(cacheKey, result.memories);
      
      // 触发预取完成事件
      this.emit('prefetchComplete', {
        query,
        count: result.memories.length,
        duration: result.duration,
      });

      return {
        success: true,
        count: result.memories.length,
        duration: result.duration,
      };
    } catch (error) {
      console.error('[AsyncPrefetcher] Prefetch failed:', error);
      
      return {
        success: false,
        count: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration: Date.now() - startTime,
      };
    } finally {
      this.activePrefetches.delete(cacheKey);
    }
  }

  /**
   * 执行预取逻辑
   */
  private async executePrefetch(query: string): Promise<{ memories: MemoryHeader[]; duration: number }> {
    const startTime = Date.now();

    // 1. 加载所有级别的记忆
    const allLevels = await this.memoryLoader.loadAllLevels();
    const allMemories: MemoryHeader[] = [];
    
    Object.values(allLevels).forEach(memories => {
      allMemories.push(...memories);
    });

    // 2. 应用相关性分析（如果启用）
    let relevantMemories: MemoryHeader[];
    
    if (this.config.enableRelevance && allMemories.length > 0) {
      relevantMemories = this.relevanceAnalyzer.rankMemoriesByRelevance(
        query,
        allMemories,
        this.config.relevanceThreshold
      );
    } else {
      // 简单过滤：检查描述或文件名是否包含查询词
      const queryLower = query.toLowerCase();
      relevantMemories = allMemories.filter(memory => {
        return (
          (memory.description?.toLowerCase().includes(queryLower)) ||
          memory.filename.toLowerCase().includes(queryLower)
        );
      });
    }

    // 3. 限制数量
    const limitedMemories = relevantMemories.slice(0, this.config.maxPrefetch);

    return {
      memories: limitedMemories,
      duration: Date.now() - startTime,
    };
  }

  /**
   * 获取预取的记忆
   */
  getPrefetchedMemories(query: string): MemoryHeader[] {
    const cacheKey = query.toLowerCase();
    return this.prefetchCache.get(cacheKey) || [];
  }

  /**
   * 清除查询的预取缓存
   */
  clearPrefetchCache(query?: string): void {
    if (query) {
      const cacheKey = query.toLowerCase();
      this.prefetchCache.delete(cacheKey);
    } else {
      this.prefetchCache.clear();
    }
  }

  /**
   * 检查是否正在预取
   */
  isPrefetching(query: string): boolean {
    const cacheKey = query.toLowerCase();
    return this.activePrefetches.has(cacheKey);
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; queries: string[] } {
    return {
      size: this.prefetchCache.size,
      queries: Array.from(this.prefetchCache.keys()),
    };
  }

  /**
   * 设置配置
   */
  updateConfig(config: Partial<PrefetchConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.prefetchCache.clear();
    this.activePrefetches.clear();
    this.removeAllListeners();
  }
}

/**
 * 创建异步预取器实例
 */
export function createAsyncPrefetcher(
  memoryLoader: MultiLevelMemoryLoader,
  config?: Partial<PrefetchConfig>
): AsyncMemoryPrefetcher {
  return new AsyncMemoryPrefetcher(memoryLoader, config);
}