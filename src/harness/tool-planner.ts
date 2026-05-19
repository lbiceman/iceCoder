import type { TaskIntent, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import { INTENT_TOOL_SUGGESTIONS } from './tool-plan-intent-map.js';
import { inferIntent } from './task-state.js';

export interface ToolPlan {
  intent: TaskIntent;
  recommendedFlow: string[];
  verificationHint?: string;
  /** 与意图绑定的具体工具名，供模型首轮优先选用 */
  suggestedTools: string[];
}

export function buildToolPlan(goal: string, snapshot?: TaskStateSnapshot): ToolPlan {
  const intent = snapshot?.intent ?? inferIntent(goal);
  const flow = recommendedFlow(intent);
  const verificationHint = snapshot?.verificationRequired && snapshot.verificationStatus !== 'passed'
    ? 'Because files changed, finish with a focused verification command before final response.'
    : undefined;
  const suggestedTools = [...(INTENT_TOOL_SUGGESTIONS[intent] ?? INTENT_TOOL_SUGGESTIONS.question)];
  return { intent, recommendedFlow: flow, verificationHint, suggestedTools };
}

export function formatToolPlan(plan: ToolPlan): string {
  const lines = [
    '[Runtime Tool Planner]',
    `Intent: ${plan.intent}`,
    `Suggested tools (call these first when relevant): ${plan.suggestedTools.join(', ')}`,
    'Recommended flow:',
    ...plan.recommendedFlow.map((step, index) => `${index + 1}. ${step}`),
  ];
  if (plan.verificationHint) lines.push(`Verification: ${plan.verificationHint}`);
  return lines.join('\n');
}

function recommendedFlow(intent: TaskIntent): string[] {
  switch (intent) {
    case 'debug':
      return ['read the error/output', 'search and read related files', 'edit the smallest relevant code path', 'run a focused test or typecheck'];
    case 'edit':
      return ['inspect related files', 'make the edit with file tools', 'run an appropriate verification command'];
    case 'test':
      return ['run the failing test or check', 'inspect the failure and related files', 'edit the implementation or test', 'rerun the focused test'];
    case 'refactor':
      return ['inspect references/usages', 'apply batch or patch edits', 'run tests/typecheck'];
    case 'inspect':
      return ['search or read relevant files only', 'answer from evidence'];
    case 'docs':
      return ['inspect existing docs/source', 'edit documentation', 'run docs/typecheck if available'];
    default:
      return ['inspect if needed', 'answer directly if no code action is needed'];
  }
}
