/**
 * 多级文件记忆加载器。
 * 
 * 三级加载机制：
 * 1. 项目级记忆 (project-level): 项目根目录下的记忆
 * 2. 用户级记忆 (user-level): 用户特定目录下的记忆
 * 3. 目录级记忆 (directory-level): 当前工作目录下的记忆
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryHeader, FileMemoryConfig } from './types.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scanner.js';
import { memoryFreshnessNote } from './memory-age.js';

/**
 * 多级记忆配置
 */
export interface MultiLevelMemoryConfig extends FileMemoryConfig {
  /** 项目根目录 */
  projectRoot: string;
  /** 用户记忆目录 */
  userMemoryDir: string;
  /** 当前工作目录 */
  currentDir: string;
  /** 是否启用团队记忆同步 */
  enableTeamSync?: boolean;
  /** 团队记忆目录 */
  teamMemoryDir?: string;
}

/**
 * 默认配置
 */
const DEFAULT_MULTI_LEVEL_CONFIG: MultiLevelMemoryConfig = {
  memoryDir: './data/memory-files',
  entrypointName: 'MEMORY.md',
  maxEntrypointLines: 200,
  maxEntrypointBytes: 25000,
  maxMemoryFiles: 200,
  projectRoot: '.',
  userMemoryDir: './data/user-memory',
  currentDir: '.',
};

/**
 * 记忆级别
 */
export enum MemoryLevel {
  PROJECT = 'project',
  USER = 'user',
  DIRECTORY = 'directory',
  TEAM = 'team',
}

/**
 * 多级记忆加载器
 */
export class MultiLevelMemoryLoader {
  private config: MultiLevelMemoryConfig;
  private memoryCache: Map<MemoryLevel, MemoryHeader[]> = new Map();
  private lastSyncTime: Map<MemoryLevel, number> = new Map();
  private syncInterval: number = 5 * 60 * 1000; // 5分钟同步一次

  constructor(config?: Partial<MultiLevelMemoryConfig>) {
    this.config = { ...DEFAULT_MULTI_LEVEL_CONFIG, ...config };
  }

  /**
   * 加载所有级别的记忆
   */
  async loadAllLevels(): Promise<Record<MemoryLevel, MemoryHeader[]>> {
    const levels = [
      MemoryLevel.PROJECT,
      MemoryLevel.USER,
      MemoryLevel.DIRECTORY,
      ...(this.config.enableTeamSync && this.config.teamMemoryDir ? [MemoryLevel.TEAM] : []),
    ];

    const results = await Promise.all(
      levels.map(async (level) => {
        const memories = await this.loadLevel(level);
        return { level, memories };
      })
    );

    const resultMap: Record<MemoryLevel, MemoryHeader[]> = {
      [MemoryLevel.PROJECT]: [],
      [MemoryLevel.USER]: [],
      [MemoryLevel.DIRECTORY]: [],
      [MemoryLevel.TEAM]: [],
    };

    results.forEach(({ level, memories }) => {
      resultMap[level] = memories;
    });

    return resultMap;
  }

  /**
   * 加载指定级别的记忆
   */
  async loadLevel(level: MemoryLevel): Promise<MemoryHeader[]> {
    const now = Date.now();
    const lastSync = this.lastSyncTime.get(level) || 0;
    
    // 检查缓存是否有效
    if (this.memoryCache.has(level) && (now - lastSync) < this.syncInterval) {
      return this.memoryCache.get(level)!;
    }

    let memoryDir: string;
    switch (level) {
      case MemoryLevel.PROJECT:
        memoryDir = path.join(this.config.projectRoot, this.config.memoryDir);
        break;
      case MemoryLevel.USER:
        memoryDir = this.config.userMemoryDir;
        break;
      case MemoryLevel.DIRECTORY:
        memoryDir = path.join(this.config.currentDir, this.config.memoryDir);
        break;
      case MemoryLevel.TEAM:
        memoryDir = this.config.teamMemoryDir!;
        break;
      default:
        memoryDir = this.config.memoryDir;
    }

    try {
      // 确保目录存在
      await fs.mkdir(memoryDir, { recursive: true });
      
      // 扫描记忆文件
      const memories = await scanMemoryFiles(memoryDir, this.config.maxMemoryFiles);
      
      // 更新缓存
      this.memoryCache.set(level, memories);
      this.lastSyncTime.set(level, now);
      
      return memories;
    } catch (error) {
      console.error(`[MultiLevelMemory] Failed to load ${level} memories:`, error);
      return [];
    }
  }

  /**
   * 获取相关记忆（跨级别检索）
   */
  async getRelevantMemories(query: string, limit: number = 10): Promise<MemoryHeader[]> {
    const allLevels = await this.loadAllLevels();
    const allMemories: MemoryHeader[] = [];
    
    // 合并所有级别的记忆
    Object.values(allLevels).forEach(memories => {
      allMemories.push(...memories);
    });

    // 简单关键词匹配（后续可优化为语义搜索）
    const queryLower = query.toLowerCase();
    const relevant = allMemories.filter(memory => {
      if (memory.description?.toLowerCase().includes(queryLower)) {
        return true;
      }
      
      // 检查文件名
      if (memory.filename.toLowerCase().includes(queryLower)) {
        return true;
      }
      
      return false;
    });

    // 按修改时间排序（最新的优先）
    relevant.sort((a, b) => b.mtimeMs - a.mtimeMs);
    
    return relevant.slice(0, limit);
  }

  /**
   * 格式化多级记忆清单
   */
  formatMultiLevelManifest(memoriesByLevel: Record<MemoryLevel, MemoryHeader[]>): string {
    let result = '';
    
    Object.entries(memoriesByLevel).forEach(([level, memories]) => {
      if (memories.length === 0) return;
      
      result += `\n## ${this.getLevelDisplayName(level as MemoryLevel)} 记忆\n\n`;
      result += formatMemoryManifest(memories);
    });

    return result.trim();
  }

  /**
   * 获取带新鲜度提醒的记忆内容
   */
  async getMemoryWithFreshness(memoryPath: string): Promise<string> {
    try {
      const content = await fs.readFile(memoryPath, 'utf-8');
      const stat = await fs.stat(memoryPath);
      
      const freshnessNote = memoryFreshnessNote(stat.mtimeMs);
      return freshnessNote + content;
    } catch (error) {
      console.error(`[MultiLevelMemory] Failed to read memory: ${memoryPath}`, error);
      return '';
    }
  }

  /**
   * 同步团队记忆
   */
  async syncTeamMemories(): Promise<boolean> {
    if (!this.config.enableTeamSync || !this.config.teamMemoryDir) {
      return false;
    }

    try {
      // 检查团队目录是否存在
      await fs.access(this.config.teamMemoryDir);
      
      // 加载团队记忆
      const teamMemories = await this.loadLevel(MemoryLevel.TEAM);
      
      // 同步到用户目录（可选）
      // 这里可以实现更复杂的同步逻辑，如增量同步、冲突解决等
      
      console.log(`[MultiLevelMemory] Synced ${teamMemories.length} team memories`);
      return true;
    } catch (error) {
      console.error('[MultiLevelMemory] Team sync failed:', error);
      return false;
    }
  }

  /**
   * 获取级别显示名称
   */
  private getLevelDisplayName(level: MemoryLevel): string {
    switch (level) {
      case MemoryLevel.PROJECT:
        return '项目';
      case MemoryLevel.USER:
        return '用户';
      case MemoryLevel.DIRECTORY:
        return '目录';
      case MemoryLevel.TEAM:
        return '团队';
      default:
        return level;
    }
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.memoryCache.clear();
    this.lastSyncTime.clear();
  }

  /**
   * 设置同步间隔（毫秒）
   */
  setSyncInterval(interval: number): void {
    this.syncInterval = interval;
  }
}

/**
 * 创建多级记忆加载器实例
 */
export function createMultiLevelMemoryLoader(
  config?: Partial<MultiLevelMemoryConfig>
): MultiLevelMemoryLoader {
  return new MultiLevelMemoryLoader(config);
}