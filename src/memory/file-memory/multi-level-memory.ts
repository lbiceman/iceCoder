/**
 * 多级文件记忆加载器。
 * 
 * 三级加载机制（按优先级从低到高排列，越靠后优先级越高）：
 * 1. 用户级记忆 (user-level): 用户特定目录下的个人记忆（最低优先级）
 * 2. 项目级记忆 (project-level): 项目根目录下的共享记忆
 * 3. 目录级记忆 (directory-level): 当前工作目录下的项目私有配置（最高优先级）
 *
 * 参考 claude-code 的优先级设计：越靠后的文件模型注意力越高。
 * 用户级 → 项目共享 → 项目私有（最后加载 = 最高优先级）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryHeader, FileMemoryConfig } from './types.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scanner.js';
import { memoryFreshnessNote } from './memory-age.js';
import { DEFAULT_MULTI_LEVEL_CONFIG as CENTRALIZED_DEFAULT } from './memory-config.js';

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
}

/**
 * 记忆级别
 */
export enum MemoryLevel {
  PROJECT = 'project',
  USER = 'user',
  DIRECTORY = 'directory',
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
    this.config = { ...CENTRALIZED_DEFAULT, ...config };
  }

  /**
   * 加载所有级别的记忆。
   *
   * 顺序：USER → PROJECT → DIRECTORY（越靠后优先级越高）。
   * 参考 claude-code：later files = higher priority。
   */
  async loadAllLevels(): Promise<Record<MemoryLevel, MemoryHeader[]>> {
    const levels = [
      MemoryLevel.USER,
      MemoryLevel.PROJECT,
      MemoryLevel.DIRECTORY,
    ];

    const results = await Promise.all(
      levels.map(async (level) => {
        const memories = await this.loadLevel(level);
        return { level, memories };
      })
    );

    // 初始化顺序与 levels 一致：USER → PROJECT → DIRECTORY（越靠后优先级越高）
    const resultMap: Record<MemoryLevel, MemoryHeader[]> = {
      [MemoryLevel.USER]: [],
      [MemoryLevel.PROJECT]: [],
      [MemoryLevel.DIRECTORY]: [],
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
        memoryDir = path.isAbsolute(this.config.memoryDir)
          ? this.config.memoryDir
          : path.join(this.config.projectRoot, this.config.memoryDir);
        break;
      case MemoryLevel.USER:
        memoryDir = this.config.userMemoryDir;
        break;
      case MemoryLevel.DIRECTORY:
        memoryDir = path.isAbsolute(this.config.memoryDir)
          ? this.config.memoryDir
          : path.join(this.config.currentDir, this.config.memoryDir);
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
   * 获取所有记忆（跨级别合并，不做过滤）。
   * 供 recallRelevantMemories 等外部召回逻辑使用。
   */
  async getAllMemories(): Promise<MemoryHeader[]> {
    const allLevels = await this.loadAllLevels();
    const allMemories: MemoryHeader[] = [];
    Object.values(allLevels).forEach(memories => {
      allMemories.push(...memories);
    });
    return allMemories;
  }

  /**
   * 格式化多级记忆清单。
   *
   * 按优先级从低到高排列（越靠后 = 模型注意力越高）：
   * 用户（全局） → 项目（共享） → 项目（私有）
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
   * 获取级别显示名称
   */
  private getLevelDisplayName(level: MemoryLevel): string {
    switch (level) {
      case MemoryLevel.USER:
        return '用户（全局）';
      case MemoryLevel.PROJECT:
        return '项目（共享）';
      case MemoryLevel.DIRECTORY:
        return '项目（私有）';
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