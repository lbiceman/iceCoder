import path from 'node:path';
import { parseAllSkillRefsFromMessage } from '../skills/skill-loader.js';

export interface UserMessageDisplayFields {
  content: string;
  skills?: string[];
  referencePaths?: string[];
}

function normalizeReferencePath(raw: string): string {
  return path.win32.normalize(raw.trim().replace(/\//g, '\\')).toLowerCase();
}

function looksLikeReferencePathLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  return false;
}

function extractReferencePathsFromContent(text: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!looksLikeReferencePathLine(trimmed)) continue;
    const key = normalizeReferencePath(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(trimmed);
  }
  return paths;
}

function stripSkillRefsFromDisplayText(text: string, skillFilenames: string[]): string {
  if (!skillFilenames.length) return text;
  const skillSet = new Set(skillFilenames.map((fn) => fn.toLowerCase()));
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/(?:^|\s)#([^\s#]+\.md)\b/g, (match, fn: string) =>
          skillSet.has(String(fn).toLowerCase()) ? '' : match,
        )
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

function stripReferencePathLines(text: string, referencePaths: string[]): string {
  if (!referencePaths.length) return text;
  const refs = new Set(referencePaths.map(normalizeReferencePath));
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !refs.has(normalizeReferencePath(trimmed));
    })
    .join('\n')
    .trim();
}

/** 从完整发送文本拆出 UI 展示字段（正文 + 技能/文件引用元数据）。 */
export function buildUserMessageDisplayFields(
  fullText: string,
  explicitReferencePaths: string[] = [],
  explicitSkills: string[] = [],
): UserMessageDisplayFields {
  const text = String(fullText || '');
  const skills = explicitSkills.length > 0
    ? explicitSkills.slice()
    : parseAllSkillRefsFromMessage(text);
  const referencePaths = explicitReferencePaths.length > 0
    ? explicitReferencePaths.slice()
    : extractReferencePathsFromContent(text);

  let content = stripReferencePathLines(text, referencePaths);
  content = stripSkillRefsFromDisplayText(content, skills);

  const result: UserMessageDisplayFields = { content };
  if (skills.length > 0) result.skills = skills;
  if (referencePaths.length > 0) result.referencePaths = referencePaths;
  return result;
}
