import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  isHiddenMemoryToolPath,
  gateMemoryToolRead,
  SESSION_PROGRESS_TOOL_SKIP_MESSAGE,
} from '../../../src/memory/file-memory/memory-tool-access.js';

const saved: Record<string, string | undefined> = {};

describe('memory-tool-access', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ice-mem-access-'));
    for (const key of ['ICE_DATA_DIR', 'ICE_MEMORY_DIR', 'ICE_USER_MEMORY_DIR']) {
      saved[key] = process.env[key];
    }
    process.env.ICE_DATA_DIR = root;
    process.env.ICE_MEMORY_DIR = path.join(root, 'memory-files');
    process.env.ICE_USER_MEMORY_DIR = path.join(root, 'user-memory');
    await mkdir(path.join(root, 'memory-files'), { recursive: true });
    await mkdir(path.join(root, 'memory-evicted', 'memory-files'), { recursive: true });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  it('归档目录里的 session_progress 视为隐藏', async () => {
    const archived = path.join(root, 'memory-evicted', 'memory-files', 'feat-overview.md');
    await writeFile(
      archived,
      `---
name: 已全部完成
memoryCategory: session_progress
level: session_state
progressSnapshot: true
---
stale
`,
      'utf-8',
    );
    expect(await isHiddenMemoryToolPath(archived)).toBe(true);
    const gated = await gateMemoryToolRead(archived, root);
    expect(gated.blocked).toBe(true);
    expect(gated.message).toBe(SESSION_PROGRESS_TOOL_SKIP_MESSAGE);
  });

  it('归档目录里的非进度条不隐藏', async () => {
    const archived = path.join(root, 'memory-evicted', 'user-memory', 'user-git-commit-push-style.md');
    await mkdir(path.dirname(archived), { recursive: true });
    await writeFile(archived, '---\ntype: user\n---\ngit commit 用中文\n', 'utf-8');
    expect(await isHiddenMemoryToolPath(archived)).toBe(false);
  });
});
