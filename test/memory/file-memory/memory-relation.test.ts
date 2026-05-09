/**
 * 记忆关联扩展单元测试。
 *
 * 覆盖：
 * - expandRelatedMemories: 隐式关联（tags Jaccard）、
 *   去重、maxExpand 限制、alreadySurfaced 过滤
 * - 召回时关联扩展的端到端流程
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { expandRelatedMemories } from '../../../src/memory/file-memory/memory-recall.js';
import { scanMemoryFiles } from '../../../src/memory/file-memory/memory-scanner.js';
import { recallRelevantMemories } from '../../../src/memory/file-memory/memory-recall.js';
import type { MemoryHeader } from '../../../src/memory/file-memory/types.js';

// ─── 测试工具 ───

let tempDir: string;

function makeHeader(overrides: Partial<MemoryHeader> = {}): MemoryHeader {
  return {
    filename: 'test.md',
    filePath: '/mem/test.md',
    mtimeMs: Date.now(),
    description: 'test memory',
    type: 'user',
    confidence: 0.5,
    recallCount: 0,
    lastRecalledMs: 0,
    createdMs: Date.now(),
    tags: [],
    source: 'llm_extract',
    contentPreview: '',
    eventDateMs: 0,
    ...overrides,
  };
}

async function writeMemoryFile(
  dir: string,
  filename: string,
  opts: {
    description?: string;
    type?: string;
    tags?: string;
  } = {},
) {
  const content = `---
name: ${filename.replace('.md', '')}
description: ${opts.description || 'test memory'}
type: ${opts.type || 'user'}
tags: ${opts.tags || ''}
confidence: 0.5
---

Content of ${filename}`;
  await fs.writeFile(path.join(dir, filename), content, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `relation-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  process.env.ICE_USER_MEMORY_DIR = path.join(os.tmpdir(), `relation-user-${randomUUID()}`);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  if (process.env.ICE_USER_MEMORY_DIR) {
    await fs.rm(process.env.ICE_USER_MEMORY_DIR, { recursive: true, force: true }).catch(() => {});
  }
  delete process.env.ICE_USER_MEMORY_DIR;
});

// ═══════════════════════════════════════════════
// expandRelatedMemories — 隐式关联（tags）
// ═══════════════════════════════════════════════

describe('expandRelatedMemories — 隐式关联（tags）', () => {
  it('tags Jaccard >= 0.2 时扩展', () => {
    const a = makeHeader({
      filename: 'a.md', filePath: '/mem/a.md',
      tags: ['testing', 'vitest', 'typescript'],
    });
    const b = makeHeader({
      filename: 'b.md', filePath: '/mem/b.md',
      tags: ['testing', 'vitest'], // Jaccard = 2/3 = 0.67
    });
    const c = makeHeader({
      filename: 'c.md', filePath: '/mem/c.md',
      tags: ['database', 'postgres'], // Jaccard = 0/5 = 0
    });

    const expanded = expandRelatedMemories([a], [a, b, c], new Set());
    expect(expanded.length).toBe(1);
    expect(expanded[0].filename).toBe('b.md');
  });

  it('tags Jaccard < 0.2 时不扩展', () => {
    const a = makeHeader({
      filename: 'a.md', filePath: '/mem/a.md',
      tags: ['testing', 'vitest', 'typescript', 'react'],
    });
    const b = makeHeader({
      filename: 'b.md', filePath: '/mem/b.md',
      tags: ['database', 'postgres', 'sql'], // Jaccard = 0
    });

    const expanded = expandRelatedMemories([a], [a, b], new Set());
    expect(expanded.length).toBe(0);
  });

  it('无 tags 的文件不参与隐式关联', () => {
    const a = makeHeader({
      filename: 'a.md', filePath: '/mem/a.md',
      tags: ['testing'],
    });
    const b = makeHeader({
      filename: 'b.md', filePath: '/mem/b.md',
      tags: [], // 无 tags
    });

    const expanded = expandRelatedMemories([a], [a, b], new Set());
    expect(expanded.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// expandRelatedMemories — 边界情况
// ═══════════════════════════════════════════════

describe('expandRelatedMemories — 边界情况', () => {
  it('maxExpand 限制总扩展数量', () => {
    const a = makeHeader({
      filename: 'a.md', filePath: '/mem/a.md',
      tags: ['testing'],
    });
    const all = [a,
      makeHeader({ filename: 'b.md', filePath: '/mem/b.md', tags: ['testing'] }),
      makeHeader({ filename: 'c.md', filePath: '/mem/c.md', tags: ['testing'] }),
      makeHeader({ filename: 'd.md', filePath: '/mem/d.md', tags: ['testing'] }),
      makeHeader({ filename: 'e.md', filePath: '/mem/e.md', tags: ['testing'] }),
    ];

    const expanded = expandRelatedMemories([a], all, new Set(), 2);
    expect(expanded.length).toBe(2);
  });

  it('空 selected 返回空', () => {
    const expanded = expandRelatedMemories([], [], new Set());
    expect(expanded.length).toBe(0);
  });

  it('不扩展已选中的文件', () => {
    const a = makeHeader({
      filename: 'a.md', filePath: '/mem/a.md',
      tags: ['testing'],
    });
    const b = makeHeader({
      filename: 'b.md', filePath: '/mem/b.md',
      tags: ['testing'],
    });

    const expanded = expandRelatedMemories([a, b], [a, b], new Set());
    expect(expanded.length).toBe(0);
  });

  it('不扩展已展示过的文件', () => {
    const a = makeHeader({
      filename: 'a.md', filePath: '/mem/a.md',
      tags: ['testing'],
    });
    const b = makeHeader({
      filename: 'b.md', filePath: '/mem/b.md',
      tags: ['testing'],
    });

    const expanded = expandRelatedMemories([a], [a, b], new Set(['/mem/b.md']));
    expect(expanded.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// 端到端：召回时关联扩展
// ═══════════════════════════════════════════════

describe('端到端：召回时关联扩展', () => {
  it('关键词回退路径也支持关联扩展', async () => {
    // 创建有 tags 关联关系的记忆文件
    await writeMemoryFile(tempDir, 'user_vitest.md', {
      description: '用户偏好 Vitest 测试框架',
      tags: 'tool:vitest, testing',
    });
    await writeMemoryFile(tempDir, 'user_typescript.md', {
      description: '用户偏好 TypeScript 语言',
      tags: 'lang:typescript, testing',
    });
    await writeMemoryFile(tempDir, 'project_deadline.md', {
      description: '项目截止日期',
      type: 'project',
    });

    // 无 LLM，走关键词回退
    const result = await recallRelevantMemories('Vitest', tempDir, null);

    // 应该选中 user_vitest.md（关键词匹配）
    const filenames = result.memories.map(m => m.filename);
    expect(filenames).toContain('user_vitest.md');
    // project_deadline.md 不应该被带入
    expect(filenames).not.toContain('project_deadline.md');
  });

  it('tags 隐式关联在召回中生效', async () => {
    await writeMemoryFile(tempDir, 'feedback_testing.md', {
      description: '测试相关的反馈',
      type: 'feedback',
      tags: 'testing, tdd',
    });
    await writeMemoryFile(tempDir, 'user_vitest.md', {
      description: '用户偏好 Vitest',
      tags: 'testing, tool:vitest',
    });
    await writeMemoryFile(tempDir, 'project_db.md', {
      description: '数据库设计',
      type: 'project',
      tags: 'database',
    });

    const result = await recallRelevantMemories('测试反馈', tempDir, null);

    const filenames = result.memories.map(m => m.filename);
    // feedback_testing.md 通过关键词匹配
    expect(filenames).toContain('feedback_testing.md');
    // user_vitest.md 通过 tags 隐式关联（共享 "testing"）
    expect(filenames).toContain('user_vitest.md');
  });
});
