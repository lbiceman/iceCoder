/**
 * 基于文件的持久化记忆系统 — 类型定义。
 *
 * 记忆存储在文件系统中，以 MEMORY.md 为索引入口，
 * 每条记忆是一个独立的 Markdown 文件，带 frontmatter 元数据。
 *
 * 四种记忆类型：
 * - user: 用户画像（角色、目标、偏好）
 * - feedback: 行为反馈（用户纠正或确认的工作方式）
 * - project: 项目上下文（进行中的工作、目标、截止日期）
 * - reference: 外部引用（外部系统中信息的指针）
 */

/**
 * 记忆类型。
 * 约束为四种类型，捕获无法从当前项目状态推导出的上下文。
 */
export const FILE_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type FileMemoryType = typeof FILE_MEMORY_TYPES[number];

/**
 * 记忆文件的 frontmatter 元数据。
 */
export interface MemoryFrontmatter {
  /** 记忆名称 */
  name: string;
  /** 一行描述 — 用于在未来对话中判断相关性 */
  description: string;
  /** 记忆类型 */
  type: FileMemoryType;
  /** 来源：哪次对话/操作创建的 */
  source?: 'llm_extract' | 'dream' | 'manual' | 'user_explicit';
  /** 置信度：0-1，用户明确声明=1，LLM推断=0.5，dream整合=0.7 */
  confidence?: number;
  /** 被召回次数（每次被选中时递增） */
  recallCount?: number;
  /** 上次被召回的时间（ISO 字符串） */
  lastRecalledAt?: string;
  /** 创建时间（ISO 字符串） */
  createdAt?: string;
  /** 语义标签（用于结构化去重，如 "lang:typescript", "tool:vite"） */
  tags?: string[];
  /** 关联的其他记忆文件名（用于多跳关联召回） */
  relatedTo?: string[];
}

/**
 * 记忆文件头信息（扫描结果）。
 */
export interface MemoryHeader {
  /** 相对于记忆目录的文件名 */
  filename: string;
  /** 绝对文件路径 */
  filePath: string;
  /** 文件修改时间（毫秒时间戳） */
  mtimeMs: number;
  /** frontmatter 中的描述 */
  description: string | null;
  /** frontmatter 中的类型 */
  type: FileMemoryType | undefined;
  /** 置信度 */
  confidence: number;
  /** 被召回次数 */
  recallCount: number;
  /** 上次被召回的时间（毫秒时间戳，0 表示从未被召回） */
  lastRecalledMs: number;
  /** 创建时间（毫秒时间戳） */
  createdMs: number;
  /** 语义标签 */
  tags: string[];
  /** 来源 */
  source: string | undefined;
  /** 正文前 300 字符预览（用于召回时的内容匹配） */
  contentPreview: string;
  /** 关联的其他记忆文件名 */
  relatedTo: string[];
}

/**
 * 相关记忆（召回结果）。
 */
export interface RelevantMemory {
  /** 绝对文件路径 */
  path: string;
  /** 文件修改时间 */
  mtimeMs: number;
}

/**
 * 记忆目录配置。
 */
export interface FileMemoryConfig {
  /** 记忆存储根目录 */
  memoryDir: string;
  /** 索引文件名（默认 MEMORY.md） */
  entrypointName: string;
  /** 索引文件最大行数 */
  maxEntrypointLines: number;
  /** 索引文件最大字节数 */
  maxEntrypointBytes: number;
  /** 最大记忆文件数 */
  maxMemoryFiles: number;
}

/**
 * 索引文件截断结果。
 */
export interface EntrypointTruncation {
  /** 截断后的内容 */
  content: string;
  /** 原始行数 */
  lineCount: number;
  /** 原始字节数 */
  byteCount: number;
  /** 是否因行数超限而截断 */
  wasLineTruncated: boolean;
  /** 是否因字节数超限而截断 */
  wasByteTruncated: boolean;
}
