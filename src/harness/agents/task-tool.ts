/**
 * `task` 工具：主 Agent 派出子 Agent 的唯一入口。
 * 工具结果是子 Agent 的最终报告，由 AgentSpawner 同步返回。
 */

import type { ToolDefinition } from '../../llm/types.js';
import { BUILTIN_AGENT_TYPES, findAgentType, type AgentTypeDefinition } from './agent-types.js';

export const TASK_TOOL_NAME = 'task';

export interface TaskToolInput {
  description: string;
  prompt: string;
  subagentType: AgentTypeDefinition;
}

/** TaskGraph / ToolGate 不按节点约束、不计重复次数的工具。 */
export function isNeutralAgentTool(toolName: string): boolean {
  return toolName === TASK_TOOL_NAME;
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
      'Several task calls in the same reply run in parallel. The call blocks until the sub-agent finishes.',
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
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
  };
}

export function ensureTaskTool(
  tools: ToolDefinition[],
  types: readonly AgentTypeDefinition[] = BUILTIN_AGENT_TYPES,
): ToolDefinition[] {
  if (tools.length === 0) return tools;
  if (tools.some(t => t.name === TASK_TOOL_NAME)) return tools;
  return [...tools, createTaskToolDefinition(types)];
}

export function stripTaskTool(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.some(t => t.name === TASK_TOOL_NAME)
    ? tools.filter(t => t.name !== TASK_TOOL_NAME)
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
  return {
    ok: true,
    input: {
      description: (description || prompt.split('\n')[0] || subagentType.name).slice(0, 60),
      prompt,
      subagentType,
    },
  };
}
