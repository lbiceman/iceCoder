/**
 * Shell 子进程启动环境。
 *
 * Electron / 精简 PATH 场景下，process.env.PATH 可能不含 System32，
 * 导致 spawn("cmd.exe") 报 ENOENT。此处补全系统目录并用绝对路径解析 shell。
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

function windowsSystemRoot(): string {
  return (process.env.SystemRoot || process.env.windir || 'C:\\Windows').trim();
}

/** Windows 常见用户工具安装目录（Git 等，非系统内置）。 */
export function standardWindowsUserToolDirs(): string[] {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return [
    path.join(programFiles, 'Git', 'cmd'),
    path.join(programFilesX86, 'Git', 'cmd'),
    path.join(localAppData, 'Programs', 'Git', 'cmd'),
  ];
}

/** Windows 上 spawn 子命令时常用的系统目录（不含用户 Node/git 等）。 */
export function standardWindowsPathDirs(): string[] {
  const root = windowsSystemRoot();
  return [
    path.join(root, 'System32'),
    path.join(root, 'SysWOW64'),
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    root,
  ];
}

/**
 * 为 run_command / MCP 等子进程前置 Windows 系统目录，避免 PATH 被裁剪后找不到 cmd/git 等。
 */
export function augmentPathForShellSpawn(basePath: string | undefined): string {
  const current = basePath ?? process.env.PATH ?? '';
  if (process.platform !== 'win32') return current;

  const merged = [
    ...standardWindowsPathDirs(),
    ...standardWindowsUserToolDirs(),
    ...current.split(PATH_SEP),
  ].map((p) => p.trim()).filter(Boolean);

  return [...new Set(merged)].join(PATH_SEP);
}

/**
 * 解析 Windows cmd 可执行文件的绝对路径（不依赖 PATH 查找）。
 * 优先级：COMSPEC → %SystemRoot%\\System32\\cmd.exe → 字面量 cmd.exe。
 */
export function resolveWindowsShellExecutable(): string {
  const comspec = process.env.COMSPEC?.trim();
  if (comspec && existsSync(comspec)) return comspec;

  const cmdPath = path.join(windowsSystemRoot(), 'System32', 'cmd.exe');
  if (existsSync(cmdPath)) return cmdPath;

  return 'cmd.exe';
}

/** 跨平台解析默认 shell 可执行文件路径。 */
export function resolveShellExecutable(): string {
  if (process.platform === 'win32') {
    return resolveWindowsShellExecutable();
  }
  const shell = process.env.SHELL?.trim();
  if (shell && existsSync(shell)) return shell;
  return '/bin/sh';
}

/**
 * 解析 Windows 系统工具绝对路径（taskkill / powershell / where / reg 等）。
 * 在 augmentPathForShellSpawn 后的 PATH 中查找，再回退 System32。
 */
export function resolveWindowsSystemExecutable(baseName: string): string {
  if (process.platform !== 'win32') return baseName;

  const names = baseName.toLowerCase().endsWith('.exe')
    ? [baseName]
    : [`${baseName}.exe`, `${baseName}.cmd`, baseName];

  const searchDirs = augmentPathForShellSpawn(process.env.PATH).split(PATH_SEP);
  for (const dir of searchDirs) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = path.join(trimmed, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  const root = windowsSystemRoot();
  for (const sub of ['System32', path.join('System32', 'WindowsPowerShell', 'v1.0'), 'SysWOW64']) {
    for (const name of names) {
      const candidate = path.join(root, sub, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return names[0];
}

/**
 * 进程启动时补全 PATH（仅 Windows）。
 * 修复宿主进程内 execFileSync('taskkill')、spawnSync('where') 等同样 ENOENT 的问题。
 */
export function applyWindowsPathDefaults(): void {
  if (process.platform !== 'win32') return;
  const augmented = augmentPathForShellSpawn(process.env.PATH);
  if (augmented !== process.env.PATH) {
    process.env.PATH = augmented;
  }
}
