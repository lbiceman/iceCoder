/**
 * Shell 协作模式专用工具工厂与白名单。
 *
 * Shell 专用工具与基础文件 CRUD 工具仅通过 createShellCollabTools 注入 Shell active session；
 * Shell 专用工具**不**注册进全局 initializeToolSystem()。
 *
 * @see docs/requirement/shell-交互协管-slash-shell.md §5.6.1
 */

import type { RegisteredTool } from './types.js';
import { createFileTools } from './builtin/file-tools.js';
import { createInteractiveShellTool } from './builtin/interactive-shell-tool.js';
import { createShellExecTool } from './builtin/shell-exec-tool.js';
import { createShellWaitTool } from './builtin/shell-wait-tool.js';
import { createShellSendKeysTool } from './builtin/shell-send-keys-tool.js';

/** 仅 Shell 协作模式提供的 PTY 工具（不进全局 Registry） */
export const SHELL_ONLY_TOOL_NAMES = [
  'interactive_shell',
  'shell_exec',
  'shell_wait',
  'shell_send_keys',
] as const;

/** Shell 模式允许的基础文件增删改查工具 */
export const SHELL_FILE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'fs_operation',
] as const;

const SHELL_FILE_TOOL_NAME_SET = new Set<string>(SHELL_FILE_TOOL_NAMES);

/** Shell 模式唯一允许的工具名（硬约束 R9） */
export const SHELL_COLLAB_TOOL_NAMES = [
  ...SHELL_ONLY_TOOL_NAMES,
  ...SHELL_FILE_TOOL_NAMES,
] as const;

export type ShellCollabToolName = (typeof SHELL_COLLAB_TOOL_NAMES)[number];

/** Shell 模式注入的基础文件增删改查工具 */
export function isShellCollabFileTool(toolName: string): boolean {
  return SHELL_FILE_TOOL_NAME_SET.has(toolName);
}

export interface ShellCollabToolsOptions {
  sessionId: string;
  cwd: string;
}

function pickShellFileTools(workDir: string, sessionId: string): RegisteredTool[] {
  return createFileTools(workDir, sessionId).filter(
    (tool) => SHELL_FILE_TOOL_NAME_SET.has(tool.definition.name),
  );
}

/**
 * 创建绑定 session 的 Shell 协作工具实例（PTY 工具 + 文件增删改查）。
 */
export function createShellCollabTools(options: ShellCollabToolsOptions): RegisteredTool[] {
  const { sessionId, cwd } = options;
  return [
    createInteractiveShellTool(cwd, sessionId),
    createShellExecTool(cwd, sessionId),
    createShellWaitTool(cwd, sessionId),
    createShellSendKeysTool(cwd, sessionId),
    ...pickShellFileTools(cwd, sessionId),
  ];
}

/** 工具 definitions 名称列表（排序后），用于白名单校验 */
export function sortedShellCollabDefinitionNames(tools: RegisteredTool[]): string[] {
  return tools.map((t) => t.definition.name).sort();
}

/** definitions 排序后是否严格等于 SHELL_COLLAB_TOOL_NAMES */
export function shellCollabDefinitionsMatchWhitelist(tools: RegisteredTool[]): boolean {
  const names = sortedShellCollabDefinitionNames(tools);
  const expected = [...SHELL_COLLAB_TOOL_NAMES].sort();
  return names.length === expected.length && names.every((n, i) => n === expected[i]);
}
