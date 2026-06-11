import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { upsertIndexRow } from '../../../src/memory/file-memory/memory-index-maintainer.js';

describe('memory-index-maintainer upsertIndexRow', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ice-index-'));
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('空分区（标题后紧跟下一 ##）插入不挂起', async () => {
    const indexPath = path.join(root, 'MEMORY.md');
    await writeFile(
      indexPath,
      ['# MEMORY.md', '', '## 项目规则', '## 用户偏好', ''].join('\n'),
      'utf-8',
    );

    await upsertIndexRow(root, {
      filename: 'user_commit_style.md',
      description: 'commit 中文',
      type: 'user',
    });

    const content = await readFile(indexPath, 'utf-8');
    expect(content).toContain('user_commit_style.md');
    expect(content).toContain('## 用户偏好');
    expect(content).toContain('| 文件 | 要点 |');
  });

  it('已有表头的分区在末尾追加行', async () => {
    const indexPath = path.join(root, 'MEMORY.md');
    await writeFile(
      indexPath,
      [
        '## 用户偏好',
        '| 文件 | 要点 |',
        '|------|------|',
        '| user_a.md | first |',
      ].join('\n'),
      'utf-8',
    );

    await upsertIndexRow(root, {
      filename: 'user_b.md',
      description: 'second',
      type: 'user',
    });

    const content = await readFile(indexPath, 'utf-8');
    expect(content).toMatch(/\| user_a\.md \| first \|\s*\n\| user_b\.md \| second \|/);
  });
});
