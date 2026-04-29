/**
 * 基于文件的持久化记忆系统入口。
 *
 * 提供：
 * - 基于文件的持久化记忆（MEMORY.md 索引 + 主题文件）
 * - 四种记忆类型分类（user/feedback/project/reference）
 * - 记忆提示词注入（告诉模型如何读写记忆）
 * - 记忆新鲜度追踪（防止模型引用过时信息）
 * - 记忆目录扫描（用于智能召回）
 */

export {
  loadMemoryPrompt,
  buildMemoryInstructions,
  truncateEntrypointContent,
  ensureMemoryDirExists,
} from './memory-prompt.js';

export {
  scanMemoryFiles,
  formatMemoryManifest,
  parseFrontmatter,
  parseMemoryType,
} from './memory-scanner.js';

export {
  memoryAge,
  memoryAgeDays,
  memoryFreshnessText,
  memoryFreshnessNote,
} from './memory-age.js';

export type {
  FileMemoryType,
  FileMemoryConfig,
  MemoryHeader,
  MemoryFrontmatter,
  RelevantMemory,
  EntrypointTruncation,
} from './types.js';

export { FILE_MEMORY_TYPES } from './types.js';

// ─── 新增：集成模块 ───

export { FileMemoryManager, createFileMemoryManager } from './file-memory-manager.js';
export type { FileMemoryManagerConfig } from './file-memory-manager.js';

export { MultiLevelMemoryLoader, MemoryLevel, createMultiLevelMemoryLoader } from './multi-level-memory.js';
export type { MultiLevelMemoryConfig } from './multi-level-memory.js';

export { AsyncMemoryPrefetcher, RelevanceAnalyzer, createAsyncPrefetcher } from './async-prefetch.js';
export type { PrefetchConfig, PrefetchResult } from './async-prefetch.js';

// ─── LLM 驱动模块 ───

export { recallRelevantMemories } from './memory-recall.js';
export type { RecallResult } from './memory-recall.js';

export { LLMMemoryExtractor, createLLMMemoryExtractor } from './memory-llm-extractor.js';
export type { LLMExtractionConfig, ExtractionResult } from './memory-llm-extractor.js';

export { MemoryDream, createMemoryDream } from './memory-dream.js';
export type { DreamConfig, DreamResult } from './memory-dream.js';

// ─── 安全模块 ───

export {
  validatePath,
  validatePathWithSymlink,
  isWithinMemoryDir,
  sanitizePathKey,
  PathTraversalError,
} from './memory-security.js';

export {
  scanForSecrets,
  redactSecrets,
  containsSecrets,
  getSecretLabel,
} from './memory-secret-scanner.js';
export type { SecretMatch } from './memory-secret-scanner.js';

// ─── 配置模块 ───

export * from './memory-config.js';

// ─── Fact 索引模块 ───

export { FactIndex, getFactIndex, resetFactIndex } from './memory-fact-index.js';
export type { FactEntry } from './memory-fact-index.js';

// ─── 工具模块 ───

export { parseLLMJson, parseLLMJsonObject, parseLLMJsonArray } from './json-parser.js';

// ─── 遥测模块 ───

export { MemoryTelemetry, getMemoryTelemetry, resetMemoryTelemetry } from './memory-telemetry.js';
export type {
  TelemetryConfig,
  TelemetryEvent,
  TelemetryEventType,
  RecallTelemetry,
  ExtractTelemetry,
  DreamTelemetry,
  StatsTelemetry,
} from './memory-telemetry.js';

// ─── 并发控制与锁机制 ───

export {
  sequential,
  ConsolidationLock,
  initExtractionGuard,
  drainExtractions,
} from './memory-concurrency.js';
export type { ExtractionGuardState } from './memory-concurrency.js';

// ─── 远程/动态配置 ───

export {
  getDynamicConfig,
  refreshConfig,
  saveConfig,
  getExtractionConfig,
  getDreamConfig,
  getRecallConfig,
  getSessionMemoryConfig,
  resetDynamicConfig,
} from './memory-remote-config.js';
export type { MemoryDynamicConfig } from './memory-remote-config.js';

// ─── 会话记忆 ───

export {
  initSessionMemoryState,
  shouldUpdateSessionMemory,
  setupSessionMemoryFile,
  buildSessionMemoryUpdatePrompt,
  truncateSessionMemoryForCompact,
  isSessionMemoryEmpty,
  getSessionMemoryContent,
  validateSessionMemoryContent,
  SESSION_MEMORY_TEMPLATE,
} from './session-memory.js';
export type { SessionMemoryState } from './session-memory.js';
