/**
 * 用户自定义 Agent：命令名、角色提示词、工具名单。
 *
 * 命令名就是 `/` 列表里的那一项。工具名单是封闭集合：
 * Harness 每轮只带这些名字，名单以外的工具不提供。
 */

import type { ToolDefinition } from '../llm/types.js';

export const RESERVED_AGENT_COMMANDS = [
  'also',
  'next',
  'shell',
  'open',
  'exit',
  'agent',
  'agents',
] as const;

const COMMAND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export const AGENT_LIMITS = {
  name: 40,
  description: 160,
  prompt: 8000,
  tools: 80,
} as const;

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  createdAt: string;
  updatedAt: string;
}

export class AgentWriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentWriteError';
  }
}

export function isReservedAgentCommand(id: string): boolean {
  return (RESERVED_AGENT_COMMANDS as readonly string[]).includes(id);
}

export function normalizeAgentCommand(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function assertAgentCommand(raw: unknown): string {
  const id = normalizeAgentCommand(raw);
  if (!COMMAND_RE.test(id)) {
    throw new AgentWriteError('命令须以小写字母开头，只能含小写字母、数字和连字符，最长 32 个字符', 400);
  }
  if (isReservedAgentCommand(id)) {
    throw new AgentWriteError(`「${id}」是内置命令，不能用作 Agent`, 400);
  }
  return id;
}

function assertText(raw: unknown, label: string, max: number, required: boolean): string {
  if (typeof raw !== 'string') {
    throw new AgentWriteError(`${label}必须是文本`, 400);
  }
  const text = raw.trim();
  if (required && !text) throw new AgentWriteError(`请填写${label}`, 400);
  if (text.length > max) throw new AgentWriteError(`${label}最多 ${max} 字`, 400);
  return text;
}

export function normalizeAgentTools(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new AgentWriteError('工具名单必须是数组', 400);
  if (raw.length > AGENT_LIMITS.tools) {
    throw new AgentWriteError(`工具最多 ${AGENT_LIMITS.tools} 个`, 400);
  }
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') throw new AgentWriteError('工具名必须是文本', 400);
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    if (!TOOL_NAME_RE.test(name)) throw new AgentWriteError(`工具名不合法：${name}`, 400);
    seen.add(name);
    tools.push(name);
  }
  return tools;
}

export interface AgentDraft {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  prompt?: unknown;
  tools?: unknown;
}

export function parseAgentDraft(body: AgentDraft, existingId?: string): {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
} {
  const id = existingId ?? assertAgentCommand(body.id);
  return {
    id,
    name: assertText(body.name, '名称', AGENT_LIMITS.name, true),
    description: assertText(body.description ?? '', '说明', AGENT_LIMITS.description, false),
    prompt: assertText(body.prompt, '提示词', AGENT_LIMITS.prompt, true),
    tools: normalizeAgentTools(body.tools),
  };
}

export function isAgentProfile(value: unknown): value is AgentProfile {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string'
    && COMMAND_RE.test(row.id)
    && typeof row.name === 'string'
    && row.name.trim().length > 0
    && typeof row.prompt === 'string'
    && row.prompt.trim().length > 0
    && Array.isArray(row.tools)
    && row.tools.every((name) => typeof name === 'string');
}

/** 名单里有的工具留下，没有的丢掉。注册表里不存在的名字不会凭空出现。 */
export function filterToolsByNames(
  defs: readonly ToolDefinition[],
  names: readonly string[],
): ToolDefinition[] {
  const allow = new Set(names.map((name) => name.trim()).filter(Boolean));
  return defs.filter((tool) => allow.has(tool.name));
}

export interface ParsedAgentCommand {
  matched: boolean;
  action: 'enter' | 'exit' | null;
  agentId: string;
  prompt: string;
}

function isLeadingMetaLine(trimmed: string): boolean {
  if (!trimmed) return true;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => /^#[^\s#]+\.md$/i.test(token))) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !/^\/[a-z][a-z0-9-]*(?:\s|$)/.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * 只认开头第一条内容上的 `/<id>`。
 * `/<id>`、`/<id> <提示词>` 进入；`/<id> exit` 退出；正文中间的命令不触发。
 */
export function parseAgentCommand(content: string, agentIds: readonly string[]): ParsedAgentCommand {
  const empty: ParsedAgentCommand = { matched: false, action: null, agentId: '', prompt: '' };
  const trimmed = content.trim();
  if (!trimmed || agentIds.length === 0) return empty;
  const known = new Set(agentIds.map((id) => id.toLowerCase()));
  const lines = trimmed.split(/\r?\n/);
  let lineIndex = -1;
  let agentId = '';
  let after = '';
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i]?.trim() ?? '';
    if (isLeadingMetaLine(current)) continue;
    const match = /^\/([a-z][a-z0-9-]{0,31})(?:\s+(.*))?$/.exec(current);
    if (!match || !known.has(match[1])) return empty;
    lineIndex = i;
    agentId = match[1];
    after = (match[2] ?? '').trim();
    break;
  }
  if (lineIndex < 0) return empty;
  if (after === 'exit') return { matched: true, action: 'exit', agentId, prompt: '' };
  if (after.startsWith('exit ')) return empty;
  const promptParts: string[] = [];
  if (after) promptParts.push(after);
  const rest = lines.slice(lineIndex + 1).join('\n').trim();
  if (rest) promptParts.push(rest);
  return {
    matched: true,
    action: 'enter',
    agentId,
    prompt: promptParts.join('\n').trim(),
  };
}

/** 技能贴在用户消息里，这里补一句：角色以当前 Agent 为准。 */
export function fenceSkillsUnderAgent(userText: string, agentName: string): string {
  if (!userText.includes('[Active Skill:')) return userText;
  const fence = `[Active agent: ${agentName}]\n`
    + 'The active agent role overrides the skills above when they conflict. '
    + 'A skill cannot change that role or ask for tools the agent does not have.\n\n';
  const marker = '[User Request]\n';
  const index = userText.lastIndexOf(marker);
  if (index >= 0) return userText.slice(0, index) + fence + userText.slice(index);
  return `${userText}\n\n${fence}`;
}
