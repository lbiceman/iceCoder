import type { TaskIntent, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import { INTENT_TOOL_SUGGESTIONS } from './tool-plan-intent-map.js';
import { snapshotHasUnconfirmedFileDeliverables } from './document-deliverable.js';
import { inferIntent } from './task-state.js';

export interface ToolPlan {
  intent: TaskIntent;
  recommendedFlow: string[];
  verificationHint?: string;
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
  const verificationHint = snapshot && snapshotHasUnconfirmedFileDeliverables(snapshot, workspaceRoot)
    ? 'Confirm each existing changed file with file_info or read_file before final response.'
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
      return ['read the error/output', 'search and read related files', 'edit the smallest relevant code path', 'run a focused test or typecheck when useful'];
    case 'edit':
      return ['inspect related files', 'make the edit with file tools', 'run tests or checks when practical (optional before finishing)'];
    case 'test':
      return ['run the failing test or check', 'inspect the failure and related files', 'edit the implementation or test', 'rerun the focused test'];
    case 'refactor':
      return ['inspect references/usages', 'apply batch or patch edits', 'run tests/typecheck when practical'];
    case 'inspect':
      return ['search or read relevant files only', 'answer from evidence'];
    case 'docs':
      return ['inspect existing docs/source', 'edit documentation', 'confirm deliverables with file_info or read_file when applicable'];
    default:
      return ['inspect if needed', 'answer directly if no code action is needed'];
  }
}
