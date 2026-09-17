/**
 * run_command / shell_exec 造成的工作区变动：命令解析 + 执行前后清单对比。
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { remapPathToWorkspace } from './workspace-snapshot.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'release',
  'releases',
  'runtime',
  'target',
  'bin',
  'obj',
  'artifacts',
  'tmp',
  'temp',
  '.cache',
  '.turbo',
  '.nx',
  '.gradle',
  '.venv',
  'venv',
  '.ice',
  '__pycache__',
  '.next',
  'vendor',
]);

export interface WorkspaceFileInventory extends Map<string, {
  size: number;
  mtimeMs: number;
  contentHash: string;
}> {
  /** false 表示扫描期间至少一个目录或候选文件无法读取。 */
  complete: boolean;
}

const preCommandInventories = new Map<string, WorkspaceFileInventory>();
interface BackgroundInventoryEntry {
  inventory: WorkspaceFileInventory;
  expiresAt: number;
}

export const WORKSPACE_CONTENT_HASH_MAX_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_CONTENT_HASH_CACHE_LIMIT = 512;
export const BACKGROUND_INVENTORY_LIMIT = 128;
export const BACKGROUND_INVENTORY_TTL_MS = 5 * 60_000;

const backgroundCommandInventories = new Map<string, BackgroundInventoryEntry>();
const contentHashCache = new Map<string, {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  contentHash: string;
}>();

function inventoryKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

function backgroundInventoryKey(sessionId: string, taskId: string): string {
  return `${sessionId}:background:${taskId}`;
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
  return true;
}

export async function listWorkspaceFileInventory(workspaceRoot: string): Promise<WorkspaceFileInventory> {
  const out = Object.assign(new Map(), { complete: true }) as WorkspaceFileInventory;
  const root = path.resolve(workspaceRoot);
  const files: Array<{ abs: string; rel: string }> = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      out.complete = false;
      return;
    }
    for (const entry of entries) {
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
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) continue;
      files.push({ abs, rel });
    }
  };

  await walk(root);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(32, files.length) },
    async () => {
      while (nextIndex < files.length) {
        const file = files[nextIndex++]!;
        try {
          const stat = await fs.stat(file.abs);
          const cached = takeCachedContentHash(file.abs, stat);
          const contentHash = stat.size > WORKSPACE_CONTENT_HASH_MAX_BYTES
            ? `metadata:${stat.size}:${stat.mtimeMs}`
            : cached ?? createHash('sha256').update(await fs.readFile(file.abs)).digest('hex');
          rememberCachedContentHash(file.abs, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            contentHash,
          });
          out.set(file.rel, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            contentHash,
          });
        } catch {
          out.complete = false;
        }
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function takeCachedContentHash(
  filePath: string,
  stat: Pick<import('node:fs').Stats, 'size' | 'mtimeMs' | 'ctimeMs'>,
): string | null {
  const cached = contentHashCache.get(filePath);
  if (
    !cached
    || cached.size !== stat.size
    || cached.mtimeMs !== stat.mtimeMs
    || cached.ctimeMs !== stat.ctimeMs
  ) {
    return null;
  }
  contentHashCache.delete(filePath);
  contentHashCache.set(filePath, cached);
  return cached.contentHash;
}

function rememberCachedContentHash(
  filePath: string,
  entry: {
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    contentHash: string;
  },
): void {
  contentHashCache.delete(filePath);
  contentHashCache.set(filePath, entry);
  while (contentHashCache.size > WORKSPACE_CONTENT_HASH_CACHE_LIMIT) {
    const oldest = contentHashCache.keys().next().value as string | undefined;
    if (!oldest) break;
    contentHashCache.delete(oldest);
  }
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

export function rememberBackgroundCommandInventory(
  sessionId: string,
  taskId: string,
  inventory: WorkspaceFileInventory,
  nowMs = Date.now(),
): void {
  if (!sessionId || !taskId) return;
  purgeExpiredBackgroundInventories(nowMs);
  const key = backgroundInventoryKey(sessionId, taskId);
  backgroundCommandInventories.delete(key);
  while (backgroundCommandInventories.size >= BACKGROUND_INVENTORY_LIMIT) {
    const oldest = backgroundCommandInventories.keys().next().value as string | undefined;
    if (!oldest) break;
    backgroundCommandInventories.delete(oldest);
  }
  backgroundCommandInventories.set(key, {
    inventory,
    expiresAt: nowMs + BACKGROUND_INVENTORY_TTL_MS,
  });
}

export function takeBackgroundCommandInventory(
  sessionId: string,
  taskId: string,
  nowMs = Date.now(),
): WorkspaceFileInventory | undefined {
  purgeExpiredBackgroundInventories(nowMs);
  const key = backgroundInventoryKey(sessionId, taskId);
  const entry = backgroundCommandInventories.get(key);
  backgroundCommandInventories.delete(key);
  return entry?.inventory;
}

function purgeExpiredBackgroundInventories(nowMs: number): void {
  for (const [key, entry] of backgroundCommandInventories) {
    if (entry.expiresAt <= nowMs) backgroundCommandInventories.delete(key);
  }
}

export function getWorkspaceInventoryDiagnostics(): {
  contentHashCacheSize: number;
  backgroundInventorySize: number;
} {
  return {
    contentHashCacheSize: contentHashCache.size,
    backgroundInventorySize: backgroundCommandInventories.size,
  };
}

export function diffInventoryTouchedPaths(
  workspaceRoot: string,
  before: WorkspaceFileInventory,
  after: WorkspaceFileInventory,
): { created: string[]; changed: string[]; deleted: string[]; incomplete: boolean } {
  const created: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  const remap = (rel: string) => remapPathToWorkspace(workspaceRoot, rel) ?? rel;

  for (const [rel, info] of after) {
    const key = remap(rel);
    const prev = before.get(rel) ?? before.get(key);
    if (!prev) created.push(key);
    else if (prev.size !== info.size || prev.contentHash !== info.contentHash) changed.push(key);
  }
  for (const rel of before.keys()) {
    const key = remap(rel);
    if (!after.has(rel) && !after.has(key)) deleted.push(key);
  }
  return {
    created,
    changed,
    deleted,
    incomplete: before.complete !== true || after.complete !== true,
  };
}
