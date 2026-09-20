import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { repairMemoryIndexIfUnhealthy } from '../../../src/memory/file-memory/memory-index-maintainer.js';
import { extractIndexedMarkdownRefs } from '../../../src/memory/file-memory/memory-index-health.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `user-index-repair-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('repairMemoryIndexIfUnhealthy', () => {
  it('把用户目录孤儿写进 MEMORY.md', async () => {
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), `# 用户记忆索引

## 用户偏好
| 文件 | 要点 |
|------|------|
`, 'utf-8');
    await fs.writeFile(path.join(tempDir, 'user-pwsh7-preferred-shell.md'), `---
name: pwsh7
description: 使用 pwsh7
type: user
confidence: 0.9
---
use pwsh
`, 'utf-8');
    await fs.writeFile(path.join(tempDir, 'user-git-commit-push-style.md'), `---
name: git
description: 中文 commit
type: user
confidence: 0.9
---
commit in chinese
`, 'utf-8');

    const result = await repairMemoryIndexIfUnhealthy(tempDir);
    expect(result.orphans).toBe(2);
    expect(result.rebuilt).toBe(true);
    const refs = extractIndexedMarkdownRefs(await fs.readFile(path.join(tempDir, 'MEMORY.md'), 'utf-8'));
    expect(refs.has('user-pwsh7-preferred-shell.md')).toBe(true);
    expect(refs.has('user-git-commit-push-style.md')).toBe(true);
  });
});
