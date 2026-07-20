import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { purgeSessionDiskFiles } from '../../src/web/session-file-purge.js';

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

describe('purgeSessionDiskFiles', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('removes flat files, temp files, and session subtree by prefix', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-session-purge-'));
    const sessionId = 'abc12def';

    const names = [
      `${sessionId}.json`,
      `${sessionId}.structured.json`,
      `${sessionId}.checkpoint-index.json`,
      `${sessionId}.json.${'deadbeef'}.tmp`,
    ];
    for (const name of names) {
      await fs.writeFile(path.join(tempDir, name), name, 'utf-8');
    }
    await fs.mkdir(path.join(tempDir, sessionId, 'checkpoints'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, sessionId, 'checkpoints', 'm1.intent.json'),
      '{}',
      'utf-8',
    );
    await fs.writeFile(path.join(tempDir, 'other.json'), 'keep', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'index.json'), '[]', 'utf-8');

    await purgeSessionDiskFiles(tempDir, sessionId);

    for (const name of names) {
      expect(await exists(path.join(tempDir, name))).toBe(false);
    }
    expect(await exists(path.join(tempDir, sessionId))).toBe(false);
    expect(await exists(path.join(tempDir, 'other.json'))).toBe(true);
    expect(await exists(path.join(tempDir, 'index.json'))).toBe(true);
  });
});
