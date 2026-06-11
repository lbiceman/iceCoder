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
import path from 'node:path';
import { getRuntimeDataDir, getRuntimeMemoryAuxPath } from '../../cli/paths.js';

// ══════════════════════════════════════════════════════════════════
// 目录与路径
// ══════════════════════════════════════════════════════════════════

/** 默认记忆文件存储目录 */
export const DEFAULT_MEMORY_DIR = process.env.ICE_MEMORY_DIR!;

/** 默认用户级记忆目录 */
export const DEFAULT_USER_MEMORY_DIR = process.env.ICE_USER_MEMORY_DIR!;

/** 默认索引文件名 */
export const DEFAULT_ENTRYPOINT_NAME = 'MEMORY.md';

/** 解析用户记忆目录绝对路径（尊重 ICE_USER_MEMORY_DIR） */
export function resolveUserMemoryDir(): string {
  return path.resolve(process.env.ICE_USER_MEMORY_DIR ?? DEFAULT_USER_MEMORY_DIR);
}

/** 统一归档根目录：`{dataDir}/memory-evicted` */
export function resolveMemoryEvictedRoot(): string {
  return path.join(getRuntimeDataDir(), 'memory-evicted');
}

/** 项目级记忆归档目录：`memory-evicted/memory-files` */
export function resolveProjectMemoryEvictedDir(): string {
  return path.join(resolveMemoryEvictedRoot(), 'memory-files');
}

/** 用户级记忆归档目录：`memory-evicted/user-memory` */
export function resolveUserMemoryEvictedDir(): string {
  return path.join(resolveMemoryEvictedRoot(), 'user-memory');
}

/**
 * 活跃记忆扫描时排除的路径（遗留的 `evicted/` 子目录等）。
 * 新归档在 `memory-evicted/` 独立目录，不在活跃目录内。
 */
export function isExcludedFromActiveMemoryScan(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized === 'evicted' || normalized.startsWith('evicted/')) return true;
  return false;
}

/**
 * 按类型的淘汰分加成（越高越优先被淘汰；user 类型仍享受 EVICTION_USER_TYPE_BONUS 保护）。
 */
export function evictionTypeEvictionBias(type: string | undefined): number {
  if (type === 'feedback') return 8;
  if (type === 'reference') return 12;
  return 0;
}

// ══════════════════════════════════════════════════════════════════
// 接口定义（Single Source of Truth）
// ══════════════════════════════════════════════════════════════════

/** 文件记忆基础配置 */
export type { FileMemoryConfig } from './types.js';

/** 多级加载配置（用户级 / 项目级 / 目录级合并时用） */
export interface MultiLevelMemoryConfig extends FileMemoryConfig {
  /** 项目根，用于锚定项目级记忆目录 */
  projectRoot: string;
  /** 用户级记忆根路径（可与环境变量一致） */
  userMemoryDir: string;
  /** 当前工作目录，用于目录级记忆解析 */
  currentDir: string;
}

/** 异步预取配置（`async-prefetch` 等） */
export interface PrefetchConfig {
  /** 单次预取超时（毫秒） */
  timeout: number;
  /** 单次最多预取的记忆条数 */
  maxPrefetch: number;
  /** 是否按相关度过滤预取候选 */
  enableRelevance: boolean;
  /** 相关度分数 ≥ 此值才预取（0–1） */
  relevanceThreshold: number;
}

/** LLM 批量提取记忆时的上限与模型参数 */
export interface LLMExtractionConfig {
  /** 单次响应中最多落盘的记忆条数 */
  maxMemories: number;
  /** 提取用 LLM 补全 token 上限 */
  maxOutputTokens: number;
  /** 是否启用提供商侧 prompt 缓存（静态前缀复用） */
  enablePromptCache: boolean;
}

/**
 * 条数超标时的「加权淘汰」配置（`memory-eviction.ts`）。
 * 文件被移到 `evictedDir`，一般不直接物理删除。
 */
export interface EvictionConfig {
  /** 是否启用自动淘汰 */
  enabled: boolean;
  /** 超过此条数开始考虑淘汰（与 `evictionTarget` 配合） */
  softLimit: number;
  /** 淘汰后目标保留的 `.md` 条数（不含 `MEMORY.md` 时与扫描逻辑一致） */
  evictionTarget: number;
  /** 被淘汰文件移动到的归档目录 */
  evictedDir: string;
  /** `evicted` 目录内最多保留多少个 `.md`，超出删最旧 */
  maxEvictedFiles: number;
  /** 最近活跃（创建/召回/mtime）在天内的记忆不参与淘汰 */
  protectionDays: number;
}

/** autoDream（`memory-dream.ts`）本地静态配置 */
export interface DreamConfig {
  /** `recordSession` 累计多少次会话后，可与文件数门控一起参与触发 */
  sessionInterval: number;
  /** 门控：当前扫描到的记忆文件数 ≥ 此值才可能因「会话+文件」触发 Dream */
  fileCountThreshold: number;
  /** Dream 提示词中要求 `MEMORY.md` 不超过的大致行数 */
  maxIndexLines: number;
  /** 索引字节上限（与行数一起约束入口文件体积） */
  maxIndexBytes: number;
  /** Dream LLM 调用 `maxTokens` 上限 */
  maxOutputTokens: number;
  /** Dream 两阶段 LLM：是否启用 index pass + content pass 拆分 */
  twoPhase: boolean;
  /** 是否在改写前写入备份目录 */
  enableBackup: boolean;
  /** Dream 备份根目录 */
  backupDir: string;
  /** 最多保留几份备份（旧的由 dream 逻辑清理） */
  maxBackups: number;
  /**
   * Dream LLM 步骤完成后是否强制执行记忆数量上限（调用与提取相同的加权淘汰：陈旧、低置信、低召回优先移入 evicted/）。
   */
  enforceMemoryCapAfterDream: boolean;
  /** 项目记忆目录中保留的 .md 条数上限（不含 MEMORY.md）；超出则在 Dream 末尾淘汰。 */
  postDreamMemoryCap: number;
  /** 传入 `evictIfNeeded` 的覆盖项（如测试指定 `evictedDir`）；`softLimit` / `evictionTarget` 仍由本类强制为 `postDreamMemoryCap`。 */
  afterDreamEviction?: Partial<EvictionConfig>;
  /** MEMORY.md 中本地死链数 ≥ 此值时触发 Dream（需 LLM 修索引；与条数上限解耦） */
  staleIndexDeadLinksThreshold: number;
  /** Dream 完成后是否对用户级记忆目录做条数淘汰 */
  enforceUserMemoryCapAfterDream: boolean;
  /** 用户级 .md 条数上限（不含 MEMORY.md，若有） */
  userMemoryPostDreamCap: number;
  /** 用户级淘汰传入 `evictIfNeeded` 的覆盖项；默认归档目录为 `resolveUserMemoryEvictedDir()` */
  afterUserDreamEviction?: Partial<EvictionConfig>;
  /** 索引孤儿比例阈值（orphans/onDisk ≥ 此值触发 index_drift）；默认 0.5 */
  indexOrphanRatioThreshold: number;
  /** 索引孤儿绝对数下限（onDisk 不足时用此值）；默认 10 */
  indexOrphanMinCount: number;
  /** 索引退避基础间隔（ms），默认 60s */
  indexBackoffBaseMs: number;
  /** 索引退避最大间隔（ms），默认 30min */
  indexBackoffMaxMs: number;
  /** Dream LLM 单次 API 请求超时（ms），默认 10 分钟 */
  llmRequestTimeoutMs: number;
}

/**
 * Extract 写时去重 & 规则重复合并配置。
 */
export interface DedupConfig {
  /** Extract 写入时描述相似度阈值（0-1），超过则更新已有文件而非新建 */
  extractSimilarityThreshold: number;
  /** 规则重复合并相似度阈值 */
  ruleMergeSimilarityThreshold: number;
  /** 运行模式：'off' | 'shadow' | 'merge' */
  mode: 'off' | 'shadow' | 'merge';
  /** 规则合并最小候选对数量 */
  ruleMergeMinCandidates: number;
}

/** 记忆遥测落盘与控制台开关（`memory-telemetry.ts`） */
export interface TelemetryConfig {
  /** JSONL 等文件路径 */
  logPath: string;
  /** 是否写文件日志 */
  enableFileLog: boolean;
  /** 是否额外打 console */
  enableConsoleLog: boolean;
  /** 当日志文件超过此字节数时的轮转/截断阈值（由遥测实现解释） */
  maxLogSize: number;
}

/** 召回前的粗排门控与 LLM rescue（`harness-memory` / recall 相关） */
export interface RelevanceGateConfig {
  enabled: boolean;
  /** 与当前轮相邻要考虑的用户消息窗口大小（轮次数） */
  contextWindow: number;
  /** 关键词重叠至少几个才过粗排 */
  minKeywordOverlap: number;
  /** 低于此相关度可触发 rescue 二次判定 */
  rescueThreshold: number;
  /** rescue 结果缓存大小（LRU，默认 20） */
  rescueCacheSize: number;
  /** 短预览匹配阈值：总 contentPreview 字符数低于此值时跳过 LLM rescue（默认 500） */
  rescueShortPreviewThreshold: number;
}

/** 会话级笔记 / 短期摘要更新节奏（`session-memory.ts`） */
export interface SessionMemoryConfig {
  enabled: boolean;
  /** 累计对话 token 超过此值才初始化会话记忆 */
  minTokensToInit: number;
  /** 两次自动更新之间至少间隔多少 token */
  minTokensBetweenUpdate: number;
  /** 或每多少次工具调用触发一次更新（与 token 条件配合） */
  toolCallsBetweenUpdates: number;
}

/** 记忆召回注入到 prompt 时的条数与预算（`memory-recall.ts`） */
export interface RecallConfig {
  /** 粗召回最多取多少条候选 */
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

/**
 * question/inspect 的 LLM 提取门槛（中间档，默认日常路径；见 memory-config.json）。
 * 信号词仍立即提取；轮次深度路径默认要求会话内有过工具调用。
 */
export interface CasualExtractionConfig {
  /** 对话深度触发最少轮次（高于普通 extraction.minTurns） */
  minTurns: number;
  /** 深度触发是否要求本会话已有工具调用 */
  requireToolCalls: boolean;
  /** 无工具时是否仍允许「技术关键词」内容特征触发 */
  allowContentSignalWithoutTools: boolean;
}

/** 何时触发「对话中提取记忆」的远程门控（与 `EXTRACTION_SIGNAL_WORDS` 等并存） */
export interface ExtractionRemoteConfig {
  /** 最少对话轮次 */
  minTurns: number;
  /** 最少累计输入 token */
  minTokens: number;
  /** 每隔多少次工具调用可视为一次提取采样点 */
  toolCallInterval: number;
  /** 同一轮内节流：至少隔多少轮才再尝试提取 */
  turnThrottle: number;
}

/** Dream 是否启用及时间/会话门槛（`getDreamConfig()` 覆盖本地默认） */
export interface DreamRemoteConfig {
  /** 距离上次整合至少间隔小时数 */
  minHours: number;
  /** 自上次 Dream 后至少累计多少次 `recordSession` */
  minSessions: number;
  /** 总开关：为 false 时 `evaluateDreamGate` 直接不跑 LLM Dream */
  enabled: boolean;
}

/** 用户反馈配置 */
export interface FeedbackConfig {
  /** 是否启用反（默认 true） */
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
  casualExtraction: CasualExtractionConfig;
  dream: DreamRemoteConfig;
  recall: RecallConfig;
  relevanceGate: RelevanceGateConfig;
  sessionMemory: SessionMemoryConfig;
  feedback: FeedbackConfig;
}

// ══════════════════════════════════════════════════════════════════
// 静态默认值
// ══════════════════════════════════════════════════════════════════

/** 单项目文件记忆：目录、索引文件名与体积、条数软上限（与 Dream 后 `postDreamMemoryCap` 常对齐） */
export const DEFAULT_FILE_MEMORY_CONFIG: FileMemoryConfig = {
  memoryDir: DEFAULT_MEMORY_DIR,
  entrypointName: DEFAULT_ENTRYPOINT_NAME,
  maxEntrypointLines: 200,
  maxEntrypointBytes: 25000,
  maxMemoryFiles: 60,
};

/** 多层级加载器默认路径占位（实际运行时由 bootstrap 传入真实根目录） */
export const DEFAULT_MULTI_LEVEL_CONFIG: MultiLevelMemoryConfig = {
  ...DEFAULT_FILE_MEMORY_CONFIG,
  projectRoot: '.',
  userMemoryDir: process.env.ICE_USER_MEMORY_DIR!,
  currentDir: '.',
};

/** 后台异步预取记忆的保守默认 */
export const DEFAULT_PREFETCH_CONFIG: PrefetchConfig = {
  timeout: 5000,
  maxPrefetch: 20,
  enableRelevance: true,
  relevanceThreshold: 0.3,
};

/** `memory-llm-extractor` 单次提取规模默认 */
export const DEFAULT_LLM_EXTRACTION_CONFIG: LLMExtractionConfig = {
  maxMemories: 3,
  maxOutputTokens: 8192,
  enablePromptCache: true,
};

/**
 * Dream LLM 时效常量（对齐市面 OpenAI 兼容网关常见上限）。
 *
 * | 来源 | 典型上限 |
 * |------|----------|
 * | OpenAI 官方 SDK 默认 | 600s（客户端，服务端可更长） |
 * | MiniMax / 国内代理网关 | **~300s 服务端处理**（错误码 1001） |
 * | DeepSeek / 多数中转 | 120–300s 不等 |
 *
 * Dream 按 **280s 客户端 + 轻量输入** 设计，避免触达 300s 服务端墙。
 */
export const DREAM_LLM_PROVIDER_CAP_MS = 300_000;
export const DEFAULT_DREAM_LLM_TIMEOUT_MS = 280_000;
/** 分批整合时单轮累计 LLM 耗时软上限（后台任务可自动衔接多轮） */
export const DREAM_LLM_TIME_BUDGET_MS = 420_000;
/** 预算用尽后自动衔接的最大轮数（含首轮） */
export const DREAM_BATCH_MAX_ROUNDS = 6;
/** 单批 LLM 瞬时错误（529/500 等）最大重试次数 */
export const DREAM_BATCH_LLM_MAX_RETRIES = 3;
/** 单批 LLM 重试基础退避（ms） */
export const DREAM_BATCH_RETRY_BASE_MS = 8_000;
/** 衔接轮之间的常规等待（ms） */
export const DREAM_CONTINUATION_DELAY_MS = 8_000;
/** 529 高峰错误后衔接轮等待（ms） */
export const DREAM_CONTINUATION_PEAK_DELAY_MS = 90_000;

/** 超过此条数：改用 manifest 元数据（不全文读盘），单次 LLM */
export const DREAM_MANIFEST_MODE_THRESHOLD = 20;
/** 超过此条数：拆多批 LLM（每批 manifest） */
export const DREAM_BATCH_MODE_THRESHOLD = 80;
/** 每批文件数（过大易超时；97 条 ≈ 9 批） */
export const DREAM_BATCH_FILE_COUNT = 12;
/** 大库单次 LLM maxOutputTokens 上限（降低生成耗时） */
export const DREAM_LARGE_LIB_MAX_OUTPUT_TOKENS = 1536;
/** 写入 Dream prompt 的 MEMORY.md 最大字符（索引可规则重建） */
export const DREAM_INDEX_PROMPT_MAX_CHARS = 12_000;

/**
 * Dream 整合默认：触发门槛、索引大小、备份与 Dream 后条数上限。
 * 远程 `DreamRemoteConfig` 可缩短 `minHours` / `minSessions` 等。
 */
export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  /** 与 `recordSession` 叠加：`sessionCount >= sessionInterval` 时才可能触发 */
  sessionInterval: 5,
  twoPhase: true,
  /** 与门控组合：记忆文件数至少此值才考虑「会话+文件」类触发 */
  fileCountThreshold: 10,
  maxIndexLines: 200,
  maxIndexBytes: 25000,
  maxOutputTokens: 8192,
  enableBackup: true,
  backupDir: getRuntimeMemoryAuxPath('dream-backups'),
  maxBackups: 3,
  enforceMemoryCapAfterDream: true,
  /** 项目 `.md` 条数上限（不含 MEMORY.md），与 `DEFAULT_FILE_MEMORY_CONFIG.maxMemoryFiles` 常一致 */
  postDreamMemoryCap: 60,
  /**
   * Dream 后条数淘汰：跳过「新建保护期」，仅把低活跃条目归档到 evicted/（非删除）。
   * 语义整合（LLM）与条数压顶（规则）分工：LLM 不负责压到 60 条。
   */
  afterDreamEviction: { protectionDays: 0 },
  staleIndexDeadLinksThreshold: 3,
  enforceUserMemoryCapAfterDream: true,
  /** 用户目录话题文件条数上限（不含 MEMORY.md） */
  userMemoryPostDreamCap: 20,
  afterUserDreamEviction: { protectionDays: 0 },
  indexOrphanRatioThreshold: 0.5,
  indexOrphanMinCount: 10,
  indexBackoffBaseMs: 60_000,
  indexBackoffMaxMs: 30 * 60 * 1000,
  llmRequestTimeoutMs: DEFAULT_DREAM_LLM_TIMEOUT_MS,
};

/** 遥测 JSONL 默认路径与体积上限 */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  logPath: getRuntimeMemoryAuxPath('telemetry.jsonl'),
  enableFileLog: true,
  enableConsoleLog: false,
  maxLogSize: 5 * 1024 * 1024, // 5MB
};

export const DEFAULT_EVICTION_CONFIG: EvictionConfig = {
  enabled: true,
  softLimit: 60,
  evictionTarget: 60,
  evictedDir: resolveProjectMemoryEvictedDir(),
  maxEvictedFiles: 100,
  protectionDays: 3,
};

/** 召回相关度门控 + rescue 默认阈值 */
export const DEFAULT_RELEVANCE_GATE_CONFIG: RelevanceGateConfig = {
  enabled: true,
  contextWindow: 3,
  minKeywordOverlap: 1,
  rescueThreshold: 0.5,
  rescueCacheSize: 20,
  rescueShortPreviewThreshold: 500,
};

/** 会话笔记更新默认：偏长对话才维护，避免短聊写盘 */
export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  enabled: true,
  minTokensToInit: 10000,
  minTokensBetweenUpdate: 6000,
  toolCallsBetweenUpdates: 4,
};

/** 注入主上下文时条数、预算比例与话题切换权重 */
export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  maxResults: 15,
  dedupInSession: true,
  budgetTokenRatio: 0.05,
  maxMemoryBudget: 3000,
  minBudgetResults: 3,
  topicSwitchWeight: { convention: 1.5, preference: 0.7, fact: 1.0 },
};

/** 提取触发：轮次 / token / 工具节奏默认门槛 */
export const DEFAULT_EXTRACTION_REMOTE_CONFIG: ExtractionRemoteConfig = {
  minTurns: 3,
  minTokens: 5000,
  toolCallInterval: 3,
  turnThrottle: 1,
};

/** casual intent 提取：更严轮次 + 深度路径需工具（可在 memory-config.json 调） */
export const DEFAULT_CASUAL_EXTRACTION_CONFIG: CasualExtractionConfig = {
  minTurns: 5,
  requireToolCalls: true,
  allowContentSignalWithoutTools: false,
};

/** Dream 远程：最短间隔 6h、最少 3 次会话累计后才与时间门控联动 */
export const DEFAULT_DREAM_REMOTE_CONFIG: DreamRemoteConfig = {
  minHours: 6,
  minSessions: 3,
  enabled: true,
};

/** 用户口头肯定/否定反馈检测默认词表与窗口 */
export const DEFAULT_FEEDBACK_CONFIG: FeedbackConfig = {
  enabled: true,
  negativeKeywords: ['不对', '不是', '错了', '不用', '别', 'wrong', 'incorrect', 'nope', 'stop'],
  positiveKeywords: ['对', '是的', '很好', '就是这样', 'yes', 'correct', 'right', 'good'],
  maxTurnsToFeedback: 3,
};

/** 合并 `DEFAULT_*_REMOTE_CONFIG` 的初始快照，供 `memory-remote-config` 未加载时回退 */
export const DEFAULT_DYNAMIC_CONFIG: MemoryDynamicConfig = {
  extraction: { ...DEFAULT_EXTRACTION_REMOTE_CONFIG },
  casualExtraction: { ...DEFAULT_CASUAL_EXTRACTION_CONFIG },
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

/** LLM 提取落盘最低置信度（缺失或低于此值的条目直接丢弃） */
export const MIN_EXTRACTION_CONFIDENCE = 0.6;

/** 推断类 user 偏好写盘最低置信度（非 feedback） */
export const INFERRED_PREFERENCE_MIN_CONFIDENCE = 0.75;

/** 每会话最多成功 Extract 次数（含信号词路径） */
export const SESSION_MAX_SUCCESSFUL_EXTRACTS = 1;

/** 每会话 Extract 写盘条数上限 */
export const SESSION_MAX_EXTRACT_WRITES = 1;

/** 单次 Extract 最多处理的消息分块数 */
export const EXTRACTION_MAX_CHUNKS_PER_RUN = 1;

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
