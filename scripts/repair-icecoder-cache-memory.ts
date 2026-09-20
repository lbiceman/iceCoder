/**
 * 一次性修复 E:\my\iceCoderCache 记忆库：撤销 lang:/tool: 误合并，重建用户索引，清残留锁。
 *
 *   npx tsx scripts/repair-icecoder-cache-memory.ts
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { repairCoarseTopicSupersessions } from '../src/memory/file-memory/memory-false-merge-repair.js';
import { repairMemoryIndexIfUnhealthy } from '../src/memory/file-memory/memory-index-maintainer.js';
import { dedupeUserMemoryDuplicates } from '../src/memory/file-memory/memory-user-dedup.js';
import { downgradeSessionProgressOverviews } from '../src/memory/file-memory/memory-progress-overview.js';

const ROOT = process.env.ICE_CACHE_ROOT?.trim() || 'E:/my/iceCoderCache';

async function unlinkIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
    console.log(`removed ${filePath}`);
  } catch {
    // missing is fine
  }
}

async function main() {
  const projectDir = path.join(ROOT, 'memory-files');
  const userDir = path.join(ROOT, 'user-memory');
  const memoryAux = path.join(ROOT, 'memory');

  const projectRepair = await repairCoarseTopicSupersessions(projectDir);
  console.log('project coarse-merge repair', projectRepair);

  const userRepair = await repairCoarseTopicSupersessions(userDir);
  console.log('user coarse-merge repair', userRepair);

  process.env.ICE_DATA_DIR = ROOT;
  process.env.ICE_USER_MEMORY_DIR = userDir;
  const userIndex = await repairMemoryIndexIfUnhealthy(userDir);
  console.log('user index repair', userIndex);

  const userDedup = await dedupeUserMemoryDuplicates(
    userDir,
    path.join(ROOT, 'memory-evicted', 'user-memory'),
  );
  console.log('user memory dedup', userDedup);

  const overviewDowngrade = await downgradeSessionProgressOverviews(projectDir);
  console.log('progress overview downgrade', overviewDowngrade);

  await unlinkIfExists(path.join(projectDir, '.consolidate-lock'));
  const auxNames = await fs.readdir(memoryAux).catch(() => [] as string[]);
  for (const name of auxNames) {
    if (name.startsWith('.dream-state.json.') && name.endsWith('.tmp')) {
      await unlinkIfExists(path.join(memoryAux, name));
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
