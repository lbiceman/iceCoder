import type { TaskIntent, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import { inferIntent } from './task-state.js';

/** 意图 → 建议下一轮优先使用的工具名。 */
const INTENT_TOOL_SUGGESTIONS: Record<TaskIntent, readonly string[]> = {
  debug: ['read_file', 'run_command', 'grep'],
  edit: ['read_file', 'edit_file', 'run_command'],
  test: ['run_command', 'read_file', 'grep'],
  refactor: ['glob', 'grep', 'read_file', 'edit_file'],
  inspect: ['glob', 'grep', 'read_file', 'file_info'],
  docs: ['read_file', 'glob', 'grep', 'edit_file'],
  question: ['glob', 'grep', 'read_file'],
};

export interface ToolPlan {
  intent: TaskIntent;
  recommendedFlow: string[];
  /** 与意图绑定的具体工具名，供模型首轮优先选用 */
  suggestedTools: string[];
}

export function buildToolPlan(
  goal: string,
  snapshot?: TaskStateSnapshot,
  workspaceRoot?: string,
): ToolPlan {
  const intent = snapshot?.intent ?? inferIntent(goal);
  const flow = recommendedFlow(intent);
  const suggestedTools = [...(INTENT_TOOL_SUGGESTIONS[intent] ?? INTENT_TOOL_SUGGESTIONS.question)];
  return { intent, recommendedFlow: flow, suggestedTools };
}

export function formatToolPlan(plan: ToolPlan): string {
  const lines = [
    '[Runtime Tool Planner]',
    `Intent: ${plan.intent}`,
    `Suggested tools (call these first when relevant): ${plan.suggestedTools.join(', ')}`,
    'Recommended flow:',
    ...plan.recommendedFlow.map((step, index) => `${index + 1}. ${step}`),
  ];
  return lines.join('\n');
}

function recommendedFlow(intent: TaskIntent): string[] {
  void intent;
  return [
    'inspect the relevant current state when needed',
    'perform the requested action with available tools',
    'use one relevant observation when it adds clear confidence',
  ];
}
