/**
 * 主代理读/列记忆文件时隐藏会话进度快照，避免把过期 overview 当现状。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  canonicalizeMemoryToolPath,
  parseMemoryFrontmatterField,
  resolveMemoryRootForPath,
} from './memory-write-pipeline.js';
import { resolveMemoryEvictedRoot } from './memory-config.js';
import { isWithinMemoryDir } from './memory-security.js';
import {
  SESSION_PROGRESS_CATEGORY,
  SESSION_PROGRESS_TAG,
} from './memory-progress-overview.js';

export const SESSION_PROGRESS_TOOL_SKIP_MESSAGE =
  'This file is archived session-progress memory, not active long-term memory. Do not treat it as current project status. Use session-notes or the current codebase.';

function isWithinArchivedMemoryDir(absolutePath: string): boolean {
  try {
    return isWithinMemoryDir(path.resolve(absolutePath), resolveMemoryEvictedRoot());
  } catch {
    return false;
  }
}

export function isHiddenSessionProgressMemoryContent(content: string): boolean {
  const category = parseMemoryFrontmatterField(content, 'memoryCategory').toLowerCase();
  if (category === SESSION_PROGRESS_CATEGORY) return true;
  if (parseMemoryFrontmatterField(content, 'progressSnapshot').toLowerCase() === 'true') return true;
  const tags = parseMemoryFrontmatterField(content, 'tags');
  return tags.includes(SESSION_PROGRESS_TAG);
}

export async function isHiddenMemoryToolPath(absolutePath: string): Promise<boolean> {
  const normalized = path.resolve(absolutePath);
  if (!resolveMemoryRootForPath(normalized) && !isWithinArchivedMemoryDir(normalized)) {
    return false;
  }
  const filename = path.basename(normalized);
  if (filename === 'MEMORY.md' || !filename.endsWith('.md')) return false;
  try {
    const content = await fs.readFile(normalized, 'utf-8');
    return isHiddenSessionProgressMemoryContent(content);
  } catch {
    return false;
  }
}

export async function gateMemoryToolRead(rawPath: string, workDir: string): Promise<{
  resolvedPath: string;
  blocked: boolean;
  message?: string;
}> {
  const resolvedPath = canonicalizeMemoryToolPath(rawPath, workDir);
  if (await isHiddenMemoryToolPath(resolvedPath)) {
    return { resolvedPath, blocked: true, message: SESSION_PROGRESS_TOOL_SKIP_MESSAGE };
  }
  return { resolvedPath, blocked: false };
}

function candidateAbsolutePaths(listed: string, bases: string[]): string[] {
  if (path.isAbsolute(listed)) return [path.resolve(listed)];
  const out: string[] = [];
  for (const base of bases) {
    out.push(canonicalizeMemoryToolPath(listed, base));
    out.push(path.resolve(base, listed));
  }
  return out;
}

/** glob/grep 结果里丢掉活跃库中的 session_progress 文件 */
export async function filterHiddenMemoryListing(paths: string[], bases: string[]): Promise<string[]> {
  const visible: string[] = [];
  for (const listed of paths) {
    const candidates = candidateAbsolutePaths(listed, bases);
    let hidden = false;
    for (const abs of candidates) {
      if (await isHiddenMemoryToolPath(abs)) {
        hidden = true;
        break;
      }
    }
    if (!hidden) visible.push(listed);
  }
  return visible;
}
