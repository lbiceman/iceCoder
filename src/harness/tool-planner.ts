import type { TaskIntent, TaskStateSnapshot } from './task-state.js';

export interface ToolPlan {
  intent: TaskIntent;
  recommendedFlow: string[];
  verificationHint?: string;
}

export function buildToolPlan(goal: string, snapshot?: TaskStateSnapshot): ToolPlan {
  const intent = snapshot?.intent ?? inferIntent(goal);
  const flow = recommendedFlow(intent);
  const verificationHint = snapshot?.verificationRequired && snapshot.verificationStatus !== 'passed'
    ? 'Because files changed, finish with a focused verification command before final response.'
    : undefined;
  return { intent, recommendedFlow: flow, verificationHint };
}

export function formatToolPlan(plan: ToolPlan): string {
  const lines = [
    '[Runtime Tool Planner]',
    `Intent: ${plan.intent}`,
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

function inferIntent(text: string): TaskIntent {
  const t = text.toLowerCase();
  if (/测试|运行|verify|test|vitest|jest|pytest|tsc/.test(t)) return 'test';
  if (/修复|失败|报错|错误|debug|fix|investigate/.test(t)) return 'debug';
  if (/重构|refactor/.test(t)) return 'refactor';
  if (/文档|readme|docs?/.test(t)) return 'docs';
  if (/修改|改|实现|新增|创建|edit|modify|implement|create|update/.test(t)) return 'edit';
  if (/查看|读取|搜索|解释|说明|read|search|explain|inspect/.test(t)) return 'inspect';
  return 'question';
}
