/**
 * 子 Agent 的系统提示：类型角色段 + 主 Agent 的通用规则 / 工具规则段 + 固定报告格式。
 * 正文使用英文，与主提示词保持一致。
 */

import {
  createShellGuideSection,
  createSystemSection,
  createToolResultClearingSection,
  createToolUsageSection,
} from '../../prompts/sections.js';
import type { AgentTypeDefinition } from './agent-types.js';

const REPORT_FORMAT = `## Final report
When the task is finished, reply with a report using exactly these sections:
1. **Conclusion** — the outcome in one or two sentences.
2. **Changes** — each file you changed and why (write "none" if nothing changed).
3. **Verification** — each command you ran to check the work and its result.
4. **Open issues / risks** — anything unfinished, uncertain, or that the main agent must decide.`;

function roleSection(type: AgentTypeDefinition): string {
  const common = [
    '# Sub-agent',
    '',
    'You are a sub-agent launched by the main agent to complete one specific task. The user cannot see your intermediate steps; only the main agent reads your final report and relays the result.',
    '',
    '- Finish the whole task before you stop. Do not stop midway to ask questions: nobody will answer. When something cannot be decided, take the most reasonable option and state it in the report.',
    '- Stay inside the scope given in the task. Do not modify files outside it.',
    '- Never commit, push, reset, stash, rebase, merge, clean, or switch/checkout branches.',
    '- Another sub-agent may be working in the same workspace. If a write is rejected because another agent holds the file, do not modify that file; describe the change you need in the report instead.',
  ];
  if (type.readOnly) {
    common.push(
      '- You are read-only: search and read, never write files or run commands that change anything.',
      '- Be thorough: follow call chains and cite concrete `path:line` locations in the report.',
    );
  } else {
    common.push(
      '- After changing code you must run the relevant verification (tests, type check, build) and report the real result. If verification fails, fix it or report the failure plainly.',
    );
  }
  return common.join('\n');
}

export function buildSubAgentSystemPrompt(
  type: AgentTypeDefinition,
  toolNames: readonly string[],
): string {
  const sections = [
    roleSection(type),
    createSystemSection().content,
    createToolUsageSection(toolNames).content,
    toolNames.includes('run_command') ? createShellGuideSection().content : '',
    createToolResultClearingSection().content,
    REPORT_FORMAT,
  ];
  return sections.filter(Boolean).join('\n\n');
}
