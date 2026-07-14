import type { SubAgentKind } from '../types/async-sub-agent.js';
import type { TaskIntent, TaskPhase } from '../types/runtime-snapshot.js';

export interface SubAgentPromptInput {
  kind: SubAgentKind;
  task: string;
  context?: string;
  paths?: string[];
  keywords?: string[];
}

const OUTPUT_SECTIONS: Record<SubAgentKind, string[]> = {
  explorer: ['Modules', 'Directories', 'Entrypoints', 'Dependencies', 'Call Relations'],
  search: ['Files', 'Functions', 'References', 'Keywords'],
  review: ['Risks', 'Suggestions', 'Possible Impacts'],
  dependency: ['Imports', 'Call Chains', 'Circular Dependencies'],
  test_analysis: ['Coverage', 'Failure Reasons', 'Test Entrypoints'],
};

export function buildSubAgentKindInstructions(kind: SubAgentKind): string {
  return [
    `Analysis kind: ${kind}`,
    'Return a concise Markdown summary using exactly these top-level sections:',
    ...OUTPUT_SECTIONS[kind].map(section => `- ${section}`),
    'If a section has no findings, write "- (none inspected)" rather than guessing.',
  ].join('\n');
}

export function buildSubAgentTaskPrompt(input: SubAgentPromptInput): string {
  return [
    buildSubAgentKindInstructions(input.kind),
    '',
    `Task: ${input.task}`,
    input.context ? `Context:\n${input.context}` : undefined,
    input.paths?.length ? `Scoped paths: ${input.paths.join(', ')}` : undefined,
    input.keywords?.length ? `Scoped keywords: ${input.keywords.join(', ')}` : undefined,
  ].filter((part): part is string => !!part).join('\n\n');
}

export function inferKindFromIntent(
  intent: TaskIntent,
  phase: TaskPhase,
  goal: string,
): SubAgentKind | null {
  const text = goal.toLowerCase();
  if (intent === 'test' || phase === 'verification') return 'test_analysis';
  if (/\b(import|dependency|dependencies|circular|调用链|依赖|循环依赖)\b/i.test(goal)) return 'dependency';
  if (/\b(risk|review|regression|影响|风险|审计)\b/i.test(goal)) return 'review';
  if (/\b(find|search|reference|usage|grep|查找|搜索|引用)\b/i.test(goal)) return 'search';
  if (
    intent === 'inspect'
    || intent === 'debug'
    || intent === 'refactor'
    || (intent === 'edit' && /\b(auth|oauth|login|module|模块|入口|架构)\b/i.test(text))
  ) {
    return 'explorer';
  }
  return null;
}
