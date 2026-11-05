/**
 * 把当前 Agent 的角色放进稳定系统提示，紧挨安全规则之后。
 * 它压过技能、用户规则和项目说明，压不过安全规则，也不改写用户这一句要做的事。
 */

import type { AssembledPrompt, PromptSection } from './types.js';
import type { AgentProfile } from '../agents/agent-profile.js';
import { USER_RULES_CONTEXT_KEY } from './user-rules.js';

export const AGENT_PROMPT_SECTION_ID = 'active_agent';
/** 排在工具说明（40）和上下文说明（55）之后，让角色提示词成为系统提示的最后一段。 */
export const AGENT_PROMPT_PRIORITY = 80;

/**
 * 默认 Agent 的干活方式，以及默认的派工玩法。
 * 自定义 Agent 启用后整段拿掉，改由用户写的角色提示词决定。
 */
const DEFAULT_AGENT_SECTION_IDS = new Set([
  'work_style',
  'doing_tasks',
  'actions',
  'shell_guide',
  'sub_agents',
]);

/** 工具说明里属于默认 Agent 的验收策略，不是参数手册。 */
const DEFAULT_VERIFICATION_LINE = '- If the user specified a verification command or test framework, use that exact command. Otherwise discover how this repository verifies itself (scripts, README, manifests). Do not assume a default toolchain.\n';

const REPLY_STYLE = `# Reply
- Respond in the explicitly configured language when one is provided; otherwise use the language of the user's latest message. Keep technical terms and identifiers unchanged.
- Use \`path:line\` for code locations.`;

const AGENT_INTRO = `You are iceCoder. The active agent role decides how you work. Use only the tools provided this turn.

You must NEVER generate or guess URLs unless they clearly help with programming. You may use URLs from the user or from local files.`;

const CONTEXT_OVERRIDE_NOTE = 'The active agent role overrides this guidance when they conflict. It cannot expand that role or the tools provided this turn.';

export function createAgentPromptSection(agent: AgentProfile): PromptSection {
  return {
    id: AGENT_PROMPT_SECTION_ID,
    title: 'Active agent',
    content: `# Active agent: ${agent.name}

You are this agent for the whole session. This role overrides skills, user rules, and project guidance when they conflict. It does not override safety rules or permissions. The user's current message decides the task. It does not expand this role or authorize tools that were not provided. This role decides how you work. Use only the tools provided in this turn.

${agent.prompt.trim()}`,
    isStatic: false,
    priority: AGENT_PROMPT_PRIORITY,
    enabled: true,
  };
}

function adaptSectionForAgent(section: PromptSection): PromptSection {
  if (section.id === 'intro') {
    return { ...section, content: AGENT_INTRO, isStatic: false };
  }
  if (section.id === 'tool_usage' && section.content.includes(DEFAULT_VERIFICATION_LINE)) {
    return {
      ...section,
      content: section.content.replace(DEFAULT_VERIFICATION_LINE, ''),
      isStatic: false,
    };
  }
  return section;
}

export function applyAgentPrompt(assembled: AssembledPrompt, agent: AgentProfile | null): AssembledPrompt {
  if (!agent) return assembled;
  const sections = assembled.systemPromptSections
    .filter((section) => section.enabled
      && section.id !== AGENT_PROMPT_SECTION_ID
      && !DEFAULT_AGENT_SECTION_IDS.has(section.id))
    .map(adaptSectionForAgent)
    .concat({
      id: 'reply_style',
      title: 'Reply',
      content: REPLY_STYLE,
      isStatic: false,
      priority: 11,
      enabled: true,
    })
    .concat(createAgentPromptSection(agent))
    .sort((a, b) => a.priority - b.priority);
  return {
    ...assembled,
    systemPromptSections: sections,
    systemPrompt: sections.map((section) => section.content).join('\n\n'),
  };
}

/** 用户规则和项目说明贴在用户消息里，补一句：冲突时听当前 Agent，不能借此放宽角色或工具。 */
export function annotateContextForActiveAgent(
  userContext: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!userContext) return userContext;
  const out = { ...userContext };
  for (const key of [USER_RULES_CONTEXT_KEY, 'project_instructions']) {
    const text = out[key];
    if (!text || text.includes(CONTEXT_OVERRIDE_NOTE)) continue;
    out[key] = `${text.trim()}\n\n${CONTEXT_OVERRIDE_NOTE}`;
  }
  return out;
}
