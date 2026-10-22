/**
 * 定期清掉数据目录里过期的纯缓存：工具输出溢出文件、后台/交互 Shell 日志、MCP 截图、运行时 telemetry。
 * 会话消息、checkpoint、intent 归档、记忆一律不动。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const STORAGE_PRUNE_MAX_AGE_MS = {
  toolOutput: 7 * DAY_MS,
  taskLog: 7 * DAY_MS,
  mcpCache: 7 * DAY_MS,
  telemetry: 14 * DAY_MS,
} as const;

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TELEMETRY_FILE_RE = /\.telemetry\.jsonl(\.old)?$/;

export interface StoragePruneOptions {
  sessionsDir: string;
  mcpCacheDir?: string;
  /** `{dataDir}/runtime`：旧版所有会话共用的 telemetry.jsonl 落在这里 */
  runtimeDir?: string;
  now?: number;
}

export interface StoragePruneResult {
  files: number;
  bytes: number;
}

async function listDir(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function removeIfExpired(
  file: string,
  maxAgeMs: number,
  now: number,
  result: StoragePruneResult,
): Promise<void> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) return;
    await fs.unlink(file);
    result.files++;
    result.bytes += stat.size;
  } catch {
    /* 正在被写或已被删 */
  }
}

async function pruneFlatDir(
  dir: string,
  maxAgeMs: number,
  now: number,
  result: StoragePruneResult,
  match: (name: string) => boolean = () => true,
): Promise<void> {
  for (const entry of await listDir(dir)) {
    if (entry.isFile() && match(entry.name)) {
      await removeIfExpired(path.join(dir, entry.name), maxAgeMs, now, result);
    }
  }
}

/** 删 `dir/<子目录>/*` 里的过期文件，子目录清空后一并删掉。 */
async function prunePerOwnerDirs(
  dir: string,
  maxAgeMs: number,
  now: number,
  result: StoragePruneResult,
): Promise<void> {
  for (const entry of await listDir(dir)) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(dir, entry.name);
    await pruneFlatDir(sub, maxAgeMs, now, result);
    await fs.rmdir(sub).catch(() => {});
  }
}

export async function pruneExpiredStorage(opts: StoragePruneOptions): Promise<StoragePruneResult> {
  const now = opts.now ?? Date.now();
  const result: StoragePruneResult = { files: 0, bytes: 0 };
  const sessionsDir = path.resolve(opts.sessionsDir);
  const isTelemetry = (name: string) => TELEMETRY_FILE_RE.test(name);

  await prunePerOwnerDirs(path.join(sessionsDir, 'tool-output'), STORAGE_PRUNE_MAX_AGE_MS.toolOutput, now, result);
  await pruneFlatDir(sessionsDir, STORAGE_PRUNE_MAX_AGE_MS.telemetry, now, result, isTelemetry);

  for (const entry of await listDir(sessionsDir)) {
    if (!entry.isDirectory() || entry.name === 'tool-output') continue;
    const sessionSub = path.join(sessionsDir, entry.name);
    for (const logDir of ['bg', 'ish']) {
      const dir = path.join(sessionSub, logDir);
      await pruneFlatDir(dir, STORAGE_PRUNE_MAX_AGE_MS.taskLog, now, result);
      await fs.rmdir(dir).catch(() => {});
    }
    const agentsDir = path.join(sessionSub, 'agents');
    await prunePerOwnerDirs(path.join(agentsDir, 'tool-output'), STORAGE_PRUNE_MAX_AGE_MS.toolOutput, now, result);
    await pruneFlatDir(agentsDir, STORAGE_PRUNE_MAX_AGE_MS.telemetry, now, result, isTelemetry);
  }

  if (opts.mcpCacheDir) {
    await pruneFlatDir(opts.mcpCacheDir, STORAGE_PRUNE_MAX_AGE_MS.mcpCache, now, result);
  }
  if (opts.runtimeDir) {
    await removeIfExpired(path.join(opts.runtimeDir, 'telemetry.jsonl'), STORAGE_PRUNE_MAX_AGE_MS.telemetry, now, result);
  }
  return result;
}

/** 启动后立即跑一次，之后每 6 小时一次；返回停止函数。 */
export function startStoragePruneSchedule(opts: Omit<StoragePruneOptions, 'now'>): () => void {
  const run = () => {
    void pruneExpiredStorage(opts)
      .then(({ files, bytes }) => {
        if (files > 0) {
          console.log(`[storage-prune] 清理过期缓存 ${files} 个文件，释放 ${(bytes / 1024 / 1024).toFixed(1)}MB`);
        }
      })
      .catch((err) => console.warn('[storage-prune] 清理失败:', err instanceof Error ? err.message : err));
  };
  run();
  const timer = setInterval(run, PRUNE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
