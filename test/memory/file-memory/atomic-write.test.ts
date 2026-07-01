/**
 * atomic-write 单元测试（P1-14）。
 *
 * 覆盖：原子写覆盖已有文件、自动创建父目录、写完不残留临时文件、二进制写入。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { writeFileAtomic } from '../../../src/memory/file-memory/atomic-write.js';

let dir: string;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), `ice-atomic-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('writeFileAtomic', () => {
  it('writes new file content', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFileAtomic(file, 'hello');
    expect(await fs.readFile(file, 'utf-8')).toBe('hello');
  });

  it('overwrites existing file atomically', async () => {
    const file = path.join(dir, 'b.txt');
    await fs.writeFile(file, 'old', 'utf-8');
    await writeFileAtomic(file, 'new-content');
    expect(await fs.readFile(file, 'utf-8')).toBe('new-content');
  });

  it('creates missing parent directories', async () => {
    const file = path.join(dir, 'nested', 'deep', 'c.txt');
    await writeFileAtomic(file, 'x');
    expect(await fs.readFile(file, 'utf-8')).toBe('x');
  });

  it('leaves no .tmp leftovers after a successful write', async () => {
    const file = path.join(dir, 'd.txt');
    await writeFileAtomic(file, 'y');
    const entries = await fs.readdir(dir);
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
    expect(entries).toContain('d.txt');
  });

  it('writes binary content (Uint8Array)', async () => {
    const file = path.join(dir, 'e.bin');
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await writeFileAtomic(file, bytes);
    const read = await fs.readFile(file);
    expect(Array.from(read)).toEqual([0, 1, 2, 255]);
  });
});
