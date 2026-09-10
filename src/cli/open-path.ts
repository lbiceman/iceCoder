/**
 * 用操作系统默认关联程序打开本地路径（文件或目录）。
 * 不指定 IDE / 编辑器，交给系统文件关联处理。
 */

import { execFile } from 'node:child_process';

export type OpenPathExec = (command: string, args: string[]) => Promise<boolean>;

export function buildOpenPathInvocation(
  absPath: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    // start 的第一个引号参数是窗口标题；空标题后才是要打开的路径。
    return { command: 'cmd.exe', args: ['/c', 'start', '', absPath] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [absPath] };
  }
  return { command: 'xdg-open', args: [absPath] };
}

function defaultExec(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 8000 }, (err) => {
      resolve(!err);
    });
  });
}

/** 调用系统默认程序打开绝对路径；失败返回 false，不抛错。 */
export async function openPathWithDefaultApp(
  absPath: string,
  opts?: {
    platform?: NodeJS.Platform;
    execCommand?: OpenPathExec;
  },
): Promise<boolean> {
  const target = String(absPath || '').trim();
  if (!target || target.includes('\0') || target.includes('"')) return false;
  const invocation = buildOpenPathInvocation(target, opts?.platform ?? process.platform);
  const execCommand = opts?.execCommand ?? defaultExec;
  try {
    return await execCommand(invocation.command, invocation.args);
  } catch {
    return false;
  }
}
