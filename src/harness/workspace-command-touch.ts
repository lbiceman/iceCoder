/**
 * run_command / shell_exec 造成的工作区变动：命令解析 + 执行前后清单对比。
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

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
  ctimeMs: number;
  contentHash: string;
}> {
  /** false 表示扫描期间至少一个目录或候选文件无法读取。 */
  complete: boolean;
  /** 本次扫描实际读取文件内容的次数。元数据未变时为 0。 */
  contentReads: number;
  /**
   * 非空时清单只覆盖这些相对路径（命令能解析出的写入目标）。
   * 未设置表示全树扫描。前后两次对比必须使用同一范围。
   */
  scopeRelPaths?: string[];
}

export interface ListWorkspaceInventoryOptions {
  /** 元数据（size/mtime/ctime）未变时复用 contentHash，不再读文件。 */
  baseline?: WorkspaceFileInventory;
  /** 只扫描这些相对路径；为空则全树。 */
  scopeRelPaths?: readonly string[];
  /**
   * 不计入清单的绝对目录（如会话目录）。checkpoint / 工具输出落盘是 Harness 自己写的，
   * 会话目录在工作区内时，异步写入会被误判为命令改动了工作区。
   */
  excludeDirs?: readonly string[];
}

function normalizeDirKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsideExcludedDir(abs: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.size === 0) return false;
  let current = normalizeDirKey(abs);
  for (;;) {
    if (excluded.has(current)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

interface BackgroundInventoryEntry {
  inventory: WorkspaceFileInventory;
  expiresAt: number;
}

interface ContentHashEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  contentHash: string;
}

interface WorkspaceTouchState {
  preCommandInventories: Map<string, WorkspaceFileInventory>;
  backgroundCommandInventories: Map<string, BackgroundInventoryEntry>;
  contentHashCache: Map<string, ContentHashEntry>;
  lastFullInventory: { root: string; inventory: WorkspaceFileInventory } | null;
}

function emptyWorkspaceTouchState(): WorkspaceTouchState {
  return {
    preCommandInventories: new Map(),
    backgroundCommandInventories: new Map(),
    contentHashCache: new Map(),
    lastFullInventory: null,
  };
}

const workspaceTouchStorage = new AsyncLocalStorage<WorkspaceTouchState>();
/** 没有 run 作用域时的回退，给直接扫清单的测试用。 */
const fallbackWorkspaceTouch = emptyWorkspaceTouchState();

function currentWorkspaceTouch(): WorkspaceTouchState {
  return workspaceTouchStorage.getStore() ?? fallbackWorkspaceTouch;
}

/** 包住一次 run，命令清单和内容哈希不再跟其他会话共用。 */
export function runWithWorkspaceTouchScope<T>(fn: () => T): T {
  return workspaceTouchStorage.run(emptyWorkspaceTouchState(), fn);
}

export const WORKSPACE_CONTENT_HASH_MAX_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_CONTENT_HASH_CACHE_LIMIT = 512;
export const BACKGROUND_INVENTORY_LIMIT = 128;
/** 同一轮并行的 shell 类工具调用远少于此；超出说明有调用没走到 take（异常路径），按最旧淘汰。 */
export const PRE_COMMAND_INVENTORY_LIMIT = 32;
export const BACKGROUND_INVENTORY_TTL_MS = 5 * 60_000;

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

function emptyInventory(scopeRelPaths?: string[]): WorkspaceFileInventory {
  return Object.assign(new Map(), {
    complete: true,
    contentReads: 0,
    scopeRelPaths,
  }) as WorkspaceFileInventory;
}

function cloneInventory(source: WorkspaceFileInventory): WorkspaceFileInventory {
  const copy = emptyInventory(source.scopeRelPaths ? [...source.scopeRelPaths] : undefined);
  copy.complete = source.complete;
  for (const [rel, info] of source) copy.set(rel, { ...info });
  return copy;
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT';
}

function resolveScopePaths(root: string, relPaths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of relPaths) {
    const normalized = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.includes('\0')) continue;
    const abs = path.resolve(root, normalized);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const posix = rel.split(path.sep).join('/');
    if (seen.has(posix)) continue;
    seen.add(posix);
    out.push(posix);
  }
  return out;
}

async function recordInventoryFile(
  abs: string,
  rel: string,
  out: WorkspaceFileInventory,
  baseline: WorkspaceFileInventory | undefined,
  reads: { n: number },
  missingOk: boolean,
): Promise<void> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(abs);
  } catch (error) {
    if (missingOk && isEnoent(error)) return;
    out.complete = false;
    return;
  }
  if (!stat.isFile()) return;
  const prev = baseline?.get(rel);
  let contentHash: string;
  if (
    prev
    && prev.size === stat.size
    && prev.mtimeMs === stat.mtimeMs
    && prev.ctimeMs === stat.ctimeMs
  ) {
    contentHash = prev.contentHash;
  } else if (stat.size > WORKSPACE_CONTENT_HASH_MAX_BYTES) {
    contentHash = `metadata:${stat.size}:${stat.mtimeMs}`;
  } else {
    const cached = takeCachedContentHash(abs, stat);
    if (cached) {
      contentHash = cached;
    } else {
      reads.n += 1;
      contentHash = createHash('sha256').update(await fs.readFile(abs)).digest('hex');
    }
    rememberCachedContentHash(abs, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      contentHash,
    });
  }
  out.set(rel, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    contentHash,
  });
}

async function collectInventoryFiles(
  root: string,
  dir: string,
  out: WorkspaceFileInventory,
  excluded: ReadonlySet<string>,
): Promise<Array<{ abs: string; rel: string }>> {
  const files: Array<{ abs: string; rel: string }> = [];
  const walk = async (current: string): Promise<void> => {
    if (isInsideExcludedDir(current, excluded)) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      out.complete = false;
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.gitignore') {
        if (entry.isDirectory()) continue;
      }
      const abs = path.join(current, entry.name);
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
  await walk(dir);
  return files;
}

async function fillInventoryFiles(
  files: Array<{ abs: string; rel: string }>,
  out: WorkspaceFileInventory,
  baseline: WorkspaceFileInventory | undefined,
  reads: { n: number },
  missingOk: boolean,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(32, Math.max(1, files.length)) },
    async () => {
      while (nextIndex < files.length) {
        const file = files[nextIndex++]!;
        await recordInventoryFile(file.abs, file.rel, out, baseline, reads, missingOk);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * 工作区文件清单。
 * 能解析出写入路径时只扫描这些路径；否则全树遍历，但 size/mtime/ctime 未变的文件不读内容。
 */
export async function listWorkspaceFileInventory(
  workspaceRoot: string,
  options?: ListWorkspaceInventoryOptions,
): Promise<WorkspaceFileInventory> {
  const root = path.resolve(workspaceRoot);
  const resolvedScope = options?.scopeRelPaths?.length
    ? resolveScopePaths(root, options.scopeRelPaths)
    : [];
  const scope = resolvedScope.length > 0 ? resolvedScope : undefined;
  const touch = currentWorkspaceTouch();
  const baseline = options?.baseline
    ?? (!scope && touch.lastFullInventory?.root === root ? touch.lastFullInventory.inventory : undefined);
  const out = emptyInventory(scope);
  const reads = { n: 0 };
  const excluded = new Set((options?.excludeDirs ?? []).map(normalizeDirKey));

  if (scope) {
    const files: Array<{ abs: string; rel: string }> = [];
    for (const rel of scope) {
      const abs = path.join(root, ...rel.split('/'));
      if (isInsideExcludedDir(abs, excluded)) continue;
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(abs);
      } catch (error) {
        if (isEnoent(error)) continue;
        out.complete = false;
        continue;
      }
      if (stat.isDirectory()) {
        files.push(...await collectInventoryFiles(root, abs, out, excluded));
      } else if (stat.isFile()) {
        files.push({ abs, rel });
      }
    }
    await fillInventoryFiles(files, out, baseline, reads, true);
  } else {
    const files = await collectInventoryFiles(root, root, out, excluded);
    await fillInventoryFiles(files, out, baseline, reads, false);
    if (out.complete) touch.lastFullInventory = { root, inventory: cloneInventory(out) };
  }

  out.contentReads = reads.n;
  return out;
}

function takeCachedContentHash(
  filePath: string,
  stat: Pick<import('node:fs').Stats, 'size' | 'mtimeMs' | 'ctimeMs'>,
): string | null {
  const cache = currentWorkspaceTouch().contentHashCache;
  const cached = cache.get(filePath);
  if (
    !cached
    || cached.size !== stat.size
    || cached.mtimeMs !== stat.mtimeMs
    || cached.ctimeMs !== stat.ctimeMs
  ) {
    return null;
  }
  cache.delete(filePath);
  cache.set(filePath, cached);
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
  const cache = currentWorkspaceTouch().contentHashCache;
  cache.delete(filePath);
  cache.set(filePath, entry);
  while (cache.size > WORKSPACE_CONTENT_HASH_CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function rememberPreCommandInventory(
  sessionId: string,
  toolCallId: string,
  inventory: WorkspaceFileInventory,
): void {
  if (!sessionId || !toolCallId) return;
  const inventories = currentWorkspaceTouch().preCommandInventories;
  const key = inventoryKey(sessionId, toolCallId);
  inventories.delete(key);
  while (inventories.size >= PRE_COMMAND_INVENTORY_LIMIT) {
    const oldest = inventories.keys().next().value as string | undefined;
    if (!oldest) break;
    inventories.delete(oldest);
  }
  inventories.set(key, inventory);
}

/** 中断 / 异常时丢弃未被 take 的命令前快照。 */
export function discardPreCommandInventories(sessionId: string, toolCallIds: Iterable<string>): void {
  if (!sessionId) return;
  const inventories = currentWorkspaceTouch().preCommandInventories;
  for (const id of toolCallIds) inventories.delete(inventoryKey(sessionId, id));
}

export function takePreCommandInventory(
  sessionId: string,
  toolCallId: string,
): WorkspaceFileInventory | undefined {
  const key = inventoryKey(sessionId, toolCallId);
  const inventories = currentWorkspaceTouch().preCommandInventories;
  const inv = inventories.get(key);
  inventories.delete(key);
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
  const inventories = currentWorkspaceTouch().backgroundCommandInventories;
  const key = backgroundInventoryKey(sessionId, taskId);
  inventories.delete(key);
  while (inventories.size >= BACKGROUND_INVENTORY_LIMIT) {
    const oldest = inventories.keys().next().value as string | undefined;
    if (!oldest) break;
    inventories.delete(oldest);
  }
  inventories.set(key, {
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
  const inventories = currentWorkspaceTouch().backgroundCommandInventories;
  const entry = inventories.get(key);
  inventories.delete(key);
  return entry?.inventory;
}

function purgeExpiredBackgroundInventories(nowMs: number): void {
  const inventories = currentWorkspaceTouch().backgroundCommandInventories;
  for (const [key, entry] of inventories) {
    if (entry.expiresAt <= nowMs) inventories.delete(key);
  }
}

export function getWorkspaceInventoryDiagnostics(): {
  contentHashCacheSize: number;
  backgroundInventorySize: number;
  preCommandInventorySize: number;
} {
  const touch = currentWorkspaceTouch();
  return {
    contentHashCacheSize: touch.contentHashCache.size,
    backgroundInventorySize: touch.backgroundCommandInventories.size,
    preCommandInventorySize: touch.preCommandInventories.size,
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
