/**
 * 会话级 toolCallId → diff 索引（不受 structured 压缩影响）。
 * 供 UI 历史区 F5 后还原 write_file / edit 等 diff。
 */

import { promises as fs } from 'node:fs';
import path from 'path';
import { extractDiffSource } from './tool-display-extract.js';
import { resolveEffectiveWorkspaceRoot } from '../harness/session-workspace-store.js';

export const MAX_TOOL_TRACE_DIFF_CHARS = 80_000;

export function toolTraceDiffsPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.tool-trace-diffs.json`);
}

export function capToolTraceDiffSource(diff: string | null | undefined): string | null {
  if (!diff || typeof diff !== 'string') return null;
  if (diff.length <= MAX_TOOL_TRACE_DIFF_CHARS) return diff;
  return diff.slice(0, MAX_TOOL_TRACE_DIFF_CHARS) + '\n...[diff truncated for session storage]';
}

export async function readToolTraceDiffIndex(
  sessionsDir: string,
  sessionId: string,
): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(toolTraceDiffsPath(sessionsDir, sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function persistToolTraceDiff(
  sessionsDir: string,
  sessionId: string,
  toolCallId: string,
  diffSource: string | null | undefined,
): Promise<void> {
  const capped = capToolTraceDiffSource(diffSource);
  if (!toolCallId || !capped) return;
  await fs.mkdir(sessionsDir, { recursive: true });
  const file = toolTraceDiffsPath(sessionsDir, sessionId);
  const index = await readToolTraceDiffIndex(sessionsDir, sessionId);
  index[toolCallId] = capped;
  await fs.writeFile(file, JSON.stringify(index), 'utf-8');
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isPathInsideRoot(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot) return true;
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolvePathUnderWorkspace(workspaceRoot: string, relPath: string): string | null {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relPath.replace(/\//g, path.sep));
  if (!isPathInsideRoot(root, target)) return null;
  return target;
}

function isAbsoluteWorkspacePath(p: string): boolean {
  const t = p.trim();
  return /^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/') || t.startsWith('\\');
}

/** 收集可能的工作区根目录（workspace.json → 会话 fs_operation → defaultWorkDir） */
export async function collectWorkspaceRoots(
  sessionsDir: string,
  sessionId: string,
  defaultWorkDir: string,
): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  const add = (r: string | undefined) => {
    if (!r?.trim()) return;
    const resolved = path.resolve(r.trim());
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push(resolved);
  };

  const ws = await resolveEffectiveWorkspaceRoot(sessionsDir, sessionId, defaultWorkDir);
  add(ws.workspaceRoot);
  add(ws.lockedRoot);

  try {
    const raw = await fs.readFile(path.join(sessionsDir, `${sessionId}.json`), 'utf-8');
    const msgs = JSON.parse(raw) as Array<{ role?: string; toolName?: string; detail?: string }>;
    for (const m of msgs) {
      if (m.role !== 'tool_trace' || !m.detail?.trim()) continue;
      const detail = m.detail.trim();
      if (m.toolName === 'fs_operation' && isAbsoluteWorkspacePath(detail)) {
        add(detail);
        break;
      }
    }
  } catch {
    /* session file may not exist */
  }

  add(defaultWorkDir);
  return roots;
}

async function tryReadWriteFileDiffFromRoots(
  roots: string[],
  rel: string,
): Promise<string | null> {
  for (const root of roots) {
    const abs = resolvePathUnderWorkspace(root, rel);
    if (!abs) continue;
    try {
      const content = await fs.readFile(abs, 'utf-8');
      return capToolTraceDiffSource(buildAddedFileUnifiedDiff(rel, content));
    } catch {
      /* try next root */
    }
  }
  return null;
}

/** 从 write_file 的 detail（相对路径）合成「全新文件」unified diff */
export function buildAddedFileUnifiedDiff(relPath: string, content: string): string {
  const norm = normalizeRelPath(relPath);
  const lines = content.split(/\r?\n/);
  const header = `--- /dev/null\n+++ ${norm}\n@@ -0,0 +1,${lines.length} @@\n`;
  return header + lines.map((line) => `+${line}`).join('\n');
}

function pathFromWriteDetail(detail: string | undefined): string {
  return normalizeRelPath((detail || '').trim());
}

function pathFromToolOutput(content: string | undefined): string {
  if (!content) return '';
  const m = /^File written:\s*(.+?)(?:\r?\n|\n|$)/m.exec(content);
  return m ? normalizeRelPath(m[1].trim()) : '';
}

/**
 * 按 toolCallId / 相对路径解析 diff：索引 → structured tool 行 → 工作区读文件。
 */
export async function resolveToolDiffForSession(opts: {
  sessionsDir: string;
  sessionId: string;
  defaultWorkDir: string;
  toolCallId?: string;
  relPath?: string;
  toolName?: string;
  structured?: { role: string; toolCallId?: string; content?: string }[];
  workspaceRootOverride?: string;
}): Promise<string | null> {
  const { sessionsDir, sessionId, defaultWorkDir, toolCallId, relPath, toolName } = opts;
  const structured = opts.structured;

  if (toolCallId) {
    const index = await readToolTraceDiffIndex(sessionsDir, sessionId);
    if (index[toolCallId]) return index[toolCallId];
  }

  if (structured && toolCallId) {
    for (const msg of structured) {
      if (msg.role !== 'tool' || msg.toolCallId !== toolCallId) continue;
      const ds = extractDiffSource(toolName || 'write_file', msg.content, undefined);
      if (ds) return capToolTraceDiffSource(ds);
    }
  }

  const rel = pathFromWriteDetail(relPath);
  if (!rel || (toolName && toolName !== 'write_file')) return null;

  const roots = await collectWorkspaceRoots(sessionsDir, sessionId, defaultWorkDir);
  if (opts.workspaceRootOverride?.trim()) {
    const override = path.resolve(opts.workspaceRootOverride.trim());
    if (!roots.includes(override)) roots.unshift(override);
    else {
      roots.splice(roots.indexOf(override), 1);
      roots.unshift(override);
    }
  }
  return tryReadWriteFileDiffFromRoots(roots, rel);
}

export function pathsMatchForToolAlign(traceDetail: string, outputContent: string | undefined): boolean {
  const tr = pathFromWriteDetail(traceDetail);
  const op = pathFromToolOutput(outputContent);
  if (!tr || !op) return true;
  return tr === op;
}
