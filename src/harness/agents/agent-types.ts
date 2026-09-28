/**
 * 子 Agent 类型：工具过滤与默认上限。
 *
 * - general：默认模式下主 Agent 的全部工具（去掉禁止项），独立完成一块实现/修复/排查。
 * - explore：只读工具，用于大范围搜索与梳理，不改任何东西。
 */

import type { ToolDefinition } from '../../llm/types.js';

export type BuiltinAgentTypeName = 'general' | 'explore';

export interface AgentTypeDefinition {
  name: string;
  /** 进入 task 工具描述：何时使用该类型 */
  whenToUse: string;
  /** 为 true 时去掉全部写入与命令执行工具 */
  readOnly: boolean;
}

export const GENERAL_AGENT_TYPE: AgentTypeDefinition = {
  name: 'general',
  whenToUse: 'Independently implement, fix, refactor, add tests for, or investigate one well-bounded piece of work. Can read, edit files, run commands and verify its own changes.',
  readOnly: false,
};

export const EXPLORE_AGENT_TYPE: AgentTypeDefinition = {
  name: 'explore',
  whenToUse: 'Read-only exploration: broad searches across many files, tracing call chains, locating where something is implemented. Never modifies anything.',
  readOnly: true,
};

export const BUILTIN_AGENT_TYPES: readonly AgentTypeDefinition[] = [GENERAL_AGENT_TYPE, EXPLORE_AGENT_TYPE];

export function findAgentType(name: string): AgentTypeDefinition | undefined {
  const key = name.trim().toLowerCase();
  return BUILTIN_AGENT_TYPES.find(t => t.name === key);
}

// ─── 工具过滤 ───

/** 任何子 Agent 都不能拿到的工具。request_analysis 是已删除的旧只读分析工具名，避免残留定义被交下去。 */
const EXCLUDED_FOR_ALL_AGENTS = new Set(['task', 'request_analysis']);

/** 记忆写入、向用户提问、会话模式切换类工具（按名称识别，含 MCP 同类工具）。 */
const EXCLUDED_FOR_ALL_PATTERNS: readonly RegExp[] = [
  /^(?:mcp_[a-z0-9-]+_)?(?:memory_|remember)/i,
  /^(?:mcp_[a-z0-9-]+_)?(?:ask_|request_user_input$)/i,
  /^(?:mcp_[a-z0-9-]+_)?(?:enter|exit|switch|toggle)_[a-z_]*mode$/i,
];

const EXPLORE_ALLOWED_TOOLS = new Set([
  'read_file',
  'glob',
  'grep',
  'file_info',
  'fs_operation',
  'parse_document',
  'parse_pptx_deep',
  'parse_xlsx_deep',
  'parse_xmind_deep',
  'parse_doc_legacy',
  'notebook_read',
  'image_read',
  'diff_files',
  'list_drives',
  'browse_directory',
  'open_file',
  'web_search',
  'fetch_url',
  'env_info',
]);

const MCP_READ_VERB_RE = /(?:^|_)(?:get|list|read|search|query|find|fetch|describe|show|view|lookup|inspect|analy[sz]e|snapshot|screenshot|logs?|status)(?:_|$)/i;
const MCP_WRITE_VERB_RE = /(?:^|_)(?:write|create|update|delete|remove|set|put|post|patch|click|type|fill|select|hover|navigate|press|upload|download|move|rename|exec|execute|run|send|install|evaluate|go)(?:_|$)/i;

/** 只读 MCP 工具：名称含读取类动词且不含任何写入/操作类动词。 */
export function isReadOnlyMcpToolName(name: string): boolean {
  if (!name.startsWith('mcp_')) return false;
  return MCP_READ_VERB_RE.test(name) && !MCP_WRITE_VERB_RE.test(name);
}

export function isToolExcludedForAllAgents(name: string): boolean {
  if (EXCLUDED_FOR_ALL_AGENTS.has(name)) return true;
  return EXCLUDED_FOR_ALL_PATTERNS.some(re => re.test(name));
}

export function isToolAllowedForAgentType(type: AgentTypeDefinition, name: string): boolean {
  if (isToolExcludedForAllAgents(name)) return false;
  if (!type.readOnly) return true;
  return EXPLORE_ALLOWED_TOOLS.has(name) || isReadOnlyMcpToolName(name);
}

export function filterToolsForAgentType(
  type: AgentTypeDefinition,
  tools: readonly ToolDefinition[],
): ToolDefinition[] {
  return tools.filter(tool => isToolAllowedForAgentType(type, tool.name));
}
