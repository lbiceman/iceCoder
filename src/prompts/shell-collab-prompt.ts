/**
 * Shell 协作模式下的 system prompt 组装：剔除普通 Agent 工具说明，注入 Shell Copilot 规则。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LOCAL_DATA_DIR, resolvePackagedDataDir } from '../cli/paths.js';
import { readSkillBody } from '../skills/skill-loader.js';
import { extractBodyFromMarkdown } from '../memory/file-memory/memory-parser.js';
import type { AssembledPrompt, PromptSection } from './types.js';
import {
  createShellCopilotSection,
  SHELL_COLLAB_REMOVED_SECTION_IDS,
} from './sections.js';

const SHELL_COPILOT_SKILL_REL = 'shellCopilot/skill.md';
const REMOVED_IDS = new Set<string>(SHELL_COLLAB_REMOVED_SECTION_IDS);

async function readBundledShellCopilotSkillBody(): Promise<string | null> {
  const candidates = [
    path.join(LOCAL_DATA_DIR, 'skills', SHELL_COPILOT_SKILL_REL),
    resolvePackagedDataDir(path.join('skills', SHELL_COPILOT_SKILL_REL)),
  ];
  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const body = extractBodyFromMarkdown(raw).trim();
      if (body) return body;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 加载 shellCopilot 技能正文（优先 ICE_SKILLS_DIR，回退 repo data/skills）。 */
export async function loadShellCopilotSkillBody(): Promise<string | null> {
  const skillsDir = process.env.ICE_SKILLS_DIR?.trim();
  if (skillsDir) {
    const fromUserDir = await readSkillBody(skillsDir, SHELL_COPILOT_SKILL_REL);
    if (fromUserDir) return fromUserDir;
  }
  return readBundledShellCopilotSkillBody();
}

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

export async function assembleShellCollabPrompt(assembled: AssembledPrompt): Promise<AssembledPrompt> {
  const skillBody = await loadShellCopilotSkillBody();
  return applyShellCollabPromptOverlay(assembled, skillBody ?? undefined);
}
