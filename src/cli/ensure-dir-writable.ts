/**
 * 数据目录写入权限探测与修复（主要针对 Windows 桌面安装包场景）。
 *
 * 部分 Win10/Win11 机器上 `~/.iceCoder` 或用户自定义数据目录继承的 ACL 不含「完全控制」，
 * 导致 atomic-write 的 rename 覆盖已有文件时抛出 EPERM。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function currentWindowsPrincipal(): string {
  const username = os.userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

/**
 * 探测目录是否支持「写临时文件 → rename 覆盖已有文件」，与 atomic-write 行为一致。
 */
export async function probeDirAtomicWrite(dir: string): Promise<boolean> {
  const target = path.join(dir, `.write-probe-${randomUUID()}.json`);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(target, '{}\n', 'utf-8');
    await fs.writeFile(tmp, '{"ok":true}\n', 'utf-8');
    await fs.rename(tmp, target);
    return true;
  } catch {
    return false;
  } finally {
    await fs.unlink(tmp).catch(() => {});
    await fs.unlink(target).catch(() => {});
  }
}

async function grantCurrentUserFullControlWin(dir: string, recursive: boolean): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const principal = currentWindowsPrincipal();
  const args = [dir, '/grant', `${principal}:(OI)(CI)F`];
  if (recursive) args.push('/T');
  await execFileAsync('icacls', args, { windowsHide: true });
}

export class DataDirPermissionError extends Error {
  readonly dataDir: string;

  constructor(dataDir: string, cause?: unknown) {
    const principal =
      process.platform === 'win32' ? currentWindowsPrincipal() : os.userInfo().username;
    super(
      `数据目录无写入权限：${dataDir}。请在资源管理器中右键该文件夹 → 属性 → 安全，为当前用户授予「完全控制」${
        process.platform === 'win32'
          ? `；或在命令行执行：icacls "${dataDir}" /grant "${principal}:(OI)(CI)F" /T`
          : ''
      }`,
    );
    this.name = 'DataDirPermissionError';
    this.dataDir = dataDir;
    if (cause instanceof Error) this.cause = cause;
  }
}

/**
 * 确保目录对当前进程可写（含 atomic rename）。
 * Windows 上若探测失败会尝试 icacls 为当前用户授予完全控制（先当前目录，再递归子项）。
 */
export async function ensureDirWritable(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  if (await probeDirAtomicWrite(dir)) return;

  if (process.platform === 'win32') {
    for (const recursive of [false, true]) {
      try {
        await grantCurrentUserFullControlWin(dir, recursive);
      } catch {
        // icacls 可能因策略/权限不足失败，继续尝试探测
      }
      if (await probeDirAtomicWrite(dir)) return;
    }
  }

  throw new DataDirPermissionError(dir);
}
