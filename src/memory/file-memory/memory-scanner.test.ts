/**
 * memory-scanner 单元测试。
 * 覆盖 frontmatter 解析、类型解析、manifest 格式化。
 * scanMemoryFiles 涉及文件系统，用临时目录测试。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  parseFrontmatter,
  parseMemoryType,
  scanMemoryFiles,
  formatMemoryManifest,
} from './memory-scanner.js';
import type { MemoryHeader } from './types.js';

describe('parseFrontmatter', () => {
  it('解析标准 frontmatter', () => {
    const content = `---
name: 用户角色
description: 用户的角色信息
type: user
---

正文内容`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('用户角色');
    expect(result.description).toBe('用户的角色信息');
    expect(result.type).toBe('user');
  });

  it('无 frontmatter 返回空对象', () => {
    expect(parseFrontmatter('没有 frontmatter 的内容')).toEqual({});
    expect(parseFrontmatter('')).toEqual({});
  });

  it('只有开头 --- 没有结尾 --- 仍然解析', () => {
    const content = `---
name: test
description: desc`;
    const result = parseFrontmatter(content);
    expect(result.name).toBe('test');
    expect(result.description).toBe('desc');
  });

  it('处理值中包含冒号的情况', () => {
    const content = `---
description: 时间: 2026-01-01
---`;
    const result = parseFrontmatter(content);
    expect(result.description).toBe('时间: 2026-01-01');
  });
});

describe('parseMemoryType', () => {
  it('有效类型返回对应值', () => {
    expect(parseMemoryType('user')).toBe('user');
    expect(parseMemoryType('feedback')).toBe('feedback');
    expect(parseMemoryType('project')).toBe('project');
    expect(parseMemoryType('reference')).toBe('reference');
  });

  it('无效类型返回 undefined', () => {
    expect(parseMemoryType('invalid')).toBeUndefined();
    expect(parseMemoryType('')).toBeUndefined();
    expect(parseMemoryType(null)).toBeUndefined();
    expect(parseMemoryType(123)).toBeUndefined();
    expect(parseMemoryType(undefined)).toBeUndefined();
  });
});

describe('formatMemoryManifest', () => {
  it('格式化记忆列表', () => {
    const memories: MemoryHeader[] = [
      {
        filename: 'user_role.md',
        filePath: '/mem/user_role.md',
        mtimeMs: new Date('2026-01-15').getTime(),
        description: '用户角色信息',
        type: 'user',
      },
      {
        filename: 'no_desc.md',
        filePath: '/mem/no_desc.md',
        mtimeMs: new Date('2026-01-10').getTime(),
        description: null,
        type: undefined,
      },
    ];

    const result = formatMemoryManifest(memories);
    expect(result).toContain('[user] user_role.md');
    expect(result).toContain('用户角色信息');
    expect(result).toContain('no_desc.md');
    expect(result).not.toContain('[undefined]');
  });

  it('空列表返回空字符串', () => {
    expect(formatMemoryManifest([])).toBe('');
  });
});

describe('scanMemoryFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `scanner-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('扫描目录中的 .md 文件', async () => {
    await fs.writeFile(path.join(tempDir, 'user_role.md'), `---
name: role
description: user role
type: user
---
content`, 'utf-8');

    await fs.writeFile(path.join(tempDir, 'feedback.md'), `---
name: fb
description: feedback
type: feedback
---
content`, 'utf-8');

    const results = await scanMemoryFiles(tempDir);
    expect(results).toHaveLength(2);
    expect(results[0].description).toBeDefined();
    expect(results.map(r => r.filename).sort()).toEqual(['feedback.md', 'user_role.md']);
  });

  it('跳过 MEMORY.md 索引文件', async () => {
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '# Index', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'note.md'), '---\nname: n\n---\ncontent', 'utf-8');

    const results = await scanMemoryFiles(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('note.md');
  });

  it('空目录返回空数组', async () => {
    const results = await scanMemoryFiles(tempDir);
    expect(results).toEqual([]);
  });

  it('不存在的目录返回空数组', async () => {
    const results = await scanMemoryFiles('/nonexistent/path');
    expect(results).toEqual([]);
  });

  it('按修改时间降序排列', async () => {
    await fs.writeFile(path.join(tempDir, 'old.md'), '---\nname: old\n---\n', 'utf-8');
    // 确保时间差
    await new Promise(r => setTimeout(r, 50));
    await fs.writeFile(path.join(tempDir, 'new.md'), '---\nname: new\n---\n', 'utf-8');

    const results = await scanMemoryFiles(tempDir);
    expect(results[0].filename).toBe('new.md');
    expect(results[1].filename).toBe('old.md');
  });

  it('限制返回数量', async () => {
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(tempDir, `file${i}.md`), `---\nname: f${i}\n---\n`, 'utf-8');
    }

    const results = await scanMemoryFiles(tempDir, 3);
    expect(results).toHaveLength(3);
  });
});
