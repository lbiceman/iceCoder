/**
 * 评测模式 overlay：无论默认或自定义 system，都追加不可降级的评测约束。
 */

import type { AssembledPrompt } from './types.js';
import { createEvaluationModeSection } from './sections.js';

export function applyEvaluationModePromptOverlay(assembled: AssembledPrompt): AssembledPrompt {
  const evaluationSection = createEvaluationModeSection();
  const sections = assembled.systemPromptSections
    .filter((section) => section.enabled && section.id !== evaluationSection.id)
    .concat(evaluationSection)
    .sort((a, b) => a.priority - b.priority);

  return {
    ...assembled,
    systemPromptSections: sections,
    systemPrompt: sections.map((section) => section.content).join('\n\n'),
  };
}
