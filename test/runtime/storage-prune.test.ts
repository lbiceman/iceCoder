import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pruneExpiredStorage, STORAGE_PRUNE_MAX_AGE_MS } from '../../src/runtime/storage-prune.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22);

let root: string;
let sessionsDir: string;
let mcpCacheDir: string;
let runtimeDir: string;

async function put(rel: string, ageMs: number, content = 'x'): Promise<string> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
  const t = new Date(NOW - ageMs);
  await fs.utimes(file, t, t);
  return file;
}

async function exists(rel: string): Promise<boolean> {
  return fs.access(path.join(root, rel)).then(() => true, () => false);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-storage-prune-'));
  sessionsDir = path.join(root, 'sessions');
  mcpCacheDir = path.join(root, 'mcpCache');
  runtimeDir = path.join(root, 'runtime');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('pruneExpiredStorage', () => {
  it('只删过期的纯缓存，会话数据一律保留', async () => {
    const old = 30 * DAY;
    const fresh = DAY;
    await put('sessions/tool-output/s1/call-1.log', old, '12345');
    await put('sessions/tool-output/s1/call-2.log', fresh);
    await put('sessions/tool-output/s2/call-3.log', old);
    await put('sessions/s1.telemetry.jsonl', old);
    await put('sessions/s1.telemetry.jsonl.old', old);
    await put('sessions/s2.telemetry.jsonl', fresh);
    await put('sessions/s1/bg/bg_1.log', old);
    await put('sessions/s1/ish/ish_1.log', old);
    await put('sessions/s1/agents/agent-a.telemetry.jsonl', old);
    await put('sessions/s1/agents/tool-output/agent-a/c.log', old);
    await put('mcpCache/shot.png', old);
    await put('mcpCache/new.png', fresh);
    await put('runtime/telemetry.jsonl', old);
    await put('runtime/token-usage.jsonl', old);

    const kept = [
      'sessions/s1.json',
      'sessions/s1.structured.json',
      'sessions/s1.checkpoint.json',
      'sessions/index.json',
      'sessions/s1/checkpoints/m1.intent.json',
      'sessions/s1/checkpoints/blobs/abc',
      'sessions/s1/agents/agent-a.structured.json',
      'sessions/s1/agents/agent-a.checkpoint.json',
      'sessions/s1/agents/a.meta.json',
    ];
    for (const rel of kept) await put(rel, old);

    const result = await pruneExpiredStorage({ sessionsDir, mcpCacheDir, runtimeDir, now: NOW });

    expect(result.files).toBe(10);
    expect(result.bytes).toBeGreaterThanOrEqual(5);
    for (const rel of kept) expect(await exists(rel), rel).toBe(true);
    expect(await exists('sessions/tool-output/s1/call-2.log')).toBe(true);
    expect(await exists('sessions/s2.telemetry.jsonl')).toBe(true);
    expect(await exists('mcpCache/new.png')).toBe(true);
    expect(await exists('runtime/token-usage.jsonl')).toBe(true);
    expect(await exists('sessions/tool-output/s2')).toBe(false);
    expect(await exists('sessions/s1/bg')).toBe(false);
  });

  it('telemetry 保留期比工具输出长', async () => {
    const between = STORAGE_PRUNE_MAX_AGE_MS.toolOutput + DAY;
    expect(between).toBeLessThan(STORAGE_PRUNE_MAX_AGE_MS.telemetry);
    await put('sessions/tool-output/s1/c.log', between);
    await put('sessions/s1.telemetry.jsonl', between);

    await pruneExpiredStorage({ sessionsDir, now: NOW });

    expect(await exists('sessions/tool-output/s1/c.log')).toBe(false);
    expect(await exists('sessions/s1.telemetry.jsonl')).toBe(true);
  });

  it('目录不存在时不报错', async () => {
    await expect(pruneExpiredStorage({
      sessionsDir: path.join(root, 'missing'),
      mcpCacheDir: path.join(root, 'missing-mcp'),
      runtimeDir: path.join(root, 'missing-rt'),
      now: NOW,
    })).resolves.toEqual({ files: 0, bytes: 0 });
  });
});
