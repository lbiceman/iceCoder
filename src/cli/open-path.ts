/**
 * 在系统文件管理器中打开所在文件夹并选中该文件。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type OpenPathExec = (command: string, args: string[]) => Promise<boolean>;

export interface RevealInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
  windowsHide?: boolean;
}

/** explorer.exe 按原始命令行解析 /select，路径里的反斜杠不能吃掉收尾引号。 */
export function sanitizeWindowsExplorerPath(absPath: string): string {
  let p = path.win32.normalize(absPath);
  while (p.endsWith('\\') && !/:[\\/]$/.test(p)) {
    p = p.slice(0, -1);
  }
  return p;
}

export function buildRevealInFolderInvocation(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): RevealInvocation {
  if (platform === 'win32') {
    const target = sanitizeWindowsExplorerPath(absPath);
    return {
      command: 'explorer.exe',
      args: [`/select,"${target}"`],
      windowsVerbatimArguments: true,
      windowsHide: false,
    };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: ['-R', absPath] };
  }
  const fileUrl = pathToFileURL(absPath).href;
  return {
    command: 'dbus-send',
    args: [
      '--session',
      '--dest=org.freedesktop.FileManager1',
      '--type=method_call',
      '/org/freedesktop/FileManager1',
      'org.freedesktop.FileManager1.ShowItems',
      `array:string:${fileUrl}`,
      'string:',
    ],
  };
}

export function buildRevealFolderFallbackInvocation(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): RevealInvocation {
  const dirname = platform === 'win32' ? path.win32.dirname : path.posix.dirname;
  return { command: 'xdg-open', args: [dirname(absPath)] };
}

function explorerSelectSucceeded(command: string, err: NodeJS.ErrnoException | null): boolean {
  if (!err) return true;
  // explorer.exe /select 选中文件后经常以数字退出码结束，但资源管理器已打开。
  return command === 'explorer.exe' && typeof err.code === 'number';
}

function defaultExec(invocation: RevealInvocation): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(invocation.command, invocation.args, {
      windowsHide: invocation.windowsHide ?? true,
      timeout: 8000,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
    }, (err) => {
      resolve(explorerSelectSucceeded(invocation.command, err as NodeJS.ErrnoException | null));
    });
  });
}

/** 打开所在文件夹并定位到该文件；失败返回 false，不抛错。 */
export async function revealPathInFolder(
  absPath: string,
  opts?: {
    platform?: NodeJS.Platform;
    execCommand?: OpenPathExec;
  },
): Promise<boolean> {
  const target = String(absPath || '').trim();
  if (!target || target.includes('\0') || target.includes('"')) return false;
  const platform = opts?.platform ?? process.platform;
  const invocation = buildRevealInFolderInvocation(target, platform);
  try {
    const run = opts?.execCommand
      ? (next: RevealInvocation) => opts.execCommand!(next.command, next.args)
      : defaultExec;
    if (await run(invocation)) return true;
    if (platform === 'win32' || platform === 'darwin') return false;
    const fallback = buildRevealFolderFallbackInvocation(target, platform);
    return await run(fallback);
  } catch {
    return false;
  }
}
