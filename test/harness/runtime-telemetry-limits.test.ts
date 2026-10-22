import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RuntimeTelemetry, runtimeTelemetryFile } from '../../src/harness/runtime-telemetry.js';
import { summarizeRuntimeTelemetry } from '../../src/harness/runtime-telemetry-summary.js';
import type { RepoContextSnapshot, TaskStateSnapshot } from '../../src/types/runtime-snapshot.js';

function hugeTask(): TaskStateSnapshot {
  const versions: Record<string, number> = {};
  for (let i = 0; i < 5_041; i++) {
    versions[`spell-squad/assets/input-prompts/playstation series/default/button_${i}.png`] = 1;
  }
  return {
    goal: '加冷却'.repeat(200),
    intent: 'edit',
    phase: 'editing',
    filesRead: Array.from({ length: 300 }, (_, i) => `src/file-${i}.js`),
    filesChanged: ['src/spells.js'],
    commandsRun: [],
    workspaceMutationVersion: 5_140,
    fileDeliverableWriteVersions: versions,
  };
}

function repo(): RepoContextSnapshot {
  return {
    filesRead: ['src/spells.js'],
    filesChanged: ['src/spells.js'],
    commandsRun: ['npm test'],
    testCommands: ['npm test'],
    recentDiagnostics: [],
  };
}

async function readLines(file: string): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(file, 'utf8');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('RuntimeTelemetry · 体积护栏', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'ice-tel-limits-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round 事件只记计数与摘要，不写整张交付版本表', async () => {
    const tel = new RuntimeTelemetry(dir, 'round-slim');
    await tel.recordRound({ round: 75, task: hugeTask(), repo: repo() });

    const file = runtimeTelemetryFile(dir, 'round-slim');
    const raw = await fs.readFile(file, 'utf8');
    expect(Buffer.byteLength(raw)).toBeLessThan(4_096);
    const [event] = await readLines(file);
    const task = event.task as Record<string, unknown>;
    expect(task.fileDeliverableWriteVersions).toBeUndefined();
    expect(task.deliverableWrites).toBe(5_041);
    expect(task.filesReadCount).toBe(300);
    expect((task.filesRead as string[]).length).toBeLessThanOrEqual(20);
  });

  it('单条超过上限时只保留类型、时间与原始字节数', async () => {
    const tel = new RuntimeTelemetry(dir, 'line-cap', { maxLineBytes: 512 });
    await tel.recordFailure({ source: 'checkpoint_save', message: 'x'.repeat(5_000) });

    const [event] = await readLines(runtimeTelemetryFile(dir, 'line-cap'));
    expect(event.type).toBe('failure');
    expect(event.truncated).toBe(true);
    expect(event.originalBytes).toBeGreaterThan(5_000);
    expect(event.message).toBeUndefined();
  });

  it('超过单文件上限时轮转为 .old，只保留一份旧文件', async () => {
    const tel = new RuntimeTelemetry(dir, 'rotate', { maxFileBytes: 2_000 });
    for (let i = 0; i < 40; i++) {
      await tel.recordFailure({ source: 'checkpoint_save', message: `failure number ${i} ${'y'.repeat(80)}` });
    }

    const file = runtimeTelemetryFile(dir, 'rotate');
    const current = await fs.stat(file);
    const old = await fs.stat(`${file}.old`);
    expect(current.size).toBeLessThanOrEqual(2_000);
    expect(old.size).toBeLessThanOrEqual(2_000);
    const names = (await fs.readdir(dir)).filter(n => n.startsWith('rotate'));
    expect(names.sort()).toEqual(['rotate.telemetry.jsonl', 'rotate.telemetry.jsonl.old']);
    const lastLines = await readLines(file);
    expect(String(lastLines.at(-1)?.message)).toContain('failure number 39');
  });

  it('同类型同内容的事件在去重窗口内只落一条，下一条带上被省略的次数', async () => {
    let now = 1_000_000;
    const tel = new RuntimeTelemetry(dir, 'dedupe', { now: () => now });
    for (let i = 0; i < 50; i++) {
      await tel.recordCompaction({ beforeMessages: 10, afterMessages: 11, beforeTokens: 491_369, afterTokens: 63_023 });
      await tel.recordRound({ round: 75, task: hugeTask(), repo: repo() });
      now += 40;
    }
    now += 1_000;
    await tel.recordRound({ round: 75, task: hugeTask(), repo: repo() });

    const file = runtimeTelemetryFile(dir, 'dedupe');
    const lines = await readLines(file);
    const rounds = lines.filter(l => l.type === 'round');
    expect(lines.length).toBeLessThan(15);
    expect(rounds.at(-1)?.suppressedDuplicates).toBeGreaterThan(0);

    const summary = await summarizeRuntimeTelemetry(file, { days: 1 });
    expect(summary.rounds).toBe(51);
  });

  it('tool 事件不去重，避免少计工具调用', async () => {
    const tel = new RuntimeTelemetry(dir, 'tools');
    for (let i = 0; i < 3; i++) {
      await tel.recordTool({ round: 1, toolName: 'read_file', success: true, outputLength: 10 });
    }
    const lines = await readLines(runtimeTelemetryFile(dir, 'tools'));
    expect(lines).toHaveLength(3);
  });

  it('磁盘剩余空间低于阈值时停止写入', async () => {
    const tel = new RuntimeTelemetry(dir, 'disk', { minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
    await tel.recordFailure({ source: 'checkpoint_save', message: 'should not be written' });
    await expect(fs.stat(runtimeTelemetryFile(dir, 'disk'))).rejects.toThrow();
  });
});
