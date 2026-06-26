/**
 * 原子写工具：写临时文件 + rename 覆盖目标。
 *
 * 进程在写大文件（MEMORY.md / dream 状态 / 召回元数据等）中途崩溃时，
 * 直接 `fs.writeFile` 会留下半截损坏文件；rename 在同一文件系统上是原子操作，
 * 要么旧内容、要么完整新内容，避免文件损坏（P1-14）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}
