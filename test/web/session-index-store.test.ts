/**
 * 会话 index 对账：磁盘有 {id}.json 但 index 丢失时补回
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'os';

describe('session-index-store', () => {
  let tempDir: string;
  const prev = process.env.ICE_SESSIONS_DIR;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-index-'));
    process.env.ICE_SESSIONS_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (prev === undefined) delete process.env.ICE_SESSIONS_DIR;
    else process.env.ICE_SESSIONS_DIR = prev;
  });

  it('sessionIdFromMessageFileName skips sidecar and also- files', async () => {
    const { sessionIdFromMessageFileName } = await import('../../src/web/session-index-store.js');
    expect(sessionIdFromMessageFileName('aabbccdd.json')).toBe('aabbccdd');
    expect(sessionIdFromMessageFileName('default.json')).toBe('default');
    expect(sessionIdFromMessageFileName('index.json')).toBeNull();
    expect(sessionIdFromMessageFileName('last-active.json')).toBeNull();
    expect(sessionIdFromMessageFileName('aabbccdd.structured.json')).toBeNull();
    expect(sessionIdFromMessageFileName('also-a-123.json')).toBeNull();
    expect(sessionIdFromMessageFileName('inbound-also-run-1.json')).toBeNull();
  });

  it('loadSessionIndex recovers json files missing from a wiped index', async () => {
    await fs.writeFile(
      path.join(tempDir, 'daa48c95.json'),
      JSON.stringify([{ role: 'user', content: '长会话历史', sentAt: 10, completedAt: 20 }]),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([{ id: '30f8336c', title: '新会话', createdAt: 99, updatedAt: 99, messageCount: 0 }]),
      'utf-8',
    );
    await fs.writeFile(path.join(tempDir, '30f8336c.json'), '[]', 'utf-8');

    const { loadSessionIndex } = await import('../../src/web/session-index-store.js');
    const index = await loadSessionIndex();
    expect(index.map((s) => s.id)).toEqual(expect.arrayContaining(['30f8336c', 'daa48c95']));
    expect(index.find((s) => s.id === 'daa48c95')?.title).toBe('长会话历史');
  });
});
