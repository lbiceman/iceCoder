/**
 * 规划模式下的 system prompt 组装：弱化实现向段落，注入只能写文档的规则。
 */

import type { AssembledPrompt, PromptSection } from './types.js';
import {
  createPlanModeSection,
  PLAN_MODE_REMOVED_SECTION_IDS,
} from './sections.js';

const REMOVED_IDS = new Set<string>(PLAN_MODE_REMOVED_SECTION_IDS);

function buildPlanModeSections(assembledSections: PromptSection[]): PromptSection[] {
  const base = assembledSections.filter(
    (section) => section.enabled
      && section.id !== 'plan_mode'
      && !REMOVED_IDS.has(section.id),
  );
  return [...base, createPlanModeSection()]
    .filter((section) => section.enabled)
    .sort((a, b) => a.priority - b.priority);
}

/** 将普通 AssembledPrompt 转为规划模式专用 system prompt（不污染默认静态前缀缓存）。 */
export function applyPlanModePromptOverlay(assembled: AssembledPrompt): AssembledPrompt {
  const enabledSections = buildPlanModeSections(assembled.systemPromptSections);
  const systemPrompt = enabledSections.map((section) => section.content).join('\n\n');

  return {
    ...assembled,
    systemPromptSections: enabledSections,
    systemPrompt,
  };
}

export function assemblePlanModePrompt(assembled: AssembledPrompt): AssembledPrompt {
  return applyPlanModePromptOverlay(assembled);
}
