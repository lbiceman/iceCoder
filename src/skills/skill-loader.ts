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

function baseNameSansExt(filename: string): string {
  const leaf = path.basename(filename);
  return leaf.replace(/\.md$/i, '') || leaf;
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
    const entries = await fs.readdir(skillsDir, { recursive: true });
    const mdFiles = entries.filter(
      f => typeof f === 'string' && f.endsWith('.md'),
    );

    const results = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<SkillMeta & { mtimeMs: number }> => {
        const filePath = path.join(skillsDir, relativePath as string);
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf-8');
        const meta = buildSkillMeta(relativePath as string, content, stat.mtimeMs);
        return { ...meta, mtimeMs: stat.mtimeMs };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<SkillMeta & { mtimeMs: number }> => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxFiles)
      .map(({ mtimeMs: _mtimeMs, ...meta }) => meta);
  } catch {
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

/** 将用户输入规范化为技能文件名（自动补 .md）。 */
export function normalizeSkillFilename(raw: string): string {
  const trimmed = raw.trim().replace(/^#/, '');
  if (!trimmed) return '';
  const base = path.basename(trimmed);
  return base.endsWith('.md') ? base : `${base}.md`;
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
