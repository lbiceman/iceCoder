/**
 * npm 包与 Electron 共用的「壳身份」目录。
 * 与 Electron productName=iceCoder 的默认 userData 对齐（Windows %APPDATA%/iceCoder）。
 * 数据目录指针、默认工作区写在这里；业务数据仍在 ICE_DATA_DIR（默认 ~/.iceCoder）。
 *
 * 悬浮冰豆坐标等纯展现状态仍只存在 Electron userData，不放这里。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHELL_APP_NAME = 'iceCoder';
export const DATA_DIR_FILE = 'data-directory.json';
export const WORKSPACE_FILE = 'workspace.json';

/** 历史 Electron userData 名（setName / 未打包 package.json name），读取时兼容。 */
const LEGACY_SHELL_DIR_NAMES = ['iceCoder消息', 'icecoder-desktop'] as const;

export function resolveAppDataDir(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA?.trim()
      || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), '.config');
}

/** 当前写入用的共享目录（%APPDATA%/iceCoder 等）。 */
export function resolveSharedShellDir(): string {
  const override = process.env.ICE_SHELL_IDENTITY_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveAppDataDir(), SHELL_APP_NAME);
}

export function listSharedShellDirCandidates(): string[] {
  const override = process.env.ICE_SHELL_IDENTITY_DIR?.trim();
  if (override) return [path.resolve(override)];
  const appData = resolveAppDataDir();
  return [...new Set([
    path.join(appData, SHELL_APP_NAME),
    ...LEGACY_SHELL_DIR_NAMES.map((name) => path.join(appData, name)),
  ])];
}

function shouldScanRealShellDirs(): boolean {
  if (process.env.ICE_SHELL_IDENTITY_DIR?.trim()) return true;
  // 单测默认不碰本机 AppData，避免开发者自定义数据目录污染断言
  if (process.env.VITEST === 'true') return false;
  return true;
}

function readJsonFile(file: string): unknown | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function parseAbsoluteDir(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return path.resolve(trimmed);
}

function parseExistingAbsoluteDir(raw: unknown): string | null {
  const resolved = parseAbsoluteDir(raw);
  if (!resolved) return null;
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

/** 用户选定的 iceCoder 数据目录；未设置时返回 null（调用方回退 ~/.iceCoder）。 */
export function readPersistedDataDirectory(): string | null {
  if (!shouldScanRealShellDirs()) return null;
  for (const dir of listSharedShellDirCandidates()) {
    const file = path.join(dir, DATA_DIR_FILE);
    if (!fs.existsSync(file)) continue;
    const raw = readJsonFile(file) as { dataDir?: unknown } | null;
    if (!raw || typeof raw !== 'object' || !('dataDir' in raw)) continue;
    return parseAbsoluteDir(raw.dataDir);
  }
  return null;
}

/** 保存数据目录指针；传 null 恢复默认 ~/.iceCoder。 */
export function writePersistedDataDirectory(dataDir: string | null): void {
  const normalized = dataDir?.trim();
  if (normalized && !path.isAbsolute(normalized)) {
    throw new Error('数据目录必须是绝对路径');
  }
  writeJsonFile(
    path.join(resolveSharedShellDir(), DATA_DIR_FILE),
    { dataDir: normalized ? path.resolve(normalized) : null },
  );
}

/** 用户选定的默认工作区（必须是已存在的目录）。 */
export function readPersistedWorkspace(): string | null {
  if (!shouldScanRealShellDirs()) return null;
  for (const dir of listSharedShellDirCandidates()) {
    const file = path.join(dir, WORKSPACE_FILE);
    if (!fs.existsSync(file)) continue;
    const raw = readJsonFile(file) as { workspace?: unknown } | null;
    if (!raw || typeof raw !== 'object' || !('workspace' in raw)) continue;
    return parseExistingAbsoluteDir(raw.workspace);
  }
  return null;
}

export function writePersistedWorkspace(workspace: string | null): void {
  const resolved = workspace?.trim() ? path.resolve(workspace.trim()) : null;
  if (resolved && !path.isAbsolute(resolved)) {
    throw new Error('工作区必须是绝对路径');
  }
  writeJsonFile(
    path.join(resolveSharedShellDir(), WORKSPACE_FILE),
    { workspace: resolved },
  );
}

/**
 * 与 Electron resolveServerCwd + 已保存工作区对齐：
 * 有效 workspace.json → 数据目录（若存在）→ 用户主目录。
 */
export function resolveSharedDefaultWorkDir(dataDir: string): string {
  const workspace = readPersistedWorkspace();
  if (workspace) return workspace;
  try {
    if (fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()) return path.resolve(dataDir);
  } catch {
    // ignore
  }
  return os.homedir();
}
