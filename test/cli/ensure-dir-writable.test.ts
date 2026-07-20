/**
 * ensure-dir-writable 单元测试。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  ensureDirWritable,
  probeDirAtomicWrite,
} from '../../src/cli/ensure-dir-writable.js';

let dir: string;

beforeEach(async () => {
  dir = path.join(os.tmpdir(), `ice-writable-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('probeDirAtomicWrite', () => {
  it('returns true for a normal writable directory', async () => {
    expect(await probeDirAtomicWrite(dir)).toBe(true);
  });

  it('returns false for a non-existent directory', async () => {
    const missing = path.join(dir, 'missing-sub');
    expect(await probeDirAtomicWrite(missing)).toBe(false);
  });
});

describe('ensureDirWritable', () => {
  it('creates missing directory and passes probe', async () => {
    const nested = path.join(dir, 'nested', 'data');
    await ensureDirWritable(nested);
    expect(await probeDirAtomicWrite(nested)).toBe(true);
  });
});
