/**
 * 技能文件加载器：扫描 skills 目录中的 .md 技能文件。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../memory/file-memory/memory-scanner.js';
import { extractBodyFromMarkdown } from '../memory/file-memory/memory-parser.js';
import { validatePath, PathTraversalError } from '../memory/file-memory/memory-security.js';

/** 技能元信息（列表展示用） */
export interface SkillMeta {
  filename: string;
  name: string;
  description: string;
  contentPreview: string;
  modifiedAt: string;
  createdAt: string;
}

const CONTENT_PREVIEW_MAX = 200;
const FRONTMATTER_MAX_LINES = 30;

/** 技能文件夹内的 README 说明文件，不参与注册。 */
function isExcludedSkillMarkdown(relativePath: string): boolean {
  return path.basename(relativePath).toLowerCase() === 'readme.md';
}

function baseNameSansExt(filename: string): string {
  const leaf = path.basename(filename);
  return leaf.replace(/\.md$/i, '') || leaf;
}

/** 收集可注册的技能相对路径：根目录 .md + 一级子目录内的 .md（不递归更深）。 */
export async function collectSkillRelativePaths(skillsDir: string): Promise<string[]> {
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      if (!isExcludedSkillMarkdown(entry.name)) paths.push(entry.name);
      continue;
    }
    if (!entry.isDirectory()) continue;

    const subDir = path.join(skillsDir, entry.name);
    const subEntries = await fs.readdir(subDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isFile() || !sub.name.toLowerCase().endsWith('.md')) continue;
      const relativePath = `${entry.name}/${sub.name}`.replace(/\\/g, '/');
      if (isExcludedSkillMarkdown(relativePath)) continue;
      paths.push(relativePath);
    }
  }

  return paths;
}

function buildSkillMeta(
  filename: string,
  content: string,
  mtimeMs: number,
): SkillMeta {
  const truncated = content.split('\n').slice(0, FRONTMATTER_MAX_LINES).join('\n');
  const frontmatter = parseFrontmatter(truncated);
  const name = frontmatter.name?.trim() || baseNameSansExt(filename);
  const description = frontmatter.description?.trim() || '';
  const body = extractBodyFromMarkdown(content).trim();
  const preview = body.slice(0, CONTENT_PREVIEW_MAX);
  const createdAt = frontmatter.createdAt?.trim() || new Date(mtimeMs).toISOString();

  return {
    filename: filename.replace(/\\/g, '/'),
    name,
    description,
    contentPreview: preview,
    modifiedAt: new Date(mtimeMs).toISOString(),
    createdAt,
  };
}

/** 扫描技能目录，返回按修改时间降序排列的技能列表。 */
export async function scanSkillFiles(skillsDir: string, maxFiles = 100): Promise<SkillMeta[]> {
  try {
    const mdFiles = await collectSkillRelativePaths(skillsDir);

    const results = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<SkillMeta & { mtimeMs: number }> => {
        const filePath = path.join(skillsDir, relativePath);
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const meta = buildSkillMeta(relativePath, content, stat.mtimeMs);
        return { ...meta, mtimeMs: stat.mtimeMs };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<SkillMeta & { mtimeMs: number }> => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxFiles)
      .map(({ mtimeMs: _mtimeMs, ...meta }) => meta);
  } catch (err) {
    // 技能目录不存在属预期（debug）；其它扫描异常上报 warn，避免技能列表静默为空难以排查（P1-16）。
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      console.debug('[skill-loader] 技能目录不存在，跳过扫描:', skillsDir);
    } else {
      console.warn('[skill-loader] 扫描技能目录失败，返回空列表:', skillsDir, err instanceof Error ? err.message : err);
    }
    return [];
  }
}

/** 读取指定技能文件的完整内容。 */
export async function readSkillFile(
  skillsDir: string,
  filename: string,
): Promise<{ content: string; meta: SkillMeta } | null> {
  try {
    const filePath = validatePath(filename, skillsDir);
    const stat = await fs.stat(filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    return {
      content,
      meta: buildSkillMeta(filename.replace(/\\/g, '/'), content, stat.mtimeMs),
    };
  } catch (e) {
    if (e instanceof PathTraversalError) throw e;
    return null;
  }
}

/** 读取技能正文（跳过 frontmatter）。 */
export async function readSkillBody(skillsDir: string, filename: string): Promise<string | null> {
  const found = await readSkillFile(skillsDir, filename);
  if (!found) return null;
  return extractBodyFromMarkdown(found.content).trim();
}

/** 将用户输入规范化为技能相对路径（自动补 .md；支持一级子目录如 openClaude/skll.md）。 */
export function normalizeSkillFilename(raw: string): string {
  const trimmed = raw.trim().replace(/^#/, '');
  if (!trimmed) return '';

  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/')) return '';

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return '';

  const ensureMd = (name: string): string => (name.toLowerCase().endsWith('.md') ? name : `${name}.md`);

  if (parts.length === 1) return ensureMd(parts[0]);
  return `${parts[0]}/${ensureMd(parts[1])}`;
}

/** 从用户消息中解析所有技能引用（#xxx.md）。 */
export function parseAllSkillRefsFromMessage(text: string): string[] {
  const re = /(?:^|\s)#([^\s#]+\.md)\b/g;
  const seen = new Set<string>();
  const result: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const fn = m[1];
    if (!seen.has(fn)) {
      seen.add(fn);
      result.push(fn);
    }
  }
  return result;
}

/** 从用户消息开头解析单个技能引用（兼容旧逻辑）。 */
export function parseSkillRefFromMessage(text: string): { filename: string; rest: string } | null {
  const match = text.match(/^#([^\s#]+\.md)\s*([\s\S]*)$/);
  if (!match) return null;
  return { filename: match[1], rest: match[2].trim() };
}

const SKILL_VERB_CN =
  '创建|新建|新增|添加|编写|撰写|制作|定义|写|建|做|弄|加|生成|编辑|修改|调整|更新|优化|完善|修订|改写|改';
const SKILL_VERB_EN =
  'create|add|write|make|define|new|generate|edit|modify|update|adjust|revise|tweak|change';

const SKILL_CREATE_INTENT_PATTERNS: RegExp[] = [
  // 创建skill / 编辑 skill / 修改一个技能 / 生成skill
  new RegExp(
    `(?:${SKILL_VERB_CN})\\s*(?:一下|一个|个|一种)?\\s*(?:技能|skills?)`,
    'i',
  ),
  // 技能修改 / skill 文件编辑
  new RegExp(
    `(?:技能|skills?)\\s*(?:文件|markdown|md|文档)?\\s*(?:的)?\\s*(?:${SKILL_VERB_CN})`,
    'i',
  ),
  // create / edit / generate skill
  new RegExp(
    `(?:${SKILL_VERB_EN})\\s+(?:a\\s+)?skills?(?:\\s+file)?`,
    'i',
  ),
  /skills?\s*(?:file|markdown|creation|create|edit|update|modify)/i,
  // 口语：帮我改个 skill、调整一下技能
  new RegExp(
    `(?:帮我|请|麻烦)?\\s*(?:做|弄|搞|整|改|调)\\s*(?:一下|一个|个)?\\s*(?:技能|skills?)`,
    'i',
  ),
];

/** 用户是否要创建/编辑/修改/生成技能文件（区别于仅引用 #xxx.md 使用技能）。 */
export function wantsSkillCreation(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  return SKILL_CREATE_INTENT_PATTERNS.some((re) => re.test(t));
}

/** 生成技能文件落盘指引，注入给模型以明确目录与格式。 */
export function buildSkillCreationGuide(skillsDir: string): string {
  const dir = skillsDir.replace(/\\/g, '/');
  return `[System: Skill File Guide]

The user wants to create, generate, edit, modify, or adjust an Agent Skill file. All read/write MUST use the directory below, or the Skills page and chat \`#\` picker will NOT see it.

**ONLY valid directory**: \`${dir}\`
- Same level as user-memory; env \`ICE_SKILLS_DIR\`
- Do NOT write under src/skills, .cursor/skills, docs/, project root, or any other path
- When editing/updating: modify the existing \`.md\` in this directory (read_file first); do not duplicate elsewhere

**File rules**:
- One skill = one registerable \`.md\` file
- **Text-only**: root \`skillname.md\` (e.g. \`创建技能.md\` → \`#创建技能.md\`)
- **With scripts** (preferred): one first-level folder per skill, markdown MUST be \`folder/skill.md\`:
  - Example: \`connectWeChat/skill.md\` → \`#connectWeChat/skill.md\`
  - Scripts: \`connectWeChat/connect.js\` OR \`connectWeChat/scripts/connect.js\` (same folder; \`scripts/\` is optional)
  - Folder name: English camelCase (e.g. \`connectWeChat\`); do NOT use random md names like \`skll.md\`
  - Do NOT create \`README.md\` / \`readme.md\` inside skill folders — every \`.md\` directly in a first-level folder is registered as a separate skill; put all docs in \`skill.md\` body instead
  - Only \`.md\` files directly inside a first-level folder are registered; deeper paths are assets only
- Use write_file / edit_file (or equivalent) to create or update; no server restart needed

**Required Markdown shape** (YAML frontmatter + body):
\`\`\`markdown
---
name: Display name
description: One-line when to use this skill
createdAt: 2026-06-16T00:00:00.000Z
---

(Steps, constraints, examples for the agent…)
\`\`\`

After saving, tell the user the filename and that they can pick it via \`#\` in chat or the Skills sidebar.`;
}

/** 在发往 Harness 的文本前追加技能创建指引。 */
export function prependSkillCreationGuide(harnessText: string, skillsDir: string): string {
  return `${buildSkillCreationGuide(skillsDir)}\n\n${harnessText}`;
}
