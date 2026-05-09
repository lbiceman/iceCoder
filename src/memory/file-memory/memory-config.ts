/**
 * 记忆系统统一配置中心。
 *
 * 所有记忆模块的默认值、接口定义集中在此文件管理，
 * 避免路径和阈值散落在各模块中导致不一致。
 *
 * 三层配置：
 * 1. 静态默认值（本文件）— 编译时确定，不随运行时变化
 * 2. 远程动态配置（memory-remote-config.ts）— 从 JSON 文件热加载
 * 3. 硬编码常量（本文件）— 不需要运行时调整的内部参数
 *
 * 设计原则：
 * - 接口定义只在此文件出现一次（Single Source of Truth）
 * - 其他模块从本文件 import，不自行定义重复常量
 * - 远程配置的默认值也引用本文件的常量，避免值不一致
 */

import type { FileMemoryConfig } from './types.js';

// ══════════════════════════════════════════════════════════════════
// 目录与路径
// ══════════════════════════════════════════════════════════════════

/** 默认记忆文件存储目录 */
export const DEFAULT_MEMORY_DIR = './data/memory-files';

/** 默认用户级记忆目录 */
export const DEFAULT_USER_MEMORY_DIR = './data/user-memory';

/** 默认索引文件名 */
export const DEFAULT_ENTRYPOINT_NAME = 'MEMORY.md';

// ══════════════════════════════════════════════════════════════════
// 接口定义（Single Source of Truth）
// ══════════════════════════════════════════════════════════════════

/** 文件记忆基础配置 */
export type { FileMemoryConfig } from './types.js';

/** 多级加载配置 */
export interface MultiLevelMemoryConfig extends FileMemoryConfig {
  projectRoot: string;
  userMemoryDir: string;
  currentDir: string;
}

/** 异步预取配置 */
export interface PrefetchConfig {
  timeout: number;
  maxPrefetch: number;
  enableRelevance: boolean;
  relevanceThreshold: number;
}

/** LLM 提取配置 */
export interface LLMExtractionConfig {
  maxMemories: number;
  maxOutputTokens: number;
  enablePromptCache: boolean;
}

/** Dream 整合配置 */
export interface DreamConfig {
  sessionInterval: number;
  fileCountThreshold: number;
  maxIndexLines: number;
  maxIndexBytes: number;
  maxOutputTokens: number;
  enableBackup: boolean;
  backupDir: string;
  maxBackups: number;
}

/** 遥测配置 */
export interface TelemetryConfig {
  logPath: string;
  enableFileLog: boolean;
  enableConsoleLog: boolean;
  maxLogSize: number;
}

/** 淘汰配置 */
export interface EvictionConfig {
  enabled: boolean;
  softLimit: number;
  evictionTarget: number;
  evictedDir: string;
  maxEvictedFiles: number;
  protectionDays: number;
}

/** 相关性门控配置 */
export interface RelevanceGateConfig {
  enabled: boolean;
  contextWindow: number;
  minKeywordOverlap: number;
  rescueThreshold: number;
  /** rescue 结果缓存大小（LRU，默认 20） */
  rescueCacheSize: number;
  /** 短预览匹配阈值：总 contentPreview 字符数低于此值时跳过 LLM rescue（默认 500） */
  rescueShortPreviewThreshold: number;
}

/** 会话记忆远程配置 */
export interface SessionMemoryConfig {
  enabled: boolean;
  minTokensToInit: number;
  minTokensBetweenUpdate: number;
  toolCallsBetweenUpdates: number;
}

/** 召回远程配置 */
export interface RecallConfig {
  maxResults: number;
  /** 会话内去重：避免同一记忆在同一会话中反复注入（默认 true） */
  dedupInSession: boolean;
  /** 记忆注入占上下文窗口的最大比例（默认 0.05，即 5%） */
  budgetTokenRatio: number;
  /** 记忆注入的绝对 token 上限（默认 3000） */
  maxMemoryBudget: number;
  /** 预算紧张时至少注入的记忆数（默认 3） */
  minBudgetResults: number;
  /** 话题切换时各类型记忆的权重倍数 */
  topicSwitchWeight: Record<string, number>;
}

/** 提取远程配置 */
export interface ExtractionRemoteConfig {
  minTurns: number;
  minTokens: number;
  toolCallInterval: number;
  turnThrottle: number;
}

/** Dream 远程配置 */
export interface DreamRemoteConfig {
  minHours: number;
  minSessions: number;
  enabled: boolean;
}

/** 用户反馈配置 */
export interface FeedbackConfig {
  /** 是否启用反馈检测（默认 true） */
  enabled: boolean;
  /** 否定关键词 */
  negativeKeywords: string[];
  /** 肯定关键词 */
  positiveKeywords: string[];
  /** 反馈窗口最大轮次（默认 3） */
  maxTurnsToFeedback: number;
}

/** 动态配置完整结构（对应 memory-config.json） */
export interface MemoryDynamicConfig {
  extraction: ExtractionRemoteConfig;
  dream: DreamRemoteConfig;
  recall: RecallConfig;
  relevanceGate: RelevanceGateConfig;
  sessionMemory: SessionMemoryConfig;
  feedback: FeedbackConfig;
}

// ══════════════════════════════════════════════════════════════════
// 静态默认值
// ══════════════════════════════════════════════════════════════════

export const DEFAULT_FILE_MEMORY_CONFIG: FileMemoryConfig = {
  memoryDir: DEFAULT_MEMORY_DIR,
  entrypointName: DEFAULT_ENTRYPOINT_NAME,
  maxEntrypointLines: 200,
  maxEntrypointBytes: 25000,
  maxMemoryFiles: 150,
};

export const DEFAULT_MULTI_LEVEL_CONFIG: MultiLevelMemoryConfig = {
  ...DEFAULT_FILE_MEMORY_CONFIG,
  projectRoot: '.',
  userMemoryDir: process.env.ICE_USER_MEMORY_DIR ?? './data/user-memory',
  currentDir: '.',
};

export const DEFAULT_PREFETCH_CONFIG: PrefetchConfig = {
  timeout: 5000,
  maxPrefetch: 20,
  enableRelevance: true,
  relevanceThreshold: 0.3,
};

export const DEFAULT_LLM_EXTRACTION_CONFIG: LLMExtractionConfig = {
  maxMemories: 15,
  maxOutputTokens: 4096,
  enablePromptCache: true,
};

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  sessionInterval: 5,
  fileCountThreshold: 10,
  maxIndexLines: 200,
  maxIndexBytes: 25000,
  maxOutputTokens: 4096,
  enableBackup: true,
  backupDir: 'data/memory/dream-backups',
  maxBackups: 3,
};

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  logPath: 'data/memory/telemetry.jsonl',
  enableFileLog: true,
  enableConsoleLog: false,
  maxLogSize: 5 * 1024 * 1024, // 5MB
};

export const DEFAULT_EVICTION_CONFIG: EvictionConfig = {
  enabled: true,
  softLimit: 120,
  evictionTarget: 100,
  evictedDir: 'data/memory/evicted',
  maxEvictedFiles: 100,
  protectionDays: 3,
};

export const DEFAULT_RELEVANCE_GATE_CONFIG: RelevanceGateConfig = {
  enabled: true,
  contextWindow: 3,
  minKeywordOverlap: 1,
  rescueThreshold: 0.5,
  rescueCacheSize: 20,
  rescueShortPreviewThreshold: 500,
};

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  enabled: true,
  minTokensToInit: 10000,
  minTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
};

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  maxResults: 15,
  dedupInSession: true,
  budgetTokenRatio: 0.05,
  maxMemoryBudget: 3000,
  minBudgetResults: 3,
  topicSwitchWeight: { convention: 1.5, preference: 0.7, fact: 1.0 },
};

export const DEFAULT_EXTRACTION_REMOTE_CONFIG: ExtractionRemoteConfig = {
  minTurns: 3,
  minTokens: 5000,
  toolCallInterval: 3,
  turnThrottle: 1,
};

export const DEFAULT_DREAM_REMOTE_CONFIG: DreamRemoteConfig = {
  minHours: 6,
  minSessions: 3,
  enabled: true,
};

export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  enabled: true,
  negativeKeywords: ['不对', '不是', '错了', '不用', '别', 'wrong', 'incorrect', 'nope', 'stop'],
  positiveKeywords: ['对', '是的', '很好', '就是这样', 'yes', 'correct', 'right', 'good'],
  maxTurnsToFeedback: 3,
};

/** 完整动态配置默认值 */
export const DEFAULT_DYNAMIC_CONFIG: MemoryDynamicConfig = {
  extraction: { ...DEFAULT_EXTRACTION_REMOTE_CONFIG },
  dream: { ...DEFAULT_DREAM_REMOTE_CONFIG },
  recall: { ...DEFAULT_RECALL_CONFIG },
  relevanceGate: { ...DEFAULT_RELEVANCE_GATE_CONFIG },
  sessionMemory: { ...DEFAULT_SESSION_MEMORY_CONFIG },
  feedback: { ...DEFAULT_FEEDBACK_CONFIG },
};

// ══════════════════════════════════════════════════════════════════
// Harness 记忆集成常量
// ══════════════════════════════════════════════════════════════════

/** 记忆注入：最大相关记忆数 */
export const MEMORY_MAX_RELEVANT = 40;

/** LLM 提取触发条件：最小对话轮次 */
export const EXTRACTION_MIN_TURNS = 2;

/**
 * LLM 提取触发信号词。
 * 用户消息包含这些词时，即使轮次不够也触发提取。
 */
export const EXTRACTION_SIGNAL_WORDS = [
  // 记忆指令
  '记住', '记下', 'remember', 'save this', 'keep in mind',
  // 偏好/习惯
  '偏好', '习惯', '喜欢', '不喜欢', 'prefer', 'like', 'dislike',
  // 否定指令
  '不要', '不用', '别用', '禁止', '停止', "don't", 'never', 'stop',
  // 频率/规则
  '应该', '总是', '每次', '始终', '务必', '必须', 'always', 'should', 'must',
  '从不', 'never',
  // 时间/计划
  '以后', '下次', '今后', 'from now on', 'next time',
  '截止', 'deadline', '目标', '计划', 'schedule',
  // 身份/角色
  '我是', '我的角色', '我的职位', '我在', '我负责', 'I am', 'my role',
  // 纠正/反馈
  '不对', '错了', '不好', '太啰嗦', '太复杂', 'wrong', 'incorrect',
  // 技术偏好
  '用中文', '用英文', '简洁', '详细', 'verbose', 'concise',
];

// ══════════════════════════════════════════════════════════════════
// 记忆衰减常量（memory-age.ts）
// ══════════════════════════════════════════════════════════════════

/** 陈旧阈值（天） */
export const STALE_THRESHOLD_DAYS = 90;

/** 过期阈值（天） */
export const EXPIRED_THRESHOLD_DAYS = 180;

/** 高置信度阈值（>= 此值时衰减更慢） */
export const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/** 高置信度衰减倍数 */
export const HIGH_CONFIDENCE_DECAY_MULTIPLIER = 2;

/** 衰减因子：新鲜 */
export const DECAY_FACTOR_FRESH = 1.0;

/** 衰减因子：陈旧 */
export const DECAY_FACTOR_STALE = 0.5;

/** 衰减因子：过期 */
export const DECAY_FACTOR_EXPIRED = 0.1;

// ══════════════════════════════════════════════════════════════════
// 共享常量（多模块引用）
// ══════════════════════════════════════════════════════════════════

/** 默认置信度回退值 */
export const DEFAULT_CONFIDENCE_FALLBACK = 0.5;

/** 用户级记忆路由的置信度阈值 */
export const USER_LEVEL_CONFIDENCE_THRESHOLD = 1.0;

/** Fact 最小长度 */
export const MIN_FACT_LENGTH = 6;

/** 每个文件最大 Fact 数 */
export const MAX_FACTS_PER_FILE = 30;

/** 单行超过该字符数且无换行时，按中英文句号等标点分割为多条 fact */
export const LONG_LINE_SENTENCE_SPLIT_AT = 200;

// ══════════════════════════════════════════════════════════════════
// 淘汰评分常量（memory-eviction.ts / memory-dream.ts 共用）
// ══════════════════════════════════════════════════════════════════

/** 淘汰评分：年龄上限（天） */
export const EVICTION_AGE_CAP_DAYS = 365;

/** 淘汰评分：置信度权重 */
export const EVICTION_CONFIDENCE_WEIGHT = 30;

/** 淘汰评分：召回频率上限 */
export const EVICTION_RECALL_CAP = 20;

/** 淘汰评分：召回频率权重 */
export const EVICTION_RECALL_WEIGHT = 20;

/** 淘汰评分：user 类型加分 */
export const EVICTION_USER_TYPE_BONUS = 15;

/** 淘汰评分：高置信度保护阈值 */
export const EVICTION_CONFIDENCE_PROTECTION = 1.0;

/** 淘汰扫描上限 */
export const EVICTION_SCAN_LIMIT = 10000;
