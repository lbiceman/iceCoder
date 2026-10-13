/**
 * `task` 工具：主 Agent 派出子 Agent 的唯一入口。
 *
 * - 默认前台：工具结果就是子 Agent 的最终报告（AgentSpawner 同步返回）。
 * - `run_in_background`：立即返回 agentId，主 Agent 继续工作；结果用 `check_agent` 取，
 *   或由主 Agent 下一轮自动注入。
 *
 * `check_agent` 是配套的查询/有界等待工具，只对后台子 Agent 有意义。
 */

import type { ToolDefinition } from '../../llm/types.js';
import { BUILTIN_AGENT_TYPES, findAgentType, type AgentTypeDefinition } from './agent-types.js';

export const TASK_TOOL_NAME = 'task';
export const CHECK_AGENT_TOOL_NAME = 'check_agent';

/** check_agent 等待上限（毫秒） */
export const CHECK_AGENT_MAX_WAIT_MS = 60_000;

export interface TaskToolInput {
  description: string;
  prompt: string;
  subagentType: AgentTypeDefinition;
  runInBackground: boolean;
}

export interface CheckAgentInput {
  agentId?: string;
  waitMs: number;
}

/** TaskGraph / ToolGate 不按节点约束、不计重复次数的工具。 */
export function isNeutralAgentTool(toolName: string): boolean {
  return toolName === TASK_TOOL_NAME || toolName === CHECK_AGENT_TOOL_NAME;
}

export function createTaskToolDefinition(
  types: readonly AgentTypeDefinition[] = BUILTIN_AGENT_TYPES,
): ToolDefinition {
  const typeLines = types.map(t => `- ${t.name}: ${t.whenToUse}`).join('\n');
  return {
    name: TASK_TOOL_NAME,
    description: [
      'Launch a sub-agent that works autonomously on a self-contained task and returns its final report.',
      'The sub-agent starts with an empty context: it cannot see this conversation, so the prompt must contain everything it needs.',
      'Several task calls in the same reply run in parallel. By default the call blocks the main agent until the sub-agent finishes.',
      'Set run_in_background:true to return immediately with an agentId and keep working; fetch the result with check_agent, or it will be injected into your next round automatically.',
      'Changes made by a general sub-agent are written directly to the workspace; review them and run the final verification yourself.',
      '',
      'Available subagent_type values:',
      typeLines,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short title (3-8 words) shown on the agent card, e.g. "Fix payment timeout retry".',
        },
        prompt: {
          type: 'string',
          description: 'Complete, self-contained instructions: goal, scope (which paths may be changed), known facts, acceptance criteria, and what the report must contain.',
        },
        subagent_type: {
          type: 'string',
          enum: types.map(t => t.name),
          description: 'Which kind of sub-agent to launch.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run the sub-agent in the background: return immediately and receive its result later (via check_agent or automatic injection). Default false.',
        },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
  };
}

export function createCheckAgentToolDefinition(): ToolDefinition {
  return {
    name: CHECK_AGENT_TOOL_NAME,
    description: [
      'Check on a sub-agent launched with `task` (mainly run_in_background:true).',
      'Returns its current status and, once it has finished, its final report.',
      'Set waitMs to wait up to that many milliseconds for it to finish (0 = check now, max 60000).',
      'Omit agentId (with waitMs 0) to list every sub-agent started in this session.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'The agentId returned when the background sub-agent was started. Omit to list all agents.',
        },
        waitMs: {
          type: 'number',
          description: 'Maximum milliseconds to wait for a terminal state (default 0, max 60000).',
        },
      },
    },
  };
}

/** 给工具列表补上 `task` 与 `check_agent`（幂等）。 */
export function ensureTaskTool(
  tools: ToolDefinition[],
  types: readonly AgentTypeDefinition[] = BUILTIN_AGENT_TYPES,
): ToolDefinition[] {
  if (tools.length === 0) return tools;
  const next = tools.some(t => t.name === TASK_TOOL_NAME)
    ? tools
    : [...tools, createTaskToolDefinition(types)];
  return next.some(t => t.name === CHECK_AGENT_TOOL_NAME)
    ? next
    : [...next, createCheckAgentToolDefinition()];
}

export function stripTaskTool(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.some(t => t.name === TASK_TOOL_NAME || t.name === CHECK_AGENT_TOOL_NAME)
    ? tools.filter(t => t.name !== TASK_TOOL_NAME && t.name !== CHECK_AGENT_TOOL_NAME)
    : tools;
}

export type ParsedTaskToolInput =
  | { ok: true; input: TaskToolInput }
  | { ok: false; error: string };

export function parseTaskToolInput(args: Record<string, unknown> | undefined): ParsedTaskToolInput {
  const description = typeof args?.description === 'string' ? args.description.trim() : '';
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  const rawType = typeof args?.subagent_type === 'string'
    ? args.subagent_type
    : typeof args?.subagentType === 'string' ? args.subagentType : '';
  if (!prompt) return { ok: false, error: 'task requires a non-empty prompt' };
  const subagentType = findAgentType(rawType || 'general');
  if (!subagentType) {
    return {
      ok: false,
      error: `Unknown subagent_type "${rawType}". Available: ${BUILTIN_AGENT_TYPES.map(t => t.name).join(', ')}`,
    };
  }
  const runInBackground = args?.run_in_background === true || args?.runInBackground === true;
  return {
    ok: true,
    input: {
      description: (description || prompt.split('\n')[0] || subagentType.name).slice(0, 60),
      prompt,
      subagentType,
      runInBackground,
    },
  };
}

export type ParsedCheckAgentInput =
  | { ok: true; input: CheckAgentInput }
  | { ok: false; error: string };

export function parseCheckAgentInput(
  args: Record<string, unknown> | undefined,
): ParsedCheckAgentInput {
  const rawId = typeof args?.agentId === 'string' ? args.agentId.trim() : '';
  const rawWait = typeof args?.waitMs === 'number' ? args.waitMs : Number(args?.waitMs);
  const waitMs = Number.isFinite(rawWait)
    ? Math.max(0, Math.min(CHECK_AGENT_MAX_WAIT_MS, Math.floor(rawWait)))
    : 0;
  return { ok: true, input: { ...(rawId ? { agentId: rawId } : {}), waitMs } };
}
