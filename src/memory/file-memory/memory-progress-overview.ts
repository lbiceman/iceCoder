/**
 * 将会话进度型 *-overview.md 降级为 session_state，避免把「已提交 / 全绿」快照当成长久项目约定召回。
 * 不删除文件；约定型 overview（周报技能、模型配置、checklist 教训等）不改。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import { getScannerCache } from './memory-scanner-cache.js';

export const SESSION_PROGRESS_CONFIDENCE_CAP = 0.45;
export const SESSION_PROGRESS_LEVEL = 'session_state';
export const SESSION_PROGRESS_CATEGORY = 'session_progress';
export const SESSION_PROGRESS_TAG = 'status:session_progress';

const SESSION_PROGRESS_NAME_DESC_RE =
  /已全部完成|已完成并提交|测试全绿|实现状态|已补齐自动化测试|P0-P3 续改|块\d+|审计收尾|\d+\s*\/\s*\d+\s*通过/;

export interface SessionProgressOverviewInput {
  filename: string;
  name?: string | null;
  description?: string | null;
}

export function isSessionProgressOverview(input: SessionProgressOverviewInput): boolean {
  if (!/-overview\.md$/i.test(input.filename)) return false;
  const text = `${input.name ?? ''} ${input.description ?? ''}`;
  return SESSION_PROGRESS_NAME_DESC_RE.test(text);
}

export interface ProgressOverviewDowngradeResult {
  downgraded: string[];
}

function frontmatterValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

function upsertFrontmatterField(content: string, key: string, value: string): string {
  const fieldPattern = new RegExp(`^${key}:\\s*.*$`, 'm');
  if (fieldPattern.test(content)) {
    return content.replace(fieldPattern, `${key}: ${value}`);
  }
  const confidencePattern = /^(confidence:\s*\S+)\s*$/m;
  if (confidencePattern.test(content)) {
    return content.replace(confidencePattern, `$1\n${key}: ${value}`);
  }
  return content.replace(/^---\s*$/m, `---\n${key}: ${value}`);
}

function alreadyDowngraded(content: string): boolean {
  const level = frontmatterValue(content, 'level');
  const category = frontmatterValue(content, 'memoryCategory');
  const tags = frontmatterValue(content, 'tags') || '';
  return level === SESSION_PROGRESS_LEVEL
    && (category === SESSION_PROGRESS_CATEGORY || tags.includes(SESSION_PROGRESS_TAG));
}

function withProgressTag(content: string): string {
  const current = frontmatterValue(content, 'tags');
  if (!current) {
    return upsertFrontmatterField(content, 'tags', SESSION_PROGRESS_TAG);
  }
  const tags = current.split(',').map(tag => tag.trim()).filter(Boolean);
  if (tags.includes(SESSION_PROGRESS_TAG)) return content;
  return upsertFrontmatterField(content, 'tags', `${current}, ${SESSION_PROGRESS_TAG}`);
}

function capConfidence(raw: string | null): string {
  const parsed = raw ? Number.parseFloat(raw) : 1;
  const current = Number.isFinite(parsed) ? parsed : 1;
  return String(Math.min(current, SESSION_PROGRESS_CONFIDENCE_CAP));
}

/**
 * 扫描项目记忆目录，把进度快照型 overview 降级为 session_state。
 */
export async function downgradeSessionProgressOverviews(
  memoryDir: string,
): Promise<ProgressOverviewDowngradeResult> {
  const downgraded: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(memoryDir);
  } catch {
    return { downgraded };
  }

  for (const name of names) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
    const filePath = path.join(memoryDir, name);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    if (!isSessionProgressOverview({
      filename: name,
      name: frontmatterValue(content, 'name'),
      description: frontmatterValue(content, 'description'),
    })) {
      continue;
    }
    if (alreadyDowngraded(content)) continue;

    let next = upsertFrontmatterField(content, 'level', SESSION_PROGRESS_LEVEL);
    next = upsertFrontmatterField(next, 'memoryCategory', SESSION_PROGRESS_CATEGORY);
    next = upsertFrontmatterField(next, 'confidence', capConfidence(frontmatterValue(next, 'confidence')));
    next = withProgressTag(next);
    next = upsertFrontmatterField(next, 'progressSnapshot', 'true');

    if (next !== content) {
      await writeFileAtomic(filePath, next, 'utf-8');
      downgraded.push(name);
    }
  }

  if (downgraded.length > 0) {
    getScannerCache().invalidate(memoryDir);
    console.log(`[memory-progress-overview] downgraded ${downgraded.join(', ')}`);
  }

  return { downgraded };
}
