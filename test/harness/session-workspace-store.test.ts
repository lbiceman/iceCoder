import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSessionWorkspace } from '../../src/harness/session-workspace-store.js';

describe('session-workspace-store', () => {
  let sessionDir: string;
  const sessionId = 'sess-workspace-repair';

  beforeEach(async () => {
    sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-ws-store-'));
  });

  afterEach(async () => {
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  });

  it('repairs a lockedRoot polluted by a standalone @ reference file path', async () => {
    const root = path.join(sessionDir, 'climbing');
    const referencedFile = path.join(sessionDir, 'unity-mcp-repo', 'scripts', 'validate-nlt-coverage.sh');
    await fs.mkdir(path.dirname(referencedFile), { recursive: true });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(referencedFile, '#!/usr/bin/env bash\n', 'utf-8');

    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.json`),
      JSON.stringify([
        {
          role: 'user',
          content: [root, '请先看一下这个项目'].join('\n'),
        },
        {
          role: 'user',
          content: [referencedFile, '这个文件是什么意思？具体是干什么的？'].join('\n'),
        },
      ]),
      'utf-8',
    );
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.workspace.json`),
      JSON.stringify({ lockedRoot: referencedFile, referenceReads: [], changeCount: 1 }, null, 2),
      'utf-8',
    );

    const state = await loadSessionWorkspace(sessionDir, sessionId);
    expect(path.resolve(state.lockedRoot || '').toLowerCase()).toBe(path.resolve(root).toLowerCase());
  });
});
