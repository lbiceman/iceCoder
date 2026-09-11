/**
 * run_command / shell_exec 造成的工作区变动：命令解析 + 执行前后清单对比。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { remapPathToWorkspace } from './workspace-snapshot.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.ice',
  '__pycache__',
  '.next',
  'vendor',
]);

const MAX_INVENTORY_FILES = 400;

export type WorkspaceFileInventory = Map<string, { size: number; mtimeMs: number }>;

const preCommandInventories = new Map<string, WorkspaceFileInventory>();

function inventoryKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

function looksLikePathToken(raw: string): boolean {
  const t = raw.trim().replace(/^['"]|['"]$/g, '');
  if (!t || t.length > 260) return false;
  if (/^(?:-|\/|con|nul|null|true|false|\d+)$/i.test(t)) return false;
  if (t.includes('*') || t.includes('?')) return false;
  if (t === '&1' || t === '&2') return false;
  return /[\w.-]+\.\w{1,12}$/.test(t) || /[\\/]/.test(t) || /^[\w.-]+$/.test(t);
}

function normalizeCommandPath(raw: string): string | null {
  const t = raw.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  if (!looksLikePathToken(t)) return null;
  return t.replace(/^\/+/, '');
}

/** 从 shell 命令里抽出很可能被写入/删除的路径（重定向、rm/cp/mv、PowerShell）。 */
export function extractLikelyWritePathsFromCommand(command: string): string[] {
  if (!command?.trim()) return [];
  const paths = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const normalized = normalizeCommandPath(raw);
    if (normalized) paths.add(normalized);
  };

  const redir = /(?:^|[\s])(?:\d*)>>?\s*(?!\&)(['"][^'"]+['"]|[^\s&|<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = redir.exec(command))) add(match[1]);

  const tee = /\btee(?:\s+-a)?\s+(['"][^'"]+['"]|[^\s&|<>]+)/gi;
  while ((match = tee.exec(command))) add(match[1]);

  const rm = /\b(?:rm|del|remove-item)\b(?:\s+-\w+)+\s+|\b(?:rm|del|Remove-Item)\b\s+/i;
  if (rm.test(command)) {
    const after = command.replace(/^[\s\S]*?\b(?:rm|del|Remove-Item)\b/i, '');
    for (const token of after.split(/\s+/)) {
      if (token.startsWith('-')) continue;
      add(token);
      break;
    }
  }

  const copyMove = /\b(?:cp|mv|copy|move|Copy-Item|Move-Item)\b/i;
  if (copyMove.test(command)) {
    const tokens = command.split(/\s+/).filter((t) => t && !t.startsWith('-') && !copyMove.test(t));
    add(tokens[tokens.length - 1]);
  }

  const filePathFlag = /(?:-FilePath|-Path|-LiteralPath)\s+(['"][^'"]+['"]|[^\s]+)/gi;
  while ((match = filePathFlag.exec(command))) add(match[1]);

  const touch = /\b(?:touch|New-Item)\b[\s\S]*?\s+(['"][^'"]+['"]|[^\s&|<>]+)\s*$/i;
  const touchMatch = command.match(touch);
  if (touchMatch) add(touchMatch[1]);

  return [...paths];
}

export function isShellWorkspaceTouchTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
): boolean {
  if (!args || typeof args !== 'object') return false;
  if (toolName === 'shell_exec') {
    return typeof (args.command ?? args.cmd) === 'string';
  }
  if (toolName !== 'run_command') return false;
  const action = String(args.action || '').toLowerCase();
  if (action === 'check' || action === 'list' || action === 'stop') return false;
  if (args.background === true) return false;
  return true;
}

export async function listWorkspaceFileInventory(workspaceRoot: string): Promise<WorkspaceFileInventory> {
  const out: WorkspaceFileInventory = new Map();
  const root = path.resolve(workspaceRoot);

  const walk = async (dir: string): Promise<void> => {
    if (out.size >= MAX_INVENTORY_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.size >= MAX_INVENTORY_FILES) return;
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(abs);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!rel || rel.startsWith('..')) continue;
        out.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* skip */
      }
    }
  };

  await walk(root);
  return out;
}

export function rememberPreCommandInventory(
  sessionId: string,
  toolCallId: string,
  inventory: WorkspaceFileInventory,
): void {
  if (!sessionId || !toolCallId) return;
  preCommandInventories.set(inventoryKey(sessionId, toolCallId), inventory);
}

export function takePreCommandInventory(
  sessionId: string,
  toolCallId: string,
): WorkspaceFileInventory | undefined {
  const key = inventoryKey(sessionId, toolCallId);
  const inv = preCommandInventories.get(key);
  preCommandInventories.delete(key);
  return inv;
}

export function diffInventoryTouchedPaths(
  workspaceRoot: string,
  before: WorkspaceFileInventory,
  after: WorkspaceFileInventory,
): { created: string[]; changed: string[]; deleted: string[] } {
  const created: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  const remap = (rel: string) => remapPathToWorkspace(workspaceRoot, rel) ?? rel;

  for (const [rel, info] of after) {
    const key = remap(rel);
    const prev = before.get(rel) ?? before.get(key);
    if (!prev) created.push(key);
    else if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) changed.push(key);
  }
  for (const rel of before.keys()) {
    const key = remap(rel);
    if (!after.has(rel) && !after.has(key)) deleted.push(key);
  }
  return { created, changed, deleted };
}
