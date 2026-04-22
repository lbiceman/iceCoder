/**
 * 工具元数据 — 描述工具的行为特征。
 *
 * 参考 Claude Code 的 Tool 接口中的元数据字段：
 * - isConcurrencySafe: 是否可以并行执行
 * - isReadOnly: 是否为只读操作
 * - isDestructive: 是否为破坏性操作
 * - searchHint: 工具搜索关键词
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
  /** 工具搜索关键词（3-10 个词，帮助模型通过关键词找到工具） */
  searchHint?: string;
  /** 最大结果大小（字符数），超过此大小会被截断 */
  maxResultSizeChars: number;
  /** 工具分类标签 */
  tags: ToolTag[];
}

/**
 * 工具分类标签。
 * 参考 Claude Code 的工具分类方式。
 */
export type ToolTag =
  | 'file_read'      // 文件读取
  | 'file_write'     // 文件写入
  | 'file_delete'    // 文件删除
  | 'search'         // 搜索
  | 'shell'          // Shell 命令
  | 'network'        // 网络请求
  | 'parse'          // 文档解析
  | 'directory';     // 目录操作

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
    searchHint: '读取文件内容 查看源码',
    maxResultSizeChars: Infinity, // 读取工具不截断，由自身限制
    tags: ['file_read'],
  },
  write_file: {
    name: 'write_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: true,
    searchHint: '写入文件 创建文件 保存内容',
    maxResultSizeChars: 1000,
    tags: ['file_write'],
  },
  append_file: {
    name: 'append_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    searchHint: '追加内容 添加到文件末尾',
    maxResultSizeChars: 1000,
    tags: ['file_write'],
  },
  edit_file: {
    name: 'edit_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false,
    searchHint: '编辑文件 查找替换 修改代码',
    maxResultSizeChars: 2000,
    tags: ['file_write'],
  },
  delete_file: {
    name: 'delete_file',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: true,
    searchHint: '删除文件 移除文件',
    maxResultSizeChars: 500,
    tags: ['file_delete'],
  },
  list_directory: {
    name: 'list_directory',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '列出目录 查看文件列表 浏览文件夹',
    maxResultSizeChars: 30000,
    tags: ['directory', 'file_read'],
  },
  file_info: {
    name: 'file_info',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '文件信息 文件大小 修改时间',
    maxResultSizeChars: 2000,
    tags: ['file_read'],
  },

  // ── 搜索 ──
  search_in_files: {
    name: 'search_in_files',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '搜索文件内容 grep 查找文本',
    maxResultSizeChars: 30000,
    tags: ['search'],
  },
  find_files: {
    name: 'find_files',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '查找文件 按名称搜索 glob',
    maxResultSizeChars: 30000,
    tags: ['search'],
  },

  // ── 文档解析 ──
  parse_document: {
    name: 'parse_document',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '解析文档 提取文本 HTML DOCX PPTX',
    maxResultSizeChars: 50000,
    tags: ['parse'],
  },
  parse_doc: {
    name: 'parse_doc',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '解析 Word 文档 DOCX',
    maxResultSizeChars: 50000,
    tags: ['parse'],
  },
  parse_ppt: {
    name: 'parse_ppt',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '解析 PPT 演示文稿 PPTX',
    maxResultSizeChars: 50000,
    tags: ['parse'],
  },
  parse_xmind: {
    name: 'parse_xmind',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '解析思维导图 XMind',
    maxResultSizeChars: 50000,
    tags: ['parse'],
  },
  parse_html: {
    name: 'parse_html',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '解析 HTML 网页',
    maxResultSizeChars: 50000,
    tags: ['parse'],
  },
  parse_pptx_deep: {
    name: 'parse_pptx_deep',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '深度解析 PPTX 逐页提取',
    maxResultSizeChars: 100000,
    tags: ['parse'],
  },
  parse_xmind_deep: {
    name: 'parse_xmind_deep',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '深度解析 XMind 树形结构',
    maxResultSizeChars: 100000,
    tags: ['parse'],
  },
  parse_doc_deep: {
    name: 'parse_doc_deep',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '深度解析 DOC OLE2 格式',
    maxResultSizeChars: 100000,
    tags: ['parse'],
  },

  // ── 网络 ──
  fetch_url: {
    name: 'fetch_url',
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
    searchHint: '访问 URL 抓取网页 HTTP 请求',
    maxResultSizeChars: 50000,
    tags: ['network'],
  },

  // ── Shell ──
  run_command: {
    name: 'run_command',
    isConcurrencySafe: false,
    isReadOnly: false,
    isDestructive: false, // 取决于具体命令，由权限系统判断
    searchHint: '执行命令 Shell bash 终端',
    maxResultSizeChars: 30000,
    tags: ['shell'],
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
export function isDestructive(toolName: string): boolean {
  return getToolMetadata(toolName).isDestructive;
}
