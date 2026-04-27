/**
 * 记忆系统遥测和可观测性。
 *
 * 记录记忆系统各环节的运行数据，用于量化效果和持续优化：
 * - 召回形状（候选数、选中数、LLM/关键词、耗时）
 * - 提取形状（消息数、提取数、prompt cache 命中、耗时）
 * - Dream 形状（文件数、修改数、删除数、耗时）
 * - 记忆库统计（总数、按类型分布、平均年龄）
 *
 * 数据写入 JSON 日志文件（data/memory/telemetry.jsonl），
 * 同时通过 EventEmitter 暴露给外部消费者（如 SSE 推送）。
 */

import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_TELEMETRY_CONFIG } from './memory-config.js';

/**
 * 遥测事件类型。
 */
export type TelemetryEventType =
  | 'memory_recall'
  | 'memory_extract'
  | 'memory_dream'
  | 'memory_store'
  | 'memory_stats';

/**
 * 召回遥测数据。
 */
export interface RecallTelemetry {
  type: 'memory_recall';
  timestamp: string;
  /** 候选记忆文件数 */
  candidateCount: number;
  /** 选中的记忆文件数 */
  selectedCount: number;
  /** 是否使用了 LLM */
  usedLLM: boolean;
  /** 召回耗时（毫秒） */
  durationMs: number;
  /** 选中的文件名列表 */
  selectedFiles: string[];
  /** 查询长度（字符数，不记录内容） */
  queryLength: number;
}

/**
 * 提取遥测数据。
 */
export interface ExtractTelemetry {
  type: 'memory_extract';
  timestamp: string;
  /** 输入消息数 */
  messageCount: number;
  /** 提取的记忆数 */
  extractedCount: number;
  /** 是否使用了 prompt cache */
  usedPromptCache: boolean;
  /** 传入的上下文消息数（用于 prompt cache） */
  contextPrefixLength: number;
  /** 提取耗时（毫秒） */
  durationMs: number;
  /** 写入的文件名列表 */
  writtenFiles: string[];
}

/**
 * Dream 遥测数据。
 */
export interface DreamTelemetry {
  type: 'memory_dream';
  timestamp: string;
  /** 是否执行了整合 */
  executed: boolean;
  /** 整合前的文件数 */
  fileCountBefore: number;
  /** 修改的文件数 */
  filesModified: number;
  /** 删除的文件数 */
  filesDeleted: number;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 触发原因 */
  trigger: 'session_interval' | 'file_threshold' | 'manual';
}

/**
 * 记忆库统计遥测。
 */
export interface StatsTelemetry {
  type: 'memory_stats';
  timestamp: string;
  /** 总记忆文件数 */
  totalFiles: number;
  /** 按类型分布 */
  byType: Record<string, number>;
  /** 平均年龄（天） */
  avgAgeDays: number;
  /** 最老记忆年龄（天） */
  maxAgeDays: number;
  /** 索引行数 */
  indexLineCount: number;
}

/**
 * 所有遥测事件的联合类型。
 */
export type TelemetryEvent =
  | RecallTelemetry
  | ExtractTelemetry
  | DreamTelemetry
  | StatsTelemetry;

/**
 * 遥测配置。
 */
export interface TelemetryConfig {
  /** 遥测日志文件路径 */
  logPath: string;
  /** 是否启用文件日志 */
  enableFileLog: boolean;
  /** 是否启用控制台日志 */
  enableConsoleLog: boolean;
  /** 日志文件最大大小（字节），超过后轮转 */
  maxLogSize: number;
}

export class MemoryTelemetry extends EventEmitter {
  private config: TelemetryConfig;
  /** 累计统计（进程生命周期内） */
  private stats = {
    totalRecalls: 0,
    totalExtracts: 0,
    totalDreams: 0,
    llmRecallCount: 0,
    keywordRecallCount: 0,
    promptCacheHits: 0,
    promptCacheMisses: 0,
    totalRecallDurationMs: 0,
    totalExtractDurationMs: 0,
    totalDreamDurationMs: 0,
    totalMemoriesExtracted: 0,
    totalMemoriesSelected: 0,
  };

  constructor(config?: Partial<TelemetryConfig>) {
    super();
    this.config = { ...DEFAULT_TELEMETRY_CONFIG, ...config };
  }

  /**
   * 记录召回事件。
   */
  async logRecall(data: Omit<RecallTelemetry, 'type' | 'timestamp'>): Promise<void> {
    const event: RecallTelemetry = {
      type: 'memory_recall',
      timestamp: new Date().toISOString(),
      ...data,
    };

    this.stats.totalRecalls++;
    this.stats.totalRecallDurationMs += data.durationMs;
    this.stats.totalMemoriesSelected += data.selectedCount;
    if (data.usedLLM) {
      this.stats.llmRecallCount++;
    } else {
      this.stats.keywordRecallCount++;
    }

    await this.writeEvent(event);
  }

  /**
   * 记录提取事件。
   */
  async logExtract(data: Omit<ExtractTelemetry, 'type' | 'timestamp'>): Promise<void> {
    const event: ExtractTelemetry = {
      type: 'memory_extract',
      timestamp: new Date().toISOString(),
      ...data,
    };

    this.stats.totalExtracts++;
    this.stats.totalExtractDurationMs += data.durationMs;
    this.stats.totalMemoriesExtracted += data.extractedCount;
    if (data.usedPromptCache) {
      this.stats.promptCacheHits++;
    } else {
      this.stats.promptCacheMisses++;
    }

    await this.writeEvent(event);
  }

  /**
   * 记录 Dream 事件。
   */
  async logDream(data: Omit<DreamTelemetry, 'type' | 'timestamp'>): Promise<void> {
    const event: DreamTelemetry = {
      type: 'memory_dream',
      timestamp: new Date().toISOString(),
      ...data,
    };

    this.stats.totalDreams++;
    this.stats.totalDreamDurationMs += data.durationMs;

    await this.writeEvent(event);
  }

  /**
   * 记录记忆库统计。
   */
  async logStats(data: Omit<StatsTelemetry, 'type' | 'timestamp'>): Promise<void> {
    const event: StatsTelemetry = {
      type: 'memory_stats',
      timestamp: new Date().toISOString(),
      ...data,
    };

    await this.writeEvent(event);
  }

  /**
   * 获取累计统计摘要。
   */
  getSummary(): Record<string, number> {
    const avgRecallMs = this.stats.totalRecalls > 0
      ? Math.round(this.stats.totalRecallDurationMs / this.stats.totalRecalls)
      : 0;
    const avgExtractMs = this.stats.totalExtracts > 0
      ? Math.round(this.stats.totalExtractDurationMs / this.stats.totalExtracts)
      : 0;
    const cacheHitRate = (this.stats.promptCacheHits + this.stats.promptCacheMisses) > 0
      ? Math.round(this.stats.promptCacheHits / (this.stats.promptCacheHits + this.stats.promptCacheMisses) * 100)
      : 0;
    const llmRecallRate = this.stats.totalRecalls > 0
      ? Math.round(this.stats.llmRecallCount / this.stats.totalRecalls * 100)
      : 0;

    return {
      totalRecalls: this.stats.totalRecalls,
      totalExtracts: this.stats.totalExtracts,
      totalDreams: this.stats.totalDreams,
      avgRecallMs,
      avgExtractMs,
      llmRecallRate,
      cacheHitRate,
      totalMemoriesSelected: this.stats.totalMemoriesSelected,
      totalMemoriesExtracted: this.stats.totalMemoriesExtracted,
    };
  }

  /**
   * 写入遥测事件。
   */
  private async writeEvent(event: TelemetryEvent): Promise<void> {
    // 发射事件（供外部消费者使用）
    this.emit('telemetry', event);

    // 控制台日志
    if (this.config.enableConsoleLog) {
      const summary = this.formatEventSummary(event);
      console.log(`[memory-telemetry] ${summary}`);
    }

    // 文件日志
    if (this.config.enableFileLog) {
      try {
        const dir = path.dirname(this.config.logPath);
        await fs.mkdir(dir, { recursive: true });

        // 检查文件大小，超过上限时轮转
        try {
          const stat = await fs.stat(this.config.logPath);
          if (stat.size > this.config.maxLogSize) {
            const rotatedPath = this.config.logPath + '.old';
            await fs.rename(this.config.logPath, rotatedPath).catch(() => {});
          }
        } catch {
          // 文件不存在，正常
        }

        const line = JSON.stringify(event) + '\n';
        await fs.appendFile(this.config.logPath, line, 'utf-8');
      } catch {
        // 文件写入失败不阻塞
      }
    }
  }

  /**
   * 格式化事件摘要（用于控制台日志）。
   */
  private formatEventSummary(event: TelemetryEvent): string {
    switch (event.type) {
      case 'memory_recall':
        return `recall: ${event.selectedCount}/${event.candidateCount} selected, ${event.usedLLM ? 'LLM' : 'keyword'}, ${event.durationMs}ms`;
      case 'memory_extract':
        return `extract: ${event.extractedCount} from ${event.messageCount} msgs, cache=${event.usedPromptCache}, prefix=${event.contextPrefixLength}, ${event.durationMs}ms`;
      case 'memory_dream':
        return `dream: ${event.executed ? `${event.filesModified} modified, ${event.filesDeleted} deleted` : 'skipped'}, ${event.durationMs}ms`;
      case 'memory_stats':
        return `stats: ${event.totalFiles} files, avg age ${event.avgAgeDays}d, index ${event.indexLineCount} lines`;
    }
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<TelemetryConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * 全局遥测实例（进程级单例）。
 */
let globalTelemetry: MemoryTelemetry | null = null;

/**
 * 获取全局遥测实例。
 */
export function getMemoryTelemetry(config?: Partial<TelemetryConfig>): MemoryTelemetry {
  if (!globalTelemetry) {
    globalTelemetry = new MemoryTelemetry(config);
  }
  return globalTelemetry;
}

/**
 * 重置全局遥测实例（用于测试）。
 */
export function resetMemoryTelemetry(): void {
  globalTelemetry = null;
}
