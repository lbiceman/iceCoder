/**
 * 项目级指令文件加载（AGENTS.md 约定，与 Codex / Cursor 等工具一致）。
 *
 * 查找规则：
 * - 工作区位于 git 仓库内：从仓库根到工作区逐级查找，越靠近工作区的文件越靠后（优先级越高）
 * - 不在 git 仓库内：只看工作区目录本身
 * - 每级目录优先 `AGENTS.md`，缺失时回退 `CLAUDE.md`（同级两者并存时只取 AGENTS.md）
 * - 全部缺失时兼容旧版 `<工作区>/.iceCoder/memory.md`；已有新文件时旧版被忽略
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PROJECT_INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

export const LEGACY_PROJECT_INSTRUCTION_RELATIVE_PATH = path.join('.iceCoder', 'memory.md');

/** 旧版自动生成的空模板，视为无内容 */
const LEGACY_TEMPLATE_CONTENT = '# Project Memory';

export interface LoadedProjectInstructions {
  content: string;
  sources: string[];
  /** 存在且非空、但因更高优先级文件存在而未加载的文件 */
  ignored: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(startDir: string): Promise<string | null> {
  let dir = startDir;
  for (;;) {
    if (await pathExists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function resolveSearchDirs(workspaceRoot: string): Promise<string[]> {
  const workspace = path.resolve(workspaceRoot);
  const gitRoot = await findGitRoot(workspace);
  if (!gitRoot) return [workspace];

  const dirs: string[] = [];
  for (let dir = workspace; ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (dir === gitRoot) break;
  }
  return dirs;
}

async function readNonEmpty(filePath: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(filePath, 'utf-8')).trim();
    return text || null;
  } catch {
    return null;
  }
}

/** 所有可能影响项目指令的路径（按优先级从低到高），供缓存指纹使用。 */
export async function listProjectInstructionCandidates(workspaceRoot: string): Promise<string[]> {
  const dirs = await resolveSearchDirs(workspaceRoot);
  const candidates = dirs.flatMap((dir) => PROJECT_INSTRUCTION_FILENAMES.map((name) => path.join(dir, name)));
  candidates.push(path.join(path.resolve(workspaceRoot), LEGACY_PROJECT_INSTRUCTION_RELATIVE_PATH));
  return candidates;
}

export async function loadProjectInstructions(workspaceRoot: string): Promise<LoadedProjectInstructions> {
  const dirs = await resolveSearchDirs(workspaceRoot);
  const parts: Array<{ source: string; text: string }> = [];
  const ignored: string[] = [];

  for (const dir of dirs) {
    let picked = false;
    for (const name of PROJECT_INSTRUCTION_FILENAMES) {
      const source = path.join(dir, name);
      const text = await readNonEmpty(source);
      if (!text) continue;
      if (picked) {
        ignored.push(source);
      } else {
        parts.push({ source, text });
        picked = true;
      }
    }
  }

  const legacy = path.join(path.resolve(workspaceRoot), LEGACY_PROJECT_INSTRUCTION_RELATIVE_PATH);
  const legacyText = await readNonEmpty(legacy);
  if (legacyText && legacyText !== LEGACY_TEMPLATE_CONTENT) {
    if (parts.length === 0) parts.push({ source: legacy, text: legacyText });
    else ignored.push(legacy);
  }

  const body = parts.map((p) => `<!-- From: ${p.source} -->\n${p.text}`).join('\n\n');
  // 中文说明：多份文件时告知模型越靠后（目录越深）优先级越高。
  const content = parts.length > 1
    ? `Files are ordered from the repository root to the working directory; when they conflict, the later (more specific) file wins.\n\n${body}`
    : body;

  return {
    content,
    sources: parts.map((p) => p.source),
    ignored,
  };
}

export async function projectInstructionsFingerprint(workspaceRoot: string): Promise<string> {
  const candidates = await listProjectInstructionCandidates(workspaceRoot);
  const stats = await Promise.all(candidates.map(async (p) => {
    try {
      const stat = await fs.stat(p);
      return `${p}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return `${p}:missing`;
    }
  }));
  return stats.join('|');
}
