/**
 * Shell 协作模式下的 system prompt 组装：剔除普通 Agent 工具说明，注入 Shell Copilot 规则。
 */

import type { AssembledPrompt, PromptSection } from './types.js';
import {
  createShellCopilotSection,
  SHELL_COLLAB_REMOVED_SECTION_IDS,
} from './sections.js';

const REMOVED_IDS = new Set<string>(SHELL_COLLAB_REMOVED_SECTION_IDS);

function buildShellCollabSections(
  assembledSections: PromptSection[],
  skillExamples?: string,
): PromptSection[] {
  const base = assembledSections.filter(
    (section) => section.enabled
      && section.id !== 'shell_copilot'
      && !REMOVED_IDS.has(section.id),
  );
  const shellSection = createShellCopilotSection(skillExamples);
  return [...base, shellSection].filter((section) => section.enabled)
    .sort((a, b) => a.priority - b.priority);
}

/** 将普通 AssembledPrompt 转为 Shell 协作专用 system prompt。 */
export function applyShellCollabPromptOverlay(
  assembled: AssembledPrompt,
  skillExamples?: string,
): AssembledPrompt {
  const enabledSections = buildShellCollabSections(assembled.systemPromptSections, skillExamples);
  const systemPrompt = enabledSections.map((section) => section.content).join('\n\n');

  return {
    ...assembled,
    systemPromptSections: enabledSections,
    systemPrompt,
  };
}

export function assembleShellCollabPrompt(assembled: AssembledPrompt): AssembledPrompt {
  return applyShellCollabPromptOverlay(assembled);
}
