/**
 * 规划模式工具门禁：只允许阅读仓库与编写文档，禁止改代码/执行命令/MCP。
 */

import path from 'node:path';
import type { ToolDefinition } from '../llm/types.js';

export const PLAN_MODE_ALWAYS_ALLOWED = new Set([
  'read_file',
  'glob',
  'grep',
  'file_info',
  'list_drives',
  'browse_directory',
  'open_file',
  'fetch_url',
  'web_search',
  'parse_document',
  'parse_pptx_deep',
  'parse_xlsx_deep',
  'parse_xmind_deep',
  'parse_doc_legacy',
  'notebook_read',
  'image_read',
  'env_info',
  'diff_files',
]);

export const PLAN_MODE_DOC_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'patch_file',
  'batch_edit_file',
]);

export const PLAN_MODE_DOC_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.asciidoc',
]);

export const PLAN_MODE_BLOCKED_GENERIC_MESSAGE =
  '[Plan Mode] 规划模式禁止修改代码、执行命令或使用 MCP。只能阅读仓库并编写文档（.md / .txt / .rst / .adoc 等）。写完后请关闭规划模式，再让 Agent 按文档实现。';

export type PlanModeToolDecision =
  | { allowed: true }
  | { allowed: false; message: string };

export function isPlanModeOfferedTool(toolName: string): boolean {
  return PLAN_MODE_ALWAYS_ALLOWED.has(toolName) || PLAN_MODE_DOC_WRITE_TOOLS.has(toolName);
}

export function filterPlanModeToolDefinitions(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.filter((def) => isPlanModeOfferedTool(def.name));
}

export function isPlanModeDocumentPath(filePath: string): boolean {
  const ext = path.extname(filePath.trim()).toLowerCase();
  return PLAN_MODE_DOC_EXTENSIONS.has(ext);
}

export function extractPlanModeWritePath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const raw = args.path ?? args.filePath ?? args.file_path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function evaluatePlanModeToolCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
): PlanModeToolDecision {
  if (PLAN_MODE_ALWAYS_ALLOWED.has(toolName)) {
    return { allowed: true };
  }

  if (PLAN_MODE_DOC_WRITE_TOOLS.has(toolName)) {
    const target = extractPlanModeWritePath(args);
    if (!target) {
      return {
        allowed: false,
        message: `${PLAN_MODE_BLOCKED_GENERIC_MESSAGE}\n缺少文档路径。`,
      };
    }
    if (!isPlanModeDocumentPath(target)) {
      return {
        allowed: false,
        message: `[Plan Mode] 规划模式只能写文档文件（.md / .markdown / .mdx / .txt / .rst / .adoc），不能修改 ${target}。请改写文档，或关闭规划模式后再改代码。`,
      };
    }
    return { allowed: true };
  }

  return { allowed: false, message: PLAN_MODE_BLOCKED_GENERIC_MESSAGE };
}
