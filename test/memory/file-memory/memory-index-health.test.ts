import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  auditMemoryIndexHealth,
  countDeadLinksInMemoryIndex,
  extractIndexedMarkdownRefs,
  rebuildMemoryIndexFromMemories,
  repairDeadLinksInMemoryIndex,
} from '../../../src/memory/file-memory/memory-index-health.js';
import type { MemoryHeader } from '../../../src/memory/file-memory/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `idx-health-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

describe('extractIndexedMarkdownRefs', () => {
  it('提取链接与表格引用', () => {
    const refs = extractIndexedMarkdownRefs(
      '- [a](missing1.md)\n| user-foo.md | hint |\n| MEMORY.md | skip |\n',
    );
    expect(refs.has('missing1.md')).toBe(true);
    expect(refs.has('user-foo.md')).toBe(true);
    expect(refs.has('MEMORY.md')).toBe(false);
  });
});

describe('countDeadLinksInMemoryIndex', () => {
  it('无 MEMORY.md 时返回 0', async () => {
    const r = await countDeadLinksInMemoryIndex(tempDir);
    expect(r.dead).toBe(0);
    expect(r.checked).toBe(0);
  });

  it('统计 Markdown 链接死链数', async () => {
    await fs.writeFile(
      path.join(tempDir, 'MEMORY.md'),
      '- [a](missing1.md)\n- [b](missing2.md)\n- [ok](https://x.test)\n',
      'utf-8',
    );
    const r = await countDeadLinksInMemoryIndex(tempDir);
    expect(r.checked).toBe(2);
    expect(r.dead).toBe(2);
  });

  it('统计表格死链数', async () => {
    await fs.writeFile(path.join(tempDir, 'real.md'), 'x', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'MEMORY.md'),
      '| gone.md | x |\n| real.md | ok |\n',
      'utf-8',
    );
    const r = await countDeadLinksInMemoryIndex(tempDir);
    expect(r.checked).toBe(2);
    expect(r.dead).toBe(1);
  });

  it('存在的文件不计死链', async () => {
    await fs.writeFile(path.join(tempDir, 'real.md'), 'x', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '- [r](real.md)\n', 'utf-8');
    const r = await countDeadLinksInMemoryIndex(tempDir);
    expect(r.dead).toBe(0);
    expect(r.checked).toBe(1);
  });
});

describe('auditMemoryIndexHealth', () => {
  it('报告孤儿文件', async () => {
    await fs.writeFile(path.join(tempDir, 'orphan.md'), 'x', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '| listed.md | x |\n', 'utf-8');
    const report = await auditMemoryIndexHealth(tempDir);
    expect(report.dead).toBe(1);
    expect(report.orphans).toBe(1);
    expect(report.orphanFiles).toContain('orphan.md');
  });
});

describe('repairDeadLinksInMemoryIndex', () => {
  it('移除死链并保留活链', async () => {
    await fs.writeFile(path.join(tempDir, 'ok.md'), 'x', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'MEMORY.md'),
      '- [gone](nope.md)\n- [keep](ok.md)\n',
      'utf-8',
    );
    const r = await repairDeadLinksInMemoryIndex(tempDir);
    expect(r.removedLinks).toBe(1);
    expect(r.wrote).toBe(true);
    const after = await fs.readFile(path.join(tempDir, 'MEMORY.md'), 'utf-8');
    expect(after).toContain('[keep](ok.md)');
    expect(after).not.toContain('nope.md');
    const links = await countDeadLinksInMemoryIndex(tempDir);
    expect(links.dead).toBe(0);
  });

  it('移除表格死链行', async () => {
    await fs.writeFile(path.join(tempDir, 'ok.md'), 'x', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'MEMORY.md'),
      '| gone.md | x |\n| ok.md | y |\n',
      'utf-8',
    );
    const r = await repairDeadLinksInMemoryIndex(tempDir);
    expect(r.removedLinks).toBe(1);
    const after = await fs.readFile(path.join(tempDir, 'MEMORY.md'), 'utf-8');
    expect(after).toContain('ok.md');
    expect(after).not.toContain('gone.md');
  });

  it('无死链时不写盘', async () => {
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '- [x](https://a.test)\n', 'utf-8');
    const r = await repairDeadLinksInMemoryIndex(tempDir);
    expect(r.removedLinks).toBe(0);
    expect(r.wrote).toBe(false);
  });
});

describe('rebuildMemoryIndexFromMemories', () => {
  it('按类型生成表格索引', async () => {
    const memories: MemoryHeader[] = [
      {
        filename: 'user_style.md',
        filePath: path.join(tempDir, 'user_style.md'),
        name: 'user_style',
        description: '沟通风格',
        type: 'user',
        confidence: 0.9,
        recallCount: 2,
        mtimeMs: Date.now(),
        createdMs: Date.now(),
        lastRecalledMs: 0,
        tags: [],
        contentPreview: '',
        eventDateMs: 0,
      },
      {
        filename: 'proj_rule.md',
        filePath: path.join(tempDir, 'proj_rule.md'),
        name: 'proj_rule',
        description: '项目规则',
        type: 'project',
        confidence: 0.8,
        recallCount: 1,
        mtimeMs: Date.now(),
        createdMs: Date.now(),
        lastRecalledMs: 0,
        tags: [],
        contentPreview: '',
        eventDateMs: 0,
      },
    ];
    const r = await rebuildMemoryIndexFromMemories(tempDir, memories);
    expect(r.wrote).toBe(true);
    expect(r.entryCount).toBe(2);
    const index = await fs.readFile(path.join(tempDir, 'MEMORY.md'), 'utf-8');
    expect(index).toContain('user_style.md');
    expect(index).toContain('proj_rule.md');
    expect(index).toContain('用户偏好');
  });
});
