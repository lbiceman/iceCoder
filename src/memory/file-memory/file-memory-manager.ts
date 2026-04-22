/**
 * 文件记忆管理器 - 集成所有文件记忆功能。
 * 
 * 整合：
 * 1. 多级加载
 * 2. 异步预取
 * 3. 自动提取
 * 4. 记忆扫描和格式化
 * 
 * 提供统一的API供上层系统调用。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryHeader, FileMemoryConfig } from './types.js';
import type { ConversationMessage } from './memory-extractor.js';
import { MultiLevelMemoryLoader, type MultiLevelMemoryConfig, MemoryLevel } from './multi-level-memory.js';
import { AsyncMemoryPrefetcher, type PrefetchConfig } from './async-prefetch.js';
import { MemoryExtractor, type ExtractionConfig, type CandidateMemory } from './memory-extractor.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scanner.js';
import { loadMemoryPrompt } from './memory-prompt.js';

/**
 * 文件记忆管理器配置
 */
export interface FileMemoryManagerConfig {
  /** 基础记忆配置 */
  memory: Partial<FileMemoryConfig>;
  /** 多级加载配置 */
  multiLevel: Partial<MultiLevelMemoryConfig>;
  /** 异步预取配置 */
  prefetch: Partial<PrefetchConfig>;
  /** 自动提取配置 */
  extraction: Partial<ExtractionConfig>;
  /** 是否启用自动提取 */
  enableAutoExtraction: boolean;
  /** 是否启用异步预取 */
  enableAsyncPrefetch: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: FileMemoryManagerConfig = {
  memory: {
    memoryDir: './data/memory-files',
    entrypointName: 'MEMORY.md',
    maxEntrypointLines: 200,
    maxEntrypointBytes: 25000,
    maxMemoryFiles: 200,
  },
  multiLevel: {
    projectRoot: '.',
    userMemoryDir: './data/user-memory',
    currentDir: '.',
  },
  prefetch: {
    timeout: 5000,
    maxPrefetch: 20,
    enableRelevance: true,
    relevanceThreshold: 0.3,
  },
  extraction: {
    enableUserExtraction: true,
    enableFeedbackExtraction: true,
    enableProjectExtraction: true,
    enableReferenceExtraction: true,
    minContentLength: 20,
    confidenceThreshold: 0.7,
  },
  enableAutoExtraction: true,
  enableAsyncPrefetch: true,
};

/**
 * 文件记忆管理器
 */
export class FileMemoryManager {
  private config: FileMemoryManagerConfig;
  private memoryLoader: MultiLevelMemoryLoader;
  private prefetcher: AsyncMemoryPrefetcher | null = null;
  private extractor: MemoryExtractor | null = null;
  private isInitialized = false;

  constructor(config?: Partial<FileMemoryManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 初始化多级加载器
    this.memoryLoader = new MultiLevelMemoryLoader({
      ...this.config.memory,
      ...this.config.multiLevel,
    });

    // 初始化异步预取器（如果启用）
    if (this.config.enableAsyncPrefetch) {
      this.prefetcher = new AsyncMemoryPrefetcher(
        this.memoryLoader,
        this.config.prefetch
      );
    }

    // 初始化记忆提取器（如果启用）
    if (this.config.enableAutoExtraction) {
      this.extractor = new MemoryExtractor(this.config.extraction);
    }
  }

  /**
   * 初始化记忆系统
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // 确保记忆目录存在
      const memoryDir = this.config.memory.memoryDir || DEFAULT_CONFIG.memory.memoryDir!;
      await fs.mkdir(memoryDir, { recursive: true });

      // 初始化多级加载器
      await this.memoryLoader.loadAllLevels();

      this.isInitialized = true;
      console.log('[FileMemoryManager] Initialized successfully');
    } catch (error) {
      console.error('[FileMemoryManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * 加载记忆提示词
   */
  async loadMemoryPrompt(): Promise<string | null> {
    try {
      return await loadMemoryPrompt(this.config.memory);
    } catch (error) {
      console.error('[FileMemoryManager] Failed to load memory prompt:', error);
      return null;
    }
  }

  /**
   * 获取相关记忆
   */
  async getRelevantMemories(query: string, limit: number = 10): Promise<MemoryHeader[]> {
    await this.ensureInitialized();

    // 首先检查预取缓存
    if (this.prefetcher) {
      const prefetched = this.prefetcher.getPrefetchedMemories(query);
      if (prefetched.length > 0) {
        return prefetched.slice(0, limit);
      }

      // 异步触发预取（不等待）
      this.prefetcher.prefetch(query).catch(error => {
        console.error('[FileMemoryManager] Async prefetch failed:', error);
      });
    }

    // 同步获取相关记忆
    return this.memoryLoader.getRelevantMemories(query, limit);
  }

  /**
   * 异步预取记忆
   */
  async prefetchMemories(query: string): Promise<boolean> {
    if (!this.prefetcher) return false;

    try {
      const result = await this.prefetcher.prefetch(query);
      return result.success;
    } catch (error) {
      console.error('[FileMemoryManager] Prefetch failed:', error);
      return false;
    }
  }

  /**
   * 从对话中提取记忆
   */
  async extractMemoriesFromConversation(
    messages: ConversationMessage[]
  ): Promise<{ candidates: CandidateMemory[]; saved: number }> {
    if (!this.extractor) {
      return { candidates: [], saved: 0 };
    }

    try {
      // 提取候选记忆
      const candidates = this.extractor.extractFromConversation(messages);
      
      if (candidates.length === 0) {
        return { candidates: [], saved: 0 };
      }

      // 保存记忆到文件
      const memoryDir = this.config.memory.memoryDir || DEFAULT_CONFIG.memory.memoryDir!;
      const { saved } = await this.extractor.saveMemories(candidates, memoryDir);

      // 更新索引
      await this.extractor.updateMemoryIndex(memoryDir, this.config.memory.entrypointName);

      // 清除缓存以反映新记忆
      this.memoryLoader.clearCache();
      if (this.prefetcher) {
        this.prefetcher.clearPrefetchCache();
      }

      return { candidates, saved };
    } catch (error) {
      console.error('[FileMemoryManager] Memory extraction failed:', error);
      return { candidates: [], saved: 0 };
    }
  }

  /**
   * 手动保存记忆
   */
  async saveMemory(
    content: string,
    name: string,
    type: 'user' | 'feedback' | 'project' | 'reference',
    description?: string
  ): Promise<boolean> {
    try {
      const memoryDir = this.config.memory.memoryDir || DEFAULT_CONFIG.memory.memoryDir!;
      await fs.mkdir(memoryDir, { recursive: true });

      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `${type}_${name.toLowerCase().replace(/\s+/g, '-')}_${timestamp}.md`;
      const filePath = path.join(memoryDir, filename);

      const memoryContent = `---
name: ${name}
description: ${description || content.substring(0, 100)}
type: ${type}
---

${content}

---
*保存时间: ${new Date().toISOString()}*
*手动保存*`;

      await fs.writeFile(filePath, memoryContent, 'utf-8');

      // 更新索引
      if (this.extractor) {
        await this.extractor.updateMemoryIndex(memoryDir, this.config.memory.entrypointName);
      }

      // 清除缓存
      this.memoryLoader.clearCache();
      if (this.prefetcher) {
        this.prefetcher.clearPrefetchCache();
      }

      return true;
    } catch (error) {
      console.error('[FileMemoryManager] Failed to save memory:', error);
      return false;
    }
  }

  /**
   * 获取记忆清单
   */
  async getMemoryManifest(): Promise<string> {
    await this.ensureInitialized();

    try {
      const allLevels = await this.memoryLoader.loadAllLevels();
      return this.memoryLoader.formatMultiLevelManifest(allLevels);
    } catch (error) {
      console.error('[FileMemoryManager] Failed to get memory manifest:', error);
      return '无法加载记忆清单';
    }
  }

  /**
   * 搜索记忆
   */
  async searchMemories(
    query: string,
    options?: {
      type?: 'user' | 'feedback' | 'project' | 'reference';
      limit?: number;
      minRelevance?: number;
    }
  ): Promise<MemoryHeader[]> {
    await this.ensureInitialized();

    const allLevels = await this.memoryLoader.loadAllLevels();
    const allMemories: MemoryHeader[] = [];
    
    Object.values(allLevels).forEach(memories => {
      allMemories.push(...memories);
    });

    // 过滤类型
    let filtered = allMemories;
    if (options?.type) {
      filtered = filtered.filter(m => m.type === options.type);
    }

    // 搜索
    const queryLower = query.toLowerCase();
    const results = filtered.filter(memory => {
      if (memory.description?.toLowerCase().includes(queryLower)) return true;
      if (memory.filename.toLowerCase().includes(queryLower)) return true;
      return false;
    });

    // 按修改时间排序
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return results.slice(0, options?.limit || 20);
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<{
    totalMemories: number;
    byType: Record<string, number>;
    byLevel: Record<string, number>;
    cacheSize: number;
  }> {
    await this.ensureInitialized();

    const allLevels = await this.memoryLoader.loadAllLevels();
    const allMemories: MemoryHeader[] = [];
    
    Object.entries(allLevels).forEach(([level, memories]) => {
      allMemories.push(...memories);
    });

    // 按类型统计
    const byType: Record<string, number> = {};
    allMemories.forEach(memory => {
      const type = memory.type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    });

    // 按级别统计
    const byLevel: Record<string, number> = {};
    Object.entries(allLevels).forEach(([level, memories]) => {
      byLevel[level] = memories.length;
    });

    // 缓存大小
    const cacheSize = this.prefetcher ? this.prefetcher.getCacheStats().size : 0;

    return {
      totalMemories: allMemories.length,
      byType,
      byLevel,
      cacheSize,
    };
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    if (this.prefetcher) {
      this.prefetcher.dispose();
    }
    
    this.memoryLoader.clearCache();
    this.isInitialized = false;
  }

  /**
   * 确保已初始化
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * 获取配置
   */
  getConfig(): FileMemoryManagerConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<FileMemoryManagerConfig>): void {
    this.config = { ...this.config, ...config };
    
    // 重新初始化组件
    if (config.multiLevel || config.memory) {
      this.memoryLoader = new MultiLevelMemoryLoader({
        ...this.config.memory,
        ...this.config.multiLevel,
      });
    }

    if (config.prefetch && this.prefetcher) {
      this.prefetcher.updateConfig(this.config.prefetch);
    }

    if (config.extraction && this.extractor) {
      this.extractor.updateConfig(this.config.extraction);
    }
  }
}

/**
 * 创建文件记忆管理器实例
 */
export function createFileMemoryManager(
  config?: Partial<FileMemoryManagerConfig>
): FileMemoryManager {
  return new FileMemoryManager(config);
}