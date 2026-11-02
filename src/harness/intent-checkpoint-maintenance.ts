/**
 * 启动后在后台把各会话的旧格式 intent 归档（内联 / blobs-v1）转成当前格式并回收旧 blob。
 * 会话之间串行；单个会话失败只记日志，下次启动再试。
 */

import { promises as fs } from 'node:fs';

import {
  compressIntentCheckpointBlobs,
  migrateIntentCheckpointStorage,
} from './intent-checkpoint-store.js';

const INDEX_SUFFIX = '.checkpoint-index.json';
const START_DELAY_MS = 30_000;

export interface IntentCheckpointMaintenanceResult {
  sessions: number;
  converted: number;
  failed: number;
  savedBytes: number;
}

export async function runIntentCheckpointMaintenance(
  sessionsDir: string,
  shouldStop: () => boolean = () => false,
): Promise<IntentCheckpointMaintenanceResult> {
  const result: IntentCheckpointMaintenanceResult = { sessions: 0, converted: 0, failed: 0, savedBytes: 0 };
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (shouldStop()) break;
    if (!name.endsWith(INDEX_SUFFIX)) continue;
    const sessionId = name.slice(0, -INDEX_SUFFIX.length);
    if (!sessionId) continue;
    try {
      const migrated = await migrateIntentCheckpointStorage(sessionsDir, sessionId);
      result.sessions++;
      result.converted += migrated.converted;
      result.failed += migrated.failed;
      if (migrated.failed === 0) {
        result.savedBytes += await compressIntentCheckpointBlobs(sessionsDir, sessionId);
      }
    } catch (err) {
      result.failed++;
      console.warn(
        `[intent-checkpoint] 会话 ${sessionId} 归档迁移失败:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

/** 延迟启动一次；返回停止函数（未开始时取消，进行中则在当前会话处理完后停下）。 */
export function startIntentCheckpointMaintenance(opts: {
  sessionsDir: string;
  delayMs?: number;
}): () => void {
  let stopped = false;
  const timer = setTimeout(() => {
    void runIntentCheckpointMaintenance(opts.sessionsDir, () => stopped)
      .then(({ converted, failed, savedBytes }) => {
        if (converted > 0 || failed > 0 || savedBytes > 0) {
          console.log(
            `[intent-checkpoint] 旧格式归档已转换 ${converted} 个，失败 ${failed} 个，`
            + `压缩旧 blob 省出 ${(savedBytes / 1024 / 1024).toFixed(1)}MB`,
          );
        }
      })
      .catch((err) => console.warn(
        '[intent-checkpoint] 归档迁移失败:',
        err instanceof Error ? err.message : err,
      ));
  }, opts.delayMs ?? START_DELAY_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
