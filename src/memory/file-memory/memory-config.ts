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

/** 动态配置完整结构（对应 memory-config.json） */
export interface MemoryDynamicConfig {
  extraction: ExtractionRemoteConfig;
  dream: DreamRemoteConfig;
  recall: RecallConfig;
  relevanceGate: RelevanceGateConfig;
  sessionMemory: SessionMemoryConfig;
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
};

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  enabled: true,
  minTokensToInit: 10000,
  minTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3,
};

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  maxResults: 15,
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

/** 完整动态配置默认值 */
export const DEFAULT_DYNAMIC_CONFIG: MemoryDynamicConfig = {
  extraction: { ...DEFAULT_EXTRACTION_REMOTE_CONFIG },
  dream: { ...DEFAULT_DREAM_REMOTE_CONFIG },
  recall: { ...DEFAULT_RECALL_CONFIG },
  relevanceGate: { ...DEFAULT_RELEVANCE_GATE_CONFIG },
  sessionMemory: { ...DEFAULT_SESSION_MEMORY_CONFIG },
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
// 记忆扫描常量（memory-scanner.ts）
// ══════════════════════════════════════════════════════════════════

/** frontmatter 最大读取行数 */
export const FRONTMATTER_MAX_LINES = 30;

/** 正文预览最大字符数 */
export const CONTENT_PREVIEW_MAX_CHARS = 300;

/** Manifest 预览截断字符数 */
export const MANIFEST_PREVIEW_TRUNCATE = 150;

/** 默认置信度回退值 */
export const DEFAULT_CONFIDENCE_FALLBACK = 0.5;

// ══════════════════════════════════════════════════════════════════
// 记忆召回常量（memory-recall.ts）
// ══════════════════════════════════════════════════════════════════

/** 时间范围加权倍数 */
export const TIME_RANGE_BOOST = 1.5;

/** 事件时间加权倍数 */
export const EVENT_TIME_BOOST = 2.0;

/** 关联扩展最大数量 */
export const MAX_RELATED_EXPAND = 3;

/** 召回元数据批量写入间隔（毫秒） */
export const RECALL_FLUSH_INTERVAL_MS = 30_000;

/** LLM 召回超时（毫秒） */
export const LLM_RECALL_TIMEOUT_MS = 30_000;

/** LLM 召回最大输出 token */
export const LLM_RECALL_MAX_TOKENS = 512;

/** Fact 选择上限 */
export const FACT_SELECTION_LIMIT = 30;

/** 置信度过滤阈值（低于此值的记忆不参与召回） */
export const CONFIDENCE_FILTER_THRESHOLD = 0.3;

/** Tags Jaccard 阈值（关联扩展） */
export const TAGS_JACCARD_THRESHOLD = 0.3;

/** Tags Jaccard 阈值（去重） */
export const TAGS_JACCARD_DEDUP_THRESHOLD = 0.6;

/** 关键词粗筛倍数 */
export const COARSE_LIMIT_MULTIPLIER = 3;

/** 关键词粗筛最小数量 */
export const COARSE_LIMIT_MIN = 15;

/** 分数过滤阈值 */
export const SCORE_FILTER_THRESHOLD = 0.05;

/** 置信度加分权重 */
export const CONFIDENCE_BONUS_WEIGHT = 0.15;

/** 召回频率加分权重 */
export const RECALL_BONUS_WEIGHT = 0.1;

/** 召回频率加分上限 */
export const RECALL_BONUS_CAP = 10;

/** 预取命中加分 */
export const PREFETCH_HIT_BONUS = 0.2;

/** 实体匹配加分上限 */
export const ENTITY_MATCH_BONUS_MAX = 0.3;

/** 内容匹配加分上限 */
export const CONTENT_BONUS_MAX = 0.3;

/** description/filename 权重倍数（比 contentPreview 更重要） */
export const DESC_FILENAME_WEIGHT_MULTIPLIER = 2;

/** LLM 相关性检查：上下文关键词截断数 */
export const LLM_RELEVANCE_CONTEXT_LIMIT = 50;

/** LLM 相关性检查：每条记忆 tag 截断数 */
export const LLM_RELEVANCE_TAG_LIMIT = 3;

/** LLM 相关性检查：description 截断字符数 */
export const LLM_RELEVANCE_DESC_TRUNCATE = 80;

// ══════════════════════════════════════════════════════════════════
// Fact 索引常量（memory-fact-index.ts）
// ══════════════════════════════════════════════════════════════════

/** Fact 最小长度 */
export const MIN_FACT_LENGTH = 6;

/** Fact 最大长度 */
export const MAX_FACT_LENGTH = 300;

/** 每个文件最大 Fact 数 */
export const MAX_FACTS_PER_FILE = 30;

/** Fact 排序默认返回数 */
export const FACT_RANK_DEFAULT_MAX = 15;

/** 每个文件默认展示 Fact 数 */
export const FACTS_PER_FILE_DEFAULT = 3;

/** Fact 实体匹配加分 */
export const FACT_ENTITY_MATCH_BONUS = 0.3;

// ══════════════════════════════════════════════════════════════════
// Dream 整合常量（memory-dream.ts）
// ══════════════════════════════════════════════════════════════════

/** Dream 读取文件数上限 */
export const DREAM_READ_LIMIT = 80;

/** Dream 每个文件截断字符数 */
export const DREAM_TRUNCATE_CHARS = 1200;

/** Dream 新增文件触发阈值 */
export const DREAM_NEW_FILES_TRIGGER = 10;

/** Dream 过期记忆触发阈值 */
export const DREAM_EXPIRED_TRIGGER = 3;

/** Dream 状态文件路径 */
export const DREAM_STATE_FILE_PATH = 'data/memory/dream-state.json';

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

// ══════════════════════════════════════════════════════════════════
// LLM 提取常量（memory-llm-extractor.ts）
// ══════════════════════════════════════════════════════════════════

/** 消息内容截断字符数 */
export const EXTRACTION_MESSAGE_TRUNCATE = 2000;

/** 用户级记忆路由的置信度阈值 */
export const USER_LEVEL_CONFIDENCE_THRESHOLD = 1.0;

// ══════════════════════════════════════════════════════════════════
// 会话记忆常量（session-memory.ts）
// ══════════════════════════════════════════════════════════════════

/** 单个 section 最大 token 数 */
export const SESSION_MAX_SECTION_TOKENS = 2000;

/** 会话记忆总 token 上限 */
export const SESSION_MAX_TOTAL_TOKENS = 12000;

/** 内容验证最小长度 */
export const SESSION_VALIDATION_MIN_LENGTH = 50;

// ══════════════════════════════════════════════════════════════════
// 并发控制常量（memory-concurrency.ts）
// ══════════════════════════════════════════════════════════════════

/** 整合锁文件名 */
export const CONSOLIDATION_LOCK_FILE = '.consolidate-lock';

/** 整合锁持有者过期时间（毫秒） */
export const CONSOLIDATION_LOCK_STALE_MS = 60 * 60 * 1000; // 1 小时

/** drainExtractions 默认超时（毫秒） */
export const DRAIN_EXTRACTIONS_TIMEOUT_MS = 60_000;

// ══════════════════════════════════════════════════════════════════
// 扫描缓存常量（memory-scanner-cache.ts）
// ══════════════════════════════════════════════════════════════════

/** 扫描缓存默认 TTL（毫秒） */
export const SCANNER_CACHE_TTL_MS = 30_000;

// ══════════════════════════════════════════════════════════════════
// Harness 集成常量（harness-memory.ts）
// ══════════════════════════════════════════════════════════════════

/** 话题切换 Jaccard 阈值 */
export const TOPIC_SHIFT_JACCARD_THRESHOLD = 0.2;

/** 文件粒度内容截断字符数 */
export const HARNESS_FILE_CONTENT_TRUNCATE = 2000;

/** 提取消息分块大小 */
export const EXTRACTION_CHUNK_SIZE = 20;

/** 提取最大分块数 */
export const EXTRACTION_MAX_CHUNKS = 3;

/** 粗召回倍数 */
export const COARSE_RECALL_MULTIPLIER = 6;

/** 回退召回倍数 */
export const FALLBACK_RECALL_MULTIPLIER = 2;

/** 会话记忆 LLM 最大输出 token */
export const SESSION_MEMORY_LLM_MAX_TOKENS = 4096;

/** 会话记忆净化前缀消息数 */
export const SESSION_MEMORY_SANITIZED_PREFIX_LIMIT = 50;

/** 远程配置缓存刷新间隔（毫秒） */
export const REMOTE_CONFIG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** 远程配置文件路径 */
export const REMOTE_CONFIG_FILE_PATH = 'data/memory/memory-config.json';
