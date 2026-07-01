/**
 * MCP 子进程命令解析。
 *
 * 桌面端（Electron）子进程的 PATH 常不含 Node/npm，导致 mcp.json 里 `npx`/`uvx`
 * 条目 spawn ENOENT；mockplus 等使用绝对路径的条目不受影响。
 *
 * 对 `npx -y @scope/pkg`：若安装包内已有对应 node_modules，则直接用 node（或 Electron
 * 内嵌 Node）启动 bin，无需系统 npx。
 */

import { accessSync, constants, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { MCPServerConfig } from './types.js';
import { isElectronRuntime } from '../cli/paths.js';

const PATH_SEP = process.platform === 'win32' ? ';' : ':';
const NODE_EXE_NAMES = process.platform === 'win32'
  ? ['node.exe', 'node.cmd', 'node']
  : ['node'];

export interface McpSpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** 日志用：是否由 bundled 包直连启动 */
  launchMode?: 'npx' | 'bundled' | 'direct';
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function dirHasNode(dir: string): boolean {
  if (!dir) return false;
  return NODE_EXE_NAMES.some((n) => fileExists(path.join(dir, n)));
}

/** 常见 Node 安装目录（纯静态，不做运行时探测，避免递归）。 */
function standardNodeDirs(): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return [
      path.join(programFiles, 'nodejs'),
      path.join(programFilesX86, 'nodejs'),
      path.join(localAppData, 'Programs', 'nodejs'),
      path.join(appData, 'npm'),
      path.join(localAppData, 'Microsoft', 'WindowsApps'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  }
  return ['/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local', 'bin')];
}

/** 通过 where/which 探测系统 node（覆盖登录 shell PATH 中的非标准安装位置）。 */
function probeNodeDirViaWhich(): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(cmd, ['node'], { encoding: 'utf-8', timeout: 4000, windowsHide: true });
    if (res.status === 0 && typeof res.stdout === 'string') {
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && fileExists(first)) return path.dirname(first);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Windows 注册表兜底：Node MSI 安装会写 `SOFTWARE\Node.js\InstallPath`。
 * 覆盖「装到非标准盘（如 H:\）且 PATH 未刷新 / App 未重启」的场景。
 */
function probeNodeDirViaWinRegistry(): string | null {
  if (process.platform !== 'win32') return null;
  const keys = [
    'HKLM\\SOFTWARE\\Node.js',
    'HKCU\\SOFTWARE\\Node.js',
    'HKLM\\SOFTWARE\\WOW6432Node\\Node.js',
  ];
  for (const key of keys) {
    try {
      const res = spawnSync('reg', ['query', key, '/v', 'InstallPath'], {
        encoding: 'utf-8',
        timeout: 4000,
        windowsHide: true,
      });
      if (res.status === 0 && typeof res.stdout === 'string') {
        const m = res.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/i);
        if (m) {
          const dir = m[1].trim();
          if (dirHasNode(dir)) return dir;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

let cachedNodeDir: string | null | undefined;

/**
 * 探测系统真实 Node 所在目录（带缓存）。
 * 优先级：ICE_MCP_NODE_DIR/ICE_NODE_DIR → 当前进程即 node → 扫描 PATH+标准目录 → where/which。
 * 返回 null 表示未找到系统 Node（此时可回退到 Electron 内嵌 Node）。
 */
export function detectNodeDir(basePath: string | undefined = process.env.PATH): string | null {
  if (cachedNodeDir !== undefined) return cachedNodeDir;
  cachedNodeDir = resolveNodeDirUncached(basePath);
  if (cachedNodeDir) {
    console.log(`[mcp] 已定位系统 Node 目录: ${cachedNodeDir}`);
  }
  return cachedNodeDir;
}

/** 测试用：清空探测缓存。 */
export function resetNodeDirCache(): void {
  cachedNodeDir = undefined;
}

function resolveNodeDirUncached(basePath: string | undefined): string | null {
  // 1. 显式覆盖（桌面主进程可通过 ICE_NODE_DIR 转发已定位的目录）
  const envDir = (process.env.ICE_MCP_NODE_DIR || process.env.ICE_NODE_DIR || '').trim();
  if (envDir && dirHasNode(envDir)) return envDir;

  // 2. 当前进程本身就是 node（dev / CLI / 全局安装场景）
  const execBase = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase();
  if (execBase === 'node') return path.dirname(process.execPath);

  // 3. 扫描 PATH + 标准安装目录
  const scanDirs = [
    ...(basePath ?? '').split(PATH_SEP),
    ...standardNodeDirs(),
  ].map((s) => s.trim()).filter(Boolean);
  for (const dir of scanDirs) {
    if (dirHasNode(dir)) return dir;
  }

  // 4. where/which 兜底（非标准安装位置，如 D:\tools\node16）
  const viaWhich = probeNodeDirViaWhich();
  if (viaWhich) return viaWhich;

  // 5. Windows 注册表兜底（PATH 未刷新 / App 未重启，或装到 H:\ 等）
  return probeNodeDirViaWinRegistry();
}

/** 为 MCP spawn 追加 Node/npm/uv 目录（含探测到的真实 Node 目录）。 */
export function augmentPathForMcpSpawn(basePath: string | undefined): string {
  const nodeDir = detectNodeDir(basePath);
  const extras: string[] = [
    ...(nodeDir ? [nodeDir] : []),
    ...standardNodeDirs(),
  ];

  const current = basePath ?? process.env.PATH ?? '';
  const merged = [...extras, ...current.split(PATH_SEP)].map((p) => p.trim()).filter(Boolean);
  return [...new Set(merged)].join(PATH_SEP);
}

function findOnPath(commandNames: string[], pathValue: string): string | null {
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathValue.split(sep)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of commandNames) {
      const candidate = path.join(trimmed, name);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 将 mcp.json 中的 command 解析为可 spawn 的路径。
 * Windows 上 `npx` → `npx.cmd`（并在扩展 PATH 中查找）。
 */
export function resolveMcpCommand(command: string, pathEnv?: string): string {
  const base = path.basename(command, path.extname(command)).toLowerCase();
  const searchPath = augmentPathForMcpSpawn(pathEnv ?? process.env.PATH);

  if (process.platform === 'win32') {
    if (base === 'npx') {
      return findOnPath(['npx.cmd', 'npx.exe', 'npx'], searchPath) ?? 'npx.cmd';
    }
    if (base === 'npm') {
      return findOnPath(['npm.cmd', 'npm.exe', 'npm'], searchPath) ?? 'npm.cmd';
    }
    if (base === 'node') {
      return findOnPath(['node.exe', 'node.cmd', 'node'], searchPath) ?? command;
    }
    if (base === 'uvx') {
      return findOnPath(['uvx.exe', 'uvx.cmd', 'uvx.bat', 'uvx'], searchPath) ?? 'uvx.exe';
    }
    if (base === 'uv') {
      return findOnPath(['uv.exe', 'uv.cmd', 'uv.bat', 'uv'], searchPath) ?? command;
    }
  }

  if (base === 'npx' || base === 'uvx') {
    const names = base === 'npx' ? ['npx'] : ['uvx'];
    return findOnPath(names, searchPath) ?? command;
  }

  return command;
}

/** 从 `npx -y @scope/pkg` 参数中提取包名。 */
export function extractNpxPackageName(args: string[] | undefined): string | null {
  if (!args?.length) return null;
  for (const raw of args) {
    const token = raw.trim();
    if (!token || token === '-y' || token === '--yes') continue;
    if (token.startsWith('-')) continue;
    return token.replace(/@latest$/i, '');
  }
  return null;
}

/** 由探测到的 Node 目录推导的全局 npm node_modules 候选根。 */
function globalNodeModulesRoots(): string[] {
  const roots: string[] = [];
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  const nodeDir = detectNodeDir();
  if (nodeDir) {
    roots.push(path.join(nodeDir, 'node_modules'));
    roots.push(path.join(nodeDir, '..', 'lib', 'node_modules'));
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  roots.push(path.join(os.homedir(), '.npm-global', 'node_modules'));
  return roots;
}

function resolveNodeModulesRoots(): string[] {
  const roots: string[] = [];
  // 1. 安装包内（优先，离线可用）
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  roots.push(path.resolve(moduleDir, '../../node_modules'));
  if (process.env.ICE_SERVER_ROOT?.trim()) {
    roots.push(path.join(path.resolve(process.env.ICE_SERVER_ROOT.trim()), 'node_modules'));
  }
  // 2. 系统全局 npm（用户已 npm i -g 的场景）
  roots.push(...globalNodeModulesRoots());
  return [...new Set(roots)];
}

function resolvePackageEntry(packageName: string, nodeModulesRoot: string): string | null {
  const pkgDir = path.join(nodeModulesRoot, ...packageName.split('/'));
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fileExists(pkgJsonPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
      main?: string;
    };
    const binRel = typeof pkg.bin === 'string'
      ? pkg.bin
      : pkg.bin && typeof pkg.bin === 'object'
        ? Object.values(pkg.bin)[0]
        : undefined;
    const candidates = [
      binRel ? path.join(pkgDir, binRel) : null,
      pkg.main ? path.join(pkgDir, pkg.main) : null,
      path.join(pkgDir, 'dist', 'index.js'),
    ].filter((p): p is string => !!p);

    for (const entry of candidates) {
      if (fileExists(entry)) return entry;
    }
  } catch {
    return null;
  }
  return null;
}

/** 在安装包或系统全局 node_modules 中查找 MCP 包入口（用于免 npx 直连启动）。 */
export function findMcpPackageEntry(packageName: string): string | null {
  for (const root of resolveNodeModulesRoots()) {
    const entry = resolvePackageEntry(packageName, root);
    if (entry) return entry;
  }
  return null;
}

/** 兼容旧名。 */
export const findBundledMcpPackageEntry = findMcpPackageEntry;

/**
 * 解析 MCP spawn 用的 Node 可执行文件。
 * 优先使用探测到的系统 Node；找不到时（无系统 Node）回退到 Electron 内嵌 Node。
 */
export function resolveNodeForMcp(pathEnv?: string): string {
  const nodeDir = detectNodeDir(pathEnv ?? process.env.PATH);
  if (nodeDir) {
    for (const n of NODE_EXE_NAMES) {
      const p = path.join(nodeDir, n);
      if (fileExists(p)) return p;
    }
  }
  if (isElectronRuntime() || process.env.ELECTRON_RUN_AS_NODE === '1') {
    return process.execPath;
  }
  return 'node';
}

function isNpxLike(command: string): boolean {
  const base = path.basename(command, path.extname(command)).toLowerCase();
  return base === 'npx';
}

/**
 * 解析 MCP Server 的完整 spawn 计划。
 *
 * 对 `npx -y @scope/pkg`：先探测系统真实 Node 地址，并在「安装包内 / 系统全局」
 * node_modules 里定位该包入口，然后用「探测到的 Node（或 Electron 内嵌 Node）」
 * 直接启动入口脚本——不依赖 npx 在 PATH 中、也不在 mcp.json 写死绝对路径。
 * 仅当找不到已安装的包时，才回退到解析 npx 命令本身。
 */
export function resolveMcpServerLaunch(config: MCPServerConfig): McpSpawnPlan {
  let { command, args = [], env = {} } = config;
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  spawnEnv.PATH = augmentPathForMcpSpawn(spawnEnv.PATH);

  const cwd = (config as MCPServerConfig & { cwd?: string }).cwd;

  if (isNpxLike(command)) {
    const packageName = extractNpxPackageName(args);
    if (packageName) {
      const entry = findMcpPackageEntry(packageName);
      if (entry) {
        const nodeBin = resolveNodeForMcp(spawnEnv.PATH);
        if (nodeBin === process.execPath) {
          spawnEnv.ELECTRON_RUN_AS_NODE = '1';
        }
        // npx 的其余参数（去掉 -y/--yes 与包名，保留业务参数）透传给入口脚本
        const passthrough = stripNpxPackageArgs(args, packageName);
        return {
          command: nodeBin,
          args: [entry, ...passthrough],
          env: spawnEnv,
          cwd,
          launchMode: 'bundled',
        };
      }
    }
  }

  command = resolveMcpCommand(command, spawnEnv.PATH);
  return {
    command,
    args,
    env: spawnEnv,
    cwd,
    launchMode: isNpxLike(config.command) ? 'npx' : 'direct',
  };
}

/** 去掉 npx 的 `-y/--yes` 与包名 token，保留传给 MCP 入口的业务参数。 */
function stripNpxPackageArgs(args: string[], packageName: string): string[] {
  const out: string[] = [];
  let removedPkg = false;
  for (const raw of args) {
    const token = raw.trim();
    if (token === '-y' || token === '--yes') continue;
    if (!removedPkg && token.replace(/@latest$/i, '') === packageName) {
      removedPkg = true;
      continue;
    }
    out.push(raw);
  }
  return out;
}
