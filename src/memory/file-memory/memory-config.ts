/**
 * 记忆系统统一配置。
 *
 * 所有记忆模块的默认值集中在此文件管理，
 * 避免路径和阈值散落在各模块中导致不一致。
 */

import type { FileMemoryConfig } from './types.js';
import type { DreamConfig } from './memory-dream.js';
import type { PrefetchConfig } from './async-prefetch.js';
import type { LLMExtractionConfig } from './memory-llm-extractor.js';
import type { TelemetryConfig } from './memory-telemetry.js';
import type { MultiLevelMemoryConfig } from './multi-level-memory.js';

// ─── 基础记忆目录 ───

/** 默认记忆文件存储目录 */
export const DEFAULT_MEMORY_DIR = './data/memory-files';

/** 默认用户级记忆目录 */
export const DEFAULT_USER_MEMORY_DIR = './data/user-memory';

/** 默认索引文件名 */
export const DEFAULT_ENTRYPOINT_NAME = 'MEMORY.md';

// ─── 文件记忆配置 ───

export const DEFAULT_FILE_MEMORY_CONFIG: FileMemoryConfig = {
  memoryDir: DEFAULT_MEMORY_DIR,
  entrypointName: DEFAULT_ENTRYPOINT_NAME,
  maxEntrypointLines: 200,
  maxEntrypointBytes: 25000,
  maxMemoryFiles: 150,
};

// ─── 多级加载配置 ───

export const DEFAULT_MULTI_LEVEL_CONFIG: MultiLevelMemoryConfig = {
  ...DEFAULT_FILE_MEMORY_CONFIG,
  projectRoot: '.',
  userMemoryDir: process.env.ICE_USER_MEMORY_DIR ?? './data/user-memory',
  currentDir: '.',
};

// ─── 异步预取配置 ───

export const DEFAULT_PREFETCH_CONFIG: PrefetchConfig = {
  timeout: 5000,
  maxPrefetch: 20,
  enableRelevance: true,
  relevanceThreshold: 0.3,
};

// ─── LLM 提取配置 ───

export const DEFAULT_LLM_EXTRACTION_CONFIG: LLMExtractionConfig = {
  maxMemories: 15,
  maxOutputTokens: 4096,
  enablePromptCache: true,
};

// ─── Dream 整合配置 ───

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

// ─── 遥测配置 ───

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  logPath: 'data/memory/telemetry.jsonl',
  enableFileLog: true,
  enableConsoleLog: false,
  maxLogSize: 5 * 1024 * 1024, // 5MB
};

// ─── Harness 记忆集成配置 ───

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
