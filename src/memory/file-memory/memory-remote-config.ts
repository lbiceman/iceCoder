/**
 * 记忆系统远程/动态配置。
 *
 * 支持从配置文件动态加载记忆系统参数，无需重启进程。
 * 配置文件路径：data/memory/memory-config.json
 *
 * 配置项：
 * - extraction: 提取阈值（最小轮次、token 阈值、工具调用阈值）
 * - dream: 整合阈值（最小小时间隔、最小会话数）
 * - recall: 召回参数（最大结果数）
 * - sessionMemory: 会话记忆参数（初始化 token 阈值、更新间隔）
 *
 * 设计原则：
 * - 本地值优先：配置文件中的值覆盖代码默认值
 * - 缓存 + 定期刷新：避免每次调用都读文件
 * - 容错：配置文件不存在或格式错误时使用默认值
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 动态配置结构。
 */
export interface MemoryDynamicConfig {
  extraction: {
    /** 触发提取的最小对话轮次 */
    minTurns: number;
    /** 触发提取的最小 token 数（上下文窗口） */
    minTokens: number;
    /** 触发提取的工具调用间隔 */
    toolCallInterval: number;
    /** 每 N 个合格轮次提取一次（节流） */
    turnThrottle: number;
  };
  dream: {
    /** 两次整合之间的最小小时数 */
    minHours: number;
    /** 触发整合的最小会话数 */
    minSessions: number;
    /** 是否启用 autoDream */
    enabled: boolean;
  };
  recall: {
    /** 最大召回结果数 */
    maxResults: number;
  };
  sessionMemory: {
    /** 是否启用会话记忆 */
    enabled: boolean;
    /** 初始化会话记忆的最小 token 数 */
    minTokensToInit: number;
    /** 两次更新之间的最小 token 增长 */
    minTokensBetweenUpdate: number;
    /** 两次更新之间的最小工具调用数 */
    toolCallsBetweenUpdates: number;
  };
}

/**
 * 默认动态配置。
 */
const DEFAULT_DYNAMIC_CONFIG: MemoryDynamicConfig = {
  extraction: {
    minTurns: 3,
    minTokens: 5000,
    toolCallInterval: 3,
    turnThrottle: 1,
  },
  dream: {
    minHours: 6,
    minSessions: 3,
    enabled: true,
  },
  recall: {
    maxResults: 5,
  },
  sessionMemory: {
    enabled: true,
    minTokensToInit: 10000,
    minTokensBetweenUpdate: 5000,
    toolCallsBetweenUpdates: 3,
  },
};

/** 配置文件路径 */
const CONFIG_FILE_PATH = 'data/memory/memory-config.json';

/** 缓存刷新间隔（5 分钟） */
const CACHE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** 缓存的配置 */
let cachedConfig: MemoryDynamicConfig = { ...DEFAULT_DYNAMIC_CONFIG };
/** 上次加载时间 */
let lastLoadTime = 0;

/**
 * 获取动态配置（带缓存）。
 * 非阻塞：返回缓存值，后台刷新。
 */
export function getDynamicConfig(): MemoryDynamicConfig {
  const now = Date.now();
  if (now - lastLoadTime > CACHE_REFRESH_INTERVAL_MS) {
    // 后台刷新，不阻塞
    refreshConfig().catch(() => {});
  }
  return cachedConfig;
}

/**
 * 强制刷新配置（同步等待）。
 */
export async function refreshConfig(): Promise<MemoryDynamicConfig> {
  try {
    const content = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');
    const raw = JSON.parse(content);
    cachedConfig = mergeConfig(DEFAULT_DYNAMIC_CONFIG, raw);
    lastLoadTime = Date.now();
  } catch {
    // 文件不存在或格式错误，使用默认值
    cachedConfig = { ...DEFAULT_DYNAMIC_CONFIG };
    lastLoadTime = Date.now();
  }
  return cachedConfig;
}

/**
 * 保存当前配置到文件。
 */
export async function saveConfig(config: Partial<MemoryDynamicConfig>): Promise<void> {
  const merged = mergeConfig(cachedConfig, config);
  const dir = path.dirname(CONFIG_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  cachedConfig = merged;
  lastLoadTime = Date.now();
}

/**
 * 获取特定配置项（类型安全的快捷方法）。
 */
export function getExtractionConfig(): MemoryDynamicConfig['extraction'] {
  return getDynamicConfig().extraction;
}

export function getDreamConfig(): MemoryDynamicConfig['dream'] {
  return getDynamicConfig().dream;
}

export function getRecallConfig(): MemoryDynamicConfig['recall'] {
  return getDynamicConfig().recall;
}

export function getSessionMemoryConfig(): MemoryDynamicConfig['sessionMemory'] {
  return getDynamicConfig().sessionMemory;
}

/**
 * 重置为默认配置（用于测试）。
 */
export function resetDynamicConfig(): void {
  cachedConfig = { ...DEFAULT_DYNAMIC_CONFIG };
  lastLoadTime = 0;
}

// ─── 内部工具 ───

/**
 * 深度合并配置，只覆盖有效的正数值。
 */
function mergeConfig(
  base: MemoryDynamicConfig,
  override: any,
): MemoryDynamicConfig {
  if (!override || typeof override !== 'object') return { ...base };

  return {
    extraction: mergeSection(base.extraction, override.extraction),
    dream: mergeSection(base.dream, override.dream),
    recall: mergeSection(base.recall, override.recall),
    sessionMemory: mergeSection(base.sessionMemory, override.sessionMemory),
  };
}

function mergeSection<T extends Record<string, any>>(base: T, override: any): T {
  if (!override || typeof override !== 'object') return { ...base };

  const result = { ...base };
  for (const key of Object.keys(base)) {
    const baseVal = base[key];
    const overrideVal = override[key];

    if (overrideVal === undefined || overrideVal === null) continue;

    if (typeof baseVal === 'number') {
      // 数值：只接受正数
      if (typeof overrideVal === 'number' && Number.isFinite(overrideVal) && overrideVal > 0) {
        (result as any)[key] = overrideVal;
      }
    } else if (typeof baseVal === 'boolean') {
      if (typeof overrideVal === 'boolean') {
        (result as any)[key] = overrideVal;
      }
    } else {
      (result as any)[key] = overrideVal;
    }
  }
  return result;
}
