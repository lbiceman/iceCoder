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
 * - relevanceGate: 相关性门控参数
 * - sessionMemory: 会话记忆参数（初始化 token 阈值、更新间隔）
 *
 * 设计原则：
 * - 本地值优先：配置文件中的值覆盖代码默认值
 * - 缓存 + 定期刷新：避免每次调用都读文件
 * - 容错：配置文件不存在或格式错误时使用默认值
 * - 默认值统一引用 memory-config.ts，避免重复定义
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type MemoryDynamicConfig,
  DEFAULT_DYNAMIC_CONFIG,
} from './memory-config.js';

/** 远程配置文件路径 */
const REMOTE_CONFIG_FILE_PATH = 'data/memory/memory-config.json';
/** 远程配置缓存刷新间隔（毫秒） */
const REMOTE_CONFIG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// 重新导出类型，保持向后兼容
export type {
  MemoryDynamicConfig,
  ExtractionRemoteConfig,
  DreamRemoteConfig,
  RecallConfig,
  RelevanceGateConfig,
  SessionMemoryConfig,
} from './memory-config.js';

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
  if (now - lastLoadTime > REMOTE_CONFIG_REFRESH_INTERVAL_MS) {
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
    const content = await fs.readFile(REMOTE_CONFIG_FILE_PATH, 'utf-8');
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
  const dir = path.dirname(REMOTE_CONFIG_FILE_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(REMOTE_CONFIG_FILE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
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

export function getRelevanceGateConfig(): MemoryDynamicConfig['relevanceGate'] {
  return getDynamicConfig().relevanceGate;
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
    relevanceGate: mergeSection(base.relevanceGate, override.relevanceGate),
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
