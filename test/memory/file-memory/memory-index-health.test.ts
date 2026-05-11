import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { countDeadLinksInMemoryIndex } from '../../../src/memory/file-memory/memory-index-health.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `idx-health-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('countDeadLinksInMemoryIndex', () => {
  it('无 MEMORY.md 时返回 0', async () => {
    const r = await countDeadLinksInMemoryIndex(tempDir);
    expect(r.dead).toBe(0);
    expect(r.checked).toBe(0);
  });

  it('统计死链数', async () => {
    await fs.writeFile(
      path.join(tempDir, 'MEMORY.md'),
      '- [a](missing1.md)\n- [b](missing2.md)\n- [ok](https://x.test)\n',
      'utf-8',
    );
    const r = await countDeadLinksInMemoryIndex(tempDir);
    expect(r.checked).toBe(2);
    expect(r.dead).toBe(2);
  });

  it('存在的文件不计死链', async () => {
    await fs.writeFile(path.join(tempDir, 'real.md'), 'x', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '- [r](real.md)\n', 'utf-8');
    const r = await countDeadLinksInMemoryIndex(tempDir);
    expect(r.dead).toBe(0);
    expect(r.checked).toBe(1);
  });
});
