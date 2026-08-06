/**
 * Shell 协作模式专用工具工厂与白名单。
 *
 * 4 个工具仅通过 createShellCollabTools 注入 Shell active session，
 * **不**注册进全局 initializeToolSystem()。
 *
 * @see docs/requirement/shell-交互协管-slash-shell.md §5.6.1
 */

import type { RegisteredTool } from './types.js';
import { createInteractiveShellTool } from './builtin/interactive-shell-tool.js';
import { createShellExecTool } from './builtin/shell-exec-tool.js';
import { createShellWaitTool } from './builtin/shell-wait-tool.js';
import { createShellSendKeysTool } from './builtin/shell-send-keys-tool.js';

/** Shell 模式唯一允许的工具名（硬约束 R9） */
export const SHELL_COLLAB_TOOL_NAMES = [
  'interactive_shell',
  'shell_exec',
  'shell_wait',
  'shell_send_keys',
] as const;

export type ShellCollabToolName = (typeof SHELL_COLLAB_TOOL_NAMES)[number];

export interface ShellCollabToolsOptions {
  sessionId: string;
  cwd: string;
}

/**
 * 创建绑定 session 的 4 个 Shell 协作工具实例。
 */
export function createShellCollabTools(options: ShellCollabToolsOptions): RegisteredTool[] {
  const { sessionId, cwd } = options;
  return [
    createInteractiveShellTool(cwd, sessionId),
    createShellExecTool(cwd, sessionId),
    createShellWaitTool(cwd, sessionId),
    createShellSendKeysTool(cwd, sessionId),
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
