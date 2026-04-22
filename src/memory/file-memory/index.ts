/**
 * 基于文件的持久化记忆系统入口。
 *
 * 参考 Claude Code 的 memdir 模块，提供：
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
