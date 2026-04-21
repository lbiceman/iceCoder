/**
 * 工具系统入口。
 * 创建并注册所有内置工具，返回配置好的 ToolRegistry 和 ToolExecutor。
 */

import { ToolRegistry } from './tool-registry.js';
import { ToolExecutor } from './tool-executor.js';
import { createFileTools } from './builtin/file-tools.js';
import { createUrlFetchTool } from './builtin/url-fetch-tool.js';
import { createDocParseTools } from './builtin/doc-parse-tool.js';
import { createSearchTools } from './builtin/search-tools.js';
import { createShellTool } from './builtin/shell-tool.js';
import { createPptxParseTool } from './builtin/pptx-parse-tool.js';
import { createXmindParseTool } from './builtin/xmind-parse-tool.js';
import { createDocExtractTool } from './builtin/doc-extract-tool.js';
import type { FileParser } from '../parser/file-parser.js';
import type { ToolExecutorConfig } from './types.js';

export type { ToolExecutorConfig } from './types.js';

/**
 * 工具系统初始化选项。
 */
export interface ToolSystemOptions {
  /** 工作目录（文件操作和命令执行的根目录） */
  workDir: string;
  /** 文件解析器实例 */
  fileParser: FileParser;
  /** 工具执行器配置 */
  executorConfig?: Partial<ToolExecutorConfig>;
}

/**
 * 工具系统初始化结果。
 */
export interface ToolSystem {
  registry: ToolRegistry;
  executor: ToolExecutor;
}

/**
 * 初始化完整的工具系统。
 * 注册所有内置工具并返回 registry 和 executor。
 */
export function initializeToolSystem(options: ToolSystemOptions): ToolSystem {
  const { workDir, fileParser, executorConfig } = options;

  const registry = new ToolRegistry();

  // 注册文件操作工具
  for (const tool of createFileTools(workDir)) {
    registry.register(tool);
  }

  // 注册 URL 访问工具
  registry.register(createUrlFetchTool());

  // 注册文档解析工具
  for (const tool of createDocParseTools(fileParser, workDir)) {
    registry.register(tool);
  }

  // 注册搜索工具
  for (const tool of createSearchTools(workDir)) {
    registry.register(tool);
  }

  // 注册 Shell 命令工具
  registry.register(createShellTool(workDir));

  // 注册 PPTX 深度解析工具
  registry.register(createPptxParseTool(workDir));

  // 注册 XMind 深度解析工具
  registry.register(createXmindParseTool(workDir));

  // 注册 DOC 解析工具
  registry.register(createDocExtractTool(workDir));

  const executor = new ToolExecutor(registry, executorConfig);

  console.log(`工具系统已初始化，共注册 ${registry.getAll().length} 个工具`);

  return { registry, executor };
}
