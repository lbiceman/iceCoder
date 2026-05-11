/**
 * 工具元数据 — 描述工具的行为特征。
 *
 * 元数据字段：
 * - isConcurrencySafe: 是否可以并行执行
 * - isReadOnly: 是否为只读操作
 * - isDestructive: 是否为破坏性操作
 * - maxResultSizeChars: 最大结果大小
 *
 * 这些元数据帮助 Harness 做出更智能的决策：
 * - 并行安全的工具可以同时执行
 * - 只读工具不需要权限确认
 * - 破坏性工具需要额外确认
 */

/**
 * 工具元数据。
 */
export interface ToolMetadata {
  /** 工具名称 */
  name: string;
  /** 是否可以并行执行（默认 false，保守策略） */
  isConcurrencySafe: boolean;
  /** 是否为只读操作（默认 false） */
  isReadOnly: boolean;
  /** 是否为破坏性操作（如删除文件、覆盖内容） */
  isDestructive: boolean;
  /** 最大结果大小（字符数），超过此大小会被截断 */
  maxResultSizeChars: number;
  /** 工具分类标签 */
  tags: ToolTag[];
}

/**
 * 工具分类标签。
 */
export type ToolTag =
  | 'file_read'      // 文件读取
  | 'file_write'     // 文件写入
  | 'file_delete'    // 文件删除
  | 'search'         // 搜索
  | 'shell'          // Shell 命令
  | 'network'        // 网络请求
  | 'parse'          // 文档解析
  | 'directory'      // 目录操作
  | 'background';    // 后台任务

/**
 * 默认工具元数据映射。
 * 为每个内置工具定义行为特征。
 */
export const DEFAULT_TOOL_METADATA: Record<string, ToolMetadata> = {
  // ── 文件操作 ──
  read_file: {
    name: 'read_file',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 22_000,
    tags: ['file_read'],
  },
  write_file: {
    name: 'write_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    maxResultSizeChars: 1000,
    tags: ['file_write'],
  },
  append_file: {
    name: 'append_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    maxResultSizeChars: 1000,
    tags: ['file_write'],
  },
  edit_file: {
    name: 'edit_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    maxResultSizeChars: 2000,
    tags: ['file_write'],
  },
  fs_operation: {
    name: 'fs_operation',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,   // 运行时根据 operation 参数判断，见 isDestructiveOperation()
    maxResultSizeChars: 24_000,
    tags: ['directory', 'file_write', 'file_delete'],
  },
  file_info: {
    name: 'file_info',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 2000,
    tags: ['file_read'],
  },

  // ── 搜索 ──
  search_codebase: {
    name: 'search_codebase',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 32_000,
    tags: ['search', 'file_read'],
  },

  // ── 文档解析 ──
  parse_document: {
    name: 'parse_document',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 32_000,
    tags: ['parse'],
  },
  parse_pptx_deep: {
    name: 'parse_pptx_deep',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 100000,
    tags: ['parse'],
  },
  parse_xmind_deep: {
    name: 'parse_xmind_deep',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 100000,
    tags: ['parse'],
  },
  parse_doc_legacy: {
    name: 'parse_doc_legacy',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 100000,
    tags: ['parse'],
  },

  // ── 网络 ──
  fetch_url: {
    name: 'fetch_url',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 50000,
    tags: ['network'],
  },

  // ── Shell ──
  run_command: {
    name: 'run_command',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false, // 取决于具体命令，由权限系统判断
    maxResultSizeChars: 30000,
    tags: ['shell'],
  },

  // ── 差异对比 ──
  diff_files: {
    name: 'diff_files',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 50000,
    tags: ['file_read'],
  },

  // ── 批量编辑 ──
  batch_edit_file: {
    name: 'batch_edit_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    maxResultSizeChars: 5000,
    tags: ['file_write'],
  },

  // ── 网页搜索 ──
  web_search: {
    name: 'web_search',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 30000,
    tags: ['network'],
  },

  // ── Git ──
  git: {
    name: 'git',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    maxResultSizeChars: 50000,
    tags: ['shell'],
  },

  // ── Patch ──
  patch_file: {
    name: 'patch_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    maxResultSizeChars: 5000,
    tags: ['file_write'],
  },

  // ── 系统文件浏览器 ──
  list_drives: {
    name: 'list_drives',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 5000,
    tags: ['directory'],
  },
  browse_directory: {
    name: 'browse_directory',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 30000,
    tags: ['directory', 'file_read'],
  },
  open_file: {
    name: 'open_file',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 50000,
    tags: ['file_read'],
  },
  image_read: {
    name: 'image_read',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 30000,
    tags: ['file_read', 'parse'],
  },
  notebook_read: {
    name: 'notebook_read',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 50000,
    tags: ['file_read', 'parse'],
  },
  env_info: {
    name: 'env_info',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    maxResultSizeChars: 10000,
    tags: ['shell'],
  },
  undo_edit: {
    name: 'undo_edit',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: true,
    maxResultSizeChars: 10000,
    tags: ['file_write'],
  },
};

/**
 * 获取工具的元数据。
 * 如果没有预定义的元数据，返回保守的默认值。
 */
export function getToolMetadata(toolName: string): ToolMetadata {
  return DEFAULT_TOOL_METADATA[toolName] ?? {
    name: toolName,
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    maxResultSizeChars: 30000,
    tags: [],
  };
}

/**
 * 检查工具是否可以并行执行。
 */
export function isConcurrencySafe(toolName: string): boolean {
  return getToolMetadata(toolName).isConcurrencySafe;
}

/**
 * 检查工具是否为只读操作。
 */
export function isReadOnly(toolName: string): boolean {
  return getToolMetadata(toolName).isReadOnly;
}

/**
 * 检查工具是否为破坏性操作。
 */
/** fs_operation 中破坏性的 operation 值 */
const DESTRUCTIVE_FS_OPERATIONS = new Set(['delete', 'move']);

/**
 * 判断 fs_operation 的具体 operation 是否为破坏性操作。
 */
export function isDestructiveOperation(operation: string): boolean {
  return DESTRUCTIVE_FS_OPERATIONS.has(operation);
}

/** 破坏性 shell 命令模式 */
const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
  /\brm\b/, /\brmdir\b/, /\bdel\b/, /\berase\b/,
  /\bgit\s+push\s+.*(-f|--force)/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\b/,
  /\bdd\b/, /\bmkfs\b/, /\bformat\b/,
  /\bdropdb\b/, /\bDROP\s+(TABLE|DATABASE)\b/i,
  /:\s*>/, /\b(shutdown|reboot|halt)\b/,
];

/**
 * 判断 shell 命令是否为破坏性命令。
 */
export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_PATTERNS.some((p) => p.test(command));
}

/**
 * 检查工具是否为破坏性操作。
 */
export function isDestructive(toolName: string): boolean {
  return getToolMetadata(toolName).isDestructive;
}
