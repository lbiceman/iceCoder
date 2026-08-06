import path from 'node:path';
import { parseAllSkillRefsFromMessage } from '../skills/skill-loader.js';

export interface UserMessageDisplayFields {
  content: string;
  skills?: string[];
  referencePaths?: string[];
  /** `/shell` 模式指令；与 content（提示词）分离展示 */
  shellCommand?: string;
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

/** 将 `/shell` / `/shell <prompt>` 拆成模式标记与提示词正文。 */
function splitShellCommandFromContent(text: string): { shellCommand?: string; content: string } {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  let shellLineIndex = -1;
  let shellLine = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]?.trim() ?? '';
    if (t === '/shell' || t.startsWith('/shell ')) {
      if (t === '/shell exit' || t.startsWith('/shell exit ')) {
        return { content: raw };
      }
      shellLineIndex = i;
      shellLine = t;
      break;
    }
  }
  if (shellLineIndex < 0) return { content: raw.trim() };

  const after = shellLine.slice('/shell'.length).trim();
  const promptParts: string[] = [];
  if (after) promptParts.push(after);
  let rest = lines.slice(shellLineIndex + 1).join('\n').trim();
  if (rest.startsWith('[Shell Copilot Mode]')) rest = '';
  else {
    const bannerIdx = rest.indexOf('[Shell Copilot Mode]');
    if (bannerIdx >= 0) rest = rest.slice(0, bannerIdx).trim();
  }
  if (rest) promptParts.push(rest);
  return {
    shellCommand: '/shell',
    content: promptParts.join('\n').trim(),
  };
}

/** 从完整发送文本拆出 UI 展示字段（正文 + 技能/文件引用元数据）。 */
export function buildUserMessageDisplayFields(
  fullText: string,
  explicitReferencePaths: string[] = [],
  explicitSkills: string[] = [],
): UserMessageDisplayFields {
  const text = String(fullText || '');
  const shellSplit = splitShellCommandFromContent(text);
  const workingText = shellSplit.content;
  const skills = explicitSkills.length > 0
    ? explicitSkills.slice()
    : parseAllSkillRefsFromMessage(workingText);
  const referencePaths = explicitReferencePaths.length > 0
    ? explicitReferencePaths.slice()
    : extractReferencePathsFromContent(workingText);

  let content = stripReferencePathLines(workingText, referencePaths);
  content = stripSkillRefsFromDisplayText(content, skills);

  const result: UserMessageDisplayFields = { content };
  if (shellSplit.shellCommand) result.shellCommand = shellSplit.shellCommand;
  if (skills.length > 0) result.skills = skills;
  if (referencePaths.length > 0) result.referencePaths = referencePaths;
  return result;
}
