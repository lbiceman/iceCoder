/**
 * memory-eviction 单元测试。
 *
 * 覆盖：
 * - computeEvictionScore: 评分公式各因子
 * - evictIfNeeded: 触发条件、安全保护、文件移动、归档清理
 * - restoreEvicted: 恢复已淘汰文件
 * - listEvictedFiles: 列出归档文件
 * - 边界情况: 空目录、不存在的目录、全部受保护
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  computeEvictionScore,
  evictIfNeeded,
  restoreEvicted,
  listEvictedFiles,
  type EvictionConfig,
} from './memory-eviction.js';
import type { MemoryHeader } from './types.js';

// ─── 测试工具 ───

let tempDir: string;
let evictedDir: string;

function makeHeader(overrides: Partial<MemoryHeader> = {}): MemoryHeader {
  return {
    filename: 'test.md',
    filePath: '/mem/test.md',
    mtimeMs: Date.now(),
    description: 'test memory',
    type: 'project',
    confidence: 0.5,
    recallCount: 0,
    lastRecalledMs: 0,
    createdMs: Date.now(),
    tags: [],
    source: 'llm_extract',
    contentPreview: '',
    ...overrides,
  };
}

async function writeMemoryFile(
  dir: string,
  filename: string,
  opts: {
    description?: string;
    type?: string;
    confidence?: number;
    recallCount?: number;
    lastRecalledAt?: string;
    createdAt?: string;
  } = {},
) {
  const content = `---
name: ${filename.replace('.md', '')}
description: ${opts.description || 'test memory'}
type: ${opts.type || 'project'}
confidence: ${opts.confidence ?? 0.5}
recallCount: ${opts.recallCount ?? 0}
${opts.lastRecalledAt ? `lastRecalledAt: ${opts.lastRecalledAt}` : ''}
${opts.createdAt ? `createdAt: ${opts.createdAt}` : ''}
---

Content of ${filename}`;
  await fs.writeFile(path.join(dir, filename), content, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `eviction-test-${randomUUID()}`);
  evictedDir = path.join(os.tmpdir(), `evicted-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(evictedDir, { recursive: true, force: true }).catch(() => {});
});

// ═══════════════════════════════════════════════
// computeEvictionScore
// ═══════════════════════════════════════════════

describe('computeEvictionScore', () => {
  it('最近活跃的记忆分数低（不该淘汰）', () => {
    const mem = makeHeader({ mtimeMs: Date.now(), recallCount: 5, confidence: 0.8 });
    const score = computeEvictionScore(mem);
    expect(score).toBeLessThan(0); // 保护因子大于年龄惩罚
  });

  it('长期不活跃的记忆分数高（该淘汰）', () => {
    const oldTime = Date.now() - 300 * 86_400_000; // 300 天前
    const mem = makeHeader({ mtimeMs: oldTime, lastRecalledMs: 0, recallCount: 0, confidence: 0.3 });
    const score = computeEvictionScore(mem);
    expect(score).toBeGreaterThan(50);
  });

  it('高置信度记忆受保护（分数更低）', () => {
    const oldTime = Date.now() - 200 * 86_400_000;
    const lowConf = makeHeader({ mtimeMs: oldTime, confidence: 0.3 });
    const highConf = makeHeader({ mtimeMs: oldTime, confidence: 0.9 });
    expect(computeEvictionScore(highConf)).toBeLessThan(computeEvictionScore(lowConf));
  });

  it('高召回频率记忆受保护', () => {
    const oldTime = Date.now() - 200 * 86_400_000;
    const noRecall = makeHeader({ mtimeMs: oldTime, recallCount: 0 });
    const manyRecalls = makeHeader({ mtimeMs: oldTime, recallCount: 15 });
    expect(computeEvictionScore(manyRecalls)).toBeLessThan(computeEvictionScore(noRecall));
  });

  it('user 类型记忆受保护', () => {
    const oldTime = Date.now() - 200 * 86_400_000;
    const project = makeHeader({ mtimeMs: oldTime, type: 'project' });
    const user = makeHeader({ mtimeMs: oldTime, type: 'user' });
    expect(computeEvictionScore(user)).toBeLessThan(computeEvictionScore(project));
  });

  it('lastRecalledMs 比 mtimeMs 更新时使用 lastRecalledMs', () => {
    const oldMtime = Date.now() - 300 * 86_400_000;
    const recentRecall = Date.now() - 5 * 86_400_000;
    const mem = makeHeader({ mtimeMs: oldMtime, lastRecalledMs: recentRecall });
    const score = computeEvictionScore(mem);
    // 最后活跃是 5 天前，不是 300 天前
    expect(score).toBeLessThan(30);
  });
});

// ═══════════════════════════════════════════════
// evictIfNeeded
// ═══════════════════════════════════════════════

describe('evictIfNeeded', () => {
  const baseConfig: Partial<EvictionConfig> = {
    enabled: true,
    softLimit: 5,
    evictionTarget: 3,
    maxEvictedFiles: 50,
    protectionDays: 0, // 测试中禁用保护期
  };

  it('文件数低于软上限时不淘汰', async () => {
    await writeMemoryFile(tempDir, 'a.md');
    await writeMemoryFile(tempDir, 'b.md');

    const result = await evictIfNeeded(tempDir, { ...baseConfig, evictedDir });
    expect(result.executed).toBe(false);
    expect(result.summary).toContain('Below soft limit');
  });

  it('文件数超过软上限时触发淘汰', async () => {
    // 创建 7 个文件（超过 softLimit=5）
    for (let i = 0; i < 7; i++) {
      await writeMemoryFile(tempDir, `note_${i}.md`, {
        // 让文件有不同的"年龄"
        createdAt: new Date(Date.now() - (i + 10) * 86_400_000).toISOString(),
      });
      // 确保 mtime 不同
      const filePath = path.join(tempDir, `note_${i}.md`);
      const t = (Date.now() - (i + 10) * 86_400_000) / 1000;
      await fs.utimes(filePath, t, t);
    }

    const result = await evictIfNeeded(tempDir, { ...baseConfig, evictedDir });
    expect(result.executed).toBe(true);
    expect(result.fileCountBefore).toBe(7);
    // 应该淘汰到 evictionTarget=3
    expect(result.evictedFiles.length).toBe(4);
    expect(result.fileCountAfter).toBe(3);
  });

  it('被淘汰的文件移动到 evictedDir', async () => {
    for (let i = 0; i < 7; i++) {
      await writeMemoryFile(tempDir, `note_${i}.md`);
      const filePath = path.join(tempDir, `note_${i}.md`);
      const t = (Date.now() - (i + 10) * 86_400_000) / 1000;
      await fs.utimes(filePath, t, t);
    }

    const result = await evictIfNeeded(tempDir, { ...baseConfig, evictedDir });

    // 检查 evictedDir 中有文件
    const evictedFiles = await fs.readdir(evictedDir);
    const mdFiles = evictedFiles.filter(f => f.endsWith('.md'));
    expect(mdFiles.length).toBe(result.evictedFiles.length);

    // 检查原目录中文件减少了
    const remaining = await fs.readdir(tempDir);
    const remainingMd = remaining.filter(f => f.endsWith('.md'));
    expect(remainingMd.length).toBe(3);
  });

  it('不淘汰 confidence >= 1.0 的记忆', async () => {
    for (let i = 0; i < 7; i++) {
      await writeMemoryFile(tempDir, `note_${i}.md`, {
        confidence: i < 5 ? 1.0 : 0.3, // 前 5 个高置信度
      });
      const filePath = path.join(tempDir, `note_${i}.md`);
      const t = (Date.now() - (i + 30) * 86_400_000) / 1000;
      await fs.utimes(filePath, t, t);
    }

    const result = await evictIfNeeded(tempDir, { ...baseConfig, evictedDir });
    // 只有 2 个低置信度文件可以被淘汰
    expect(result.evictedFiles.length).toBeLessThanOrEqual(2);
    // 高置信度文件不应被淘汰
    for (const evicted of result.evictedFiles) {
      expect(evicted).toMatch(/note_[56]\.md/);
    }
  });

  it('保护期内的记忆不淘汰', async () => {
    for (let i = 0; i < 7; i++) {
      await writeMemoryFile(tempDir, `note_${i}.md`);
      // 所有文件都是"刚创建的"（在保护期内）
    }

    const result = await evictIfNeeded(tempDir, {
      ...baseConfig,
      evictedDir,
      protectionDays: 30, // 30 天保护期
    });

    expect(result.executed).toBe(false);
    expect(result.summary).toContain('all protected');
  });

  it('禁用淘汰时不执行', async () => {
    for (let i = 0; i < 7; i++) {
      await writeMemoryFile(tempDir, `note_${i}.md`);
    }

    const result = await evictIfNeeded(tempDir, { ...baseConfig, evictedDir, enabled: false });
    expect(result.executed).toBe(false);
    expect(result.summary).toContain('disabled');
  });

  it('空目录不报错', async () => {
    const result = await evictIfNeeded(tempDir, { ...baseConfig, evictedDir });
    expect(result.executed).toBe(false);
    expect(result.fileCountBefore).toBe(0);
  });

  it('不存在的目录不报错', async () => {
    const result = await evictIfNeeded('/nonexistent/path', { ...baseConfig, evictedDir });
    expect(result.executed).toBe(false);
  });

  it('写入淘汰日志', async () => {
    for (let i = 0; i < 7; i++) {
      await writeMemoryFile(tempDir, `note_${i}.md`);
      const filePath = path.join(tempDir, `note_${i}.md`);
      const t = (Date.now() - (i + 10) * 86_400_000) / 1000;
      await fs.utimes(filePath, t, t);
    }

    await evictIfNeeded(tempDir, { ...baseConfig, evictedDir });

    const logPath = path.join(evictedDir, '_eviction_log.jsonl');
    const logContent = await fs.readFile(logPath, 'utf-8');
    const logEntry = JSON.parse(logContent.trim());
    expect(logEntry.evictedFiles).toBeDefined();
    expect(logEntry.count).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// restoreEvicted
// ═══════════════════════════════════════════════

describe('restoreEvicted', () => {
  it('恢复已淘汰的文件', async () => {
    // 先创建一个"已淘汰"的文件
    await fs.mkdir(evictedDir, { recursive: true });
    await fs.writeFile(path.join(evictedDir, 'restored.md'), '---\nname: restored\n---\nContent', 'utf-8');

    const success = await restoreEvicted(tempDir, 'restored.md', evictedDir);
    expect(success).toBe(true);

    // 检查文件已恢复到 memoryDir
    const content = await fs.readFile(path.join(tempDir, 'restored.md'), 'utf-8');
    expect(content).toContain('restored');

    // 检查 evictedDir 中文件已删除
    const evictedFiles = await fs.readdir(evictedDir);
    expect(evictedFiles).not.toContain('restored.md');
  });

  it('文件不存在时返回 false', async () => {
    const success = await restoreEvicted(tempDir, 'nonexistent.md', evictedDir);
    expect(success).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// listEvictedFiles
// ═══════════════════════════════════════════════

describe('listEvictedFiles', () => {
  it('列出已淘汰的文件', async () => {
    await fs.mkdir(evictedDir, { recursive: true });
    await fs.writeFile(path.join(evictedDir, 'a.md'), 'content', 'utf-8');
    await fs.writeFile(path.join(evictedDir, 'b.md'), 'content', 'utf-8');
    await fs.writeFile(path.join(evictedDir, '_eviction_log.jsonl'), '{}', 'utf-8');

    const files = await listEvictedFiles(evictedDir);
    expect(files).toEqual(['a.md', 'b.md']);
  });

  it('目录不存在时返回空数组', async () => {
    const files = await listEvictedFiles('/nonexistent');
    expect(files).toEqual([]);
  });
});
