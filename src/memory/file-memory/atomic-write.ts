/**
 * 原子写工具：写临时文件 + rename 覆盖目标。
 *
 * 进程在写大文件（MEMORY.md / dream 状态 / 召回元数据等）中途崩溃时，
 * 直接 `fs.writeFile` 会留下半截损坏文件；rename 在同一文件系统上是原子操作，
 * 要么旧内容、要么完整新内容，避免文件损坏（P1-14）。
 */

/**
 * 原子写工具：写临时文件 + rename 覆盖目标。
 *
 * 进程在写大文件（MEMORY.md / dream 状态 / 召回元数据等）中途崩溃时，
 * 直接 `fs.writeFile` 会留下半截损坏文件；rename 在同一文件系统上是原子操作，
 * 要么旧内容、要么完整新内容，避免文件损坏（P1-14）。
 *
 * Windows：若目标文件 ACL/只读导致 rename 失败（EPERM），会先 unlink 再重试。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function isWindowsRenameRetryable(code: string | undefined): boolean {
  return code === 'EPERM' || code === 'EACCES' || code === 'EEXIST' || code === 'EBUSY';
}

/**
 * rename 覆盖目标文件。Windows 上若 ACL 不足或目标只读，先清除只读再 unlink 后重试。
 */
async function renameOverwrite(tmp: string, filePath: string): Promise<void> {
  try {
    await fs.rename(tmp, filePath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !isWindowsRenameRetryable(code)) {
      throw err;
    }
    await fs.chmod(filePath, 0o666).catch(() => {});
    await fs.unlink(filePath).catch((unlinkErr: NodeJS.ErrnoException) => {
      if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
    });
    await fs.rename(tmp, filePath);
  }
}

/**
 * 原子写入文本/二进制内容到 `filePath`。
 * 先写入同目录下的唯一临时文件，再 rename 覆盖目标；失败时清理临时文件并抛出。
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  encoding: BufferEncoding = 'utf-8',
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    if (typeof data === 'string') {
      await fs.writeFile(tmp, data, encoding);
    } else {
      await fs.writeFile(tmp, data);
    }
    await renameOverwrite(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
