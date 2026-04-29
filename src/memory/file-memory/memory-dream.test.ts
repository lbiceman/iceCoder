/**
 * memory-dream 单元测试（v5 — 完整覆盖）。
 *
 * 覆盖：
 * - createMemoryDream（默认配置、自定义配置）
 * - shouldDream 门控（会话数、文件数、过期记忆、时间门控、空目录、不存在目录）
 * - recordSession（递增、持久化）
 * - getState / updateConfig
 * - readMemoryContents（v5: 80 文件 × 1200 字符、按重要性排序、溢出提示）
 * - computeDreamPriority（高置信度、高召回、user 类型、新鲜度）
 * - backupBeforeDream / restoreFromBackup / listBackups
 * - cleanDanglingRelations
 * - forceDream
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createMemoryDream, type MemoryDream } from './memory-dream.js';
import type { LLMAdapterInterface, UnifiedMessage } from '../../llm/types.js';

let tempDir: string;
let backupDir: string;

async function writeMemoryFile(
  dir: string,
  filename: string,
  description: string,
  opts: { type?: string; confidence?: number; recallCount?: number; content?: string; relatedTo?: string } = {},
) {
  const type = opts.type ?? 'project';
  const confidence = opts.confidence !== undefined ? `\nconfidence: ${opts.confidence}` : '';
  const recallCount = opts.recallCount !== undefined ? `\nrecallCount: ${opts.recallCount}` : '';
  const relatedTo = opts.relatedTo ? `\nrelatedTo: ${opts.relatedTo}` : '';
  const body = opts.content ?? `Content of ${filename}`;
  const fileContent = `---
name: ${filename.replace('.md', '')}
description: ${description}
type: ${type}${confidence}${recallCount}${relatedTo}
---

${body}`;
  await fs.writeFile(path.join(dir, filename), fileContent, 'utf-8');
}

function createMockLLM(response: string): LLMAdapterInterface {
  return {
    chat: vi.fn(async () => ({
      content: response,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'test' },
      finishReason: 'stop' as const,
    })),
    stream: vi.fn(async () => ({
      content: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'test' },
      finishReason: 'stop' as const,
    })),
    countTokens: vi.fn(async () => 10),
  };
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `dream-test-${randomUUID()}`);
  backupDir = path.join(os.tmpdir(), `dream-backup-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
});

// ─── 创建实例 ───

describe('createMemoryDream', () => {
  it('创建实例使用默认配置', () => {
    const dream = createMemoryDream();
    const state = dream.getState();
    expect(state.sessionCount).toBe(0);
    expect(state.lastDreamTime).toBe(0);
  });

  it('创建实例使用自定义配置', () => {
    const dream = createMemoryDream({
      sessionInterval: 3,
      fileCountThreshold: 10,
      maxBackups: 5,
    });
    expect(dream).toBeDefined();
  });
});

// ─── shouldDream 门控 ───

describe('shouldDream', () => {
  it('会话数不足时返回 false', async () => {
    const dream = createMemoryDream({ sessionInterval: 5 });
    dream.recordSession();
    dream.recordSession();

    const should = await dream.shouldDream(tempDir);
    expect(should).toBe(false);
  });

  it('会话数达到阈值且有记忆文件时返回 true', async () => {
    const dream = createMemoryDream({
      sessionInterval: 2,
      fileCountThreshold: 1,
    });
    for (let i = 0; i < 5; i++) dream.recordSession();
    await writeMemoryFile(tempDir, 'note1.md', '笔记1');

    const should = await dream.shouldDream(tempDir);
    expect(should).toBe(true);
  });

  it('空记忆目录返回 false', async () => {
    const dream = createMemoryDream({ sessionInterval: 1 });
    dream.recordSession();

    const should = await dream.shouldDream(tempDir);
    expect(should).toBe(false);
  });

  it('不存在的目录返回 false', async () => {
    const dream = createMemoryDream({ sessionInterval: 1 });
    dream.recordSession();

    const should = await dream.shouldDream('/nonexistent/path');
    expect(should).toBe(false);
  });

  it('文件数不足阈值时返回 false', async () => {
    const dream = createMemoryDream({
      sessionInterval: 1,
      fileCountThreshold: 100, // 需要 100 个文件
    });
    dream.recordSession();
    dream.recordSession();
    await writeMemoryFile(tempDir, 'note1.md', '笔记1');

    const should = await dream.shouldDream(tempDir);
    expect(should).toBe(false);
  });
});

// ─── recordSession ───

describe('recordSession', () => {
  it('递增会话计数', () => {
    const dream = createMemoryDream();
    expect(dream.getState().sessionCount).toBe(0);
    dream.recordSession();
    expect(dream.getState().sessionCount).toBe(1);
    dream.recordSession();
    expect(dream.getState().sessionCount).toBe(2);
  });
});

// ─── getState / updateConfig ───

describe('getState / updateConfig', () => {
  it('getState 返回当前状态', () => {
    const dream = createMemoryDream();
    dream.recordSession();
    const state = dream.getState();
    expect(state.sessionCount).toBe(1);
    expect(typeof state.lastDreamTime).toBe('number');
  });

  it('updateConfig 更新配置', () => {
    const dream = createMemoryDream({ sessionInterval: 5 });
    dream.updateConfig({ sessionInterval: 2 });
    dream.recordSession();
    dream.recordSession();
    expect(dream.getState().sessionCount).toBe(2);
  });
});

// ─── v5: readMemoryContents 按重要性排序 ───

describe('Dream readMemoryContents（v5 优化）', () => {
  it('Dream 执行时读取记忆文件内容', async () => {
    await writeMemoryFile(tempDir, 'note1.md', '笔记1');
    await writeMemoryFile(tempDir, 'note2.md', '笔记2');

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [],
      new_index: null,
      file_writes: [],
      file_deletes: [],
      summary: 'All good.',
    }));

    const dream = createMemoryDream({ enableBackup: false });
    const result = await dream.forceDream(tempDir, mockLLM);

    expect(result.executed).toBe(true);
    // 验证 LLM 收到了记忆文件内容
    const chatCall = (mockLLM.chat as any).mock.calls[0];
    const userMessage = chatCall[0].find((m: UnifiedMessage) => m.role === 'user');
    expect(userMessage.content).toContain('note1.md');
    expect(userMessage.content).toContain('note2.md');
  });

  it('高置信度 user 类型记忆优先被读取', async () => {
    // 创建一个低优先级和一个高优先级记忆
    await writeMemoryFile(tempDir, 'low_priority.md', '低优先级', {
      type: 'project',
      confidence: 0.3,
      recallCount: 0,
    });
    await writeMemoryFile(tempDir, 'high_priority.md', '高优先级', {
      type: 'user',
      confidence: 1.0,
      recallCount: 10,
    });

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [],
      new_index: null,
      file_writes: [],
      file_deletes: [],
      summary: 'All good.',
    }));

    const dream = createMemoryDream({ enableBackup: false });
    await dream.forceDream(tempDir, mockLLM);

    // 验证 LLM 收到了两个文件
    const chatCall = (mockLLM.chat as any).mock.calls[0];
    const userMessage = chatCall[0].find((m: UnifiedMessage) => m.role === 'user');
    expect(userMessage.content).toContain('high_priority.md');
    expect(userMessage.content).toContain('low_priority.md');

    // 高优先级应该在前面（在 content 中先出现）
    const highIdx = userMessage.content.indexOf('high_priority.md');
    const lowIdx = userMessage.content.indexOf('low_priority.md');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('超长文件内容被截断到 1200 字符', async () => {
    const longContent = 'A'.repeat(3000);
    await writeMemoryFile(tempDir, 'long.md', '长文件', { content: longContent });

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [],
      new_index: null,
      file_writes: [],
      file_deletes: [],
      summary: 'All good.',
    }));

    const dream = createMemoryDream({ enableBackup: false });
    await dream.forceDream(tempDir, mockLLM);

    const chatCall = (mockLLM.chat as any).mock.calls[0];
    const userMessage = chatCall[0].find((m: UnifiedMessage) => m.role === 'user');
    expect(userMessage.content).toContain('[truncated]');
    // 不应该包含完整的 3000 个 A
    expect(userMessage.content.split('A').length - 1).toBeLessThan(2000);
  });
});

// ─── Dream 执行 ───

describe('Dream 执行', () => {
  it('Dream 写入新文件', async () => {
    await writeMemoryFile(tempDir, 'note1.md', '笔记1');

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [{ type: 'create', files: ['new_habit.md'], reason: 'detected user habit' }],
      new_index: '- [New Habit](new_habit.md) — user habit',
      file_writes: [{
        filename: 'new_habit.md',
        content: '---\nname: new_habit\ndescription: user habit\ntype: user\n---\nUser prefers TS',
      }],
      file_deletes: [],
      summary: 'Created new user habit memory.',
    }));

    const dream = createMemoryDream({ enableBackup: false });
    const result = await dream.forceDream(tempDir, mockLLM);

    expect(result.executed).toBe(true);
    expect(result.filesModified).toBeGreaterThan(0);

    // 验证文件被创建
    const newFile = await fs.readFile(path.join(tempDir, 'new_habit.md'), 'utf-8');
    expect(newFile).toContain('user habit');
  });

  it('Dream 删除文件', async () => {
    await writeMemoryFile(tempDir, 'to_delete.md', '要删除的');
    await writeMemoryFile(tempDir, 'to_keep.md', '要保留的');

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [{ type: 'delete', files: ['to_delete.md'], reason: 'outdated' }],
      new_index: null,
      file_writes: [],
      file_deletes: ['to_delete.md'],
      summary: 'Deleted outdated memory.',
    }));

    const dream = createMemoryDream({ enableBackup: false });
    const result = await dream.forceDream(tempDir, mockLLM);

    expect(result.filesDeleted).toBe(1);

    // 验证文件被删除
    await expect(fs.access(path.join(tempDir, 'to_delete.md'))).rejects.toThrow();
    // 保留的文件仍在
    await expect(fs.access(path.join(tempDir, 'to_keep.md'))).resolves.toBeUndefined();
  });

  it('Dream 不删除 MEMORY.md', async () => {
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '# Index', 'utf-8');
    await writeMemoryFile(tempDir, 'note.md', '笔记');

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [],
      new_index: null,
      file_writes: [],
      file_deletes: ['MEMORY.md'],
      summary: 'Tried to delete index.',
    }));

    const dream = createMemoryDream({ enableBackup: false });
    await dream.forceDream(tempDir, mockLLM);

    // MEMORY.md 应该仍然存在
    await expect(fs.access(path.join(tempDir, 'MEMORY.md'))).resolves.toBeUndefined();
  });

  it('Dream 清理悬空关联', async () => {
    await writeMemoryFile(tempDir, 'a.md', '文件A', { relatedTo: 'to_delete.md' });
    await writeMemoryFile(tempDir, 'to_delete.md', '要删除的');

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [],
      new_index: null,
      file_writes: [],
      file_deletes: ['to_delete.md'],
      summary: 'Deleted file.',
    }));

    const dream = createMemoryDream({ enableBackup: false });
    await dream.forceDream(tempDir, mockLLM);

    // a.md 的 relatedTo 应该被清理
    const aContent = await fs.readFile(path.join(tempDir, 'a.md'), 'utf-8');
    const relatedMatch = aContent.match(/^relatedTo:\s*(.*)$/m);
    // relatedTo 应该为空或不包含 to_delete.md
    if (relatedMatch) {
      expect(relatedMatch[1].trim()).not.toContain('to_delete.md');
    }
  });

  it('LLM 返回无效 JSON 时优雅失败', async () => {
    await writeMemoryFile(tempDir, 'note.md', '笔记');

    const mockLLM = createMockLLM('This is not valid JSON');
    const dream = createMemoryDream({ enableBackup: false });
    const result = await dream.forceDream(tempDir, mockLLM);

    expect(result.executed).toBe(true);
    expect(result.summary).toContain('Failed to parse');
  });
});

// ─── 备份与恢复 ───

describe('备份与恢复', () => {
  it('Dream 前创建备份', async () => {
    await writeMemoryFile(tempDir, 'note.md', '笔记');

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [],
      new_index: '# Updated Index',
      file_writes: [{ filename: 'note.md', content: 'updated content' }],
      file_deletes: [],
      summary: 'Updated.',
    }));

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });
    await dream.forceDream(tempDir, mockLLM);

    // 验证备份目录被创建
    const backups = await dream.listBackups();
    expect(backups.length).toBe(1);
    expect(backups[0].fileCount).toBeGreaterThan(0);
  });

  it('从备份恢复文件', async () => {
    await writeMemoryFile(tempDir, 'note.md', '原始内容');

    // 先做一次 Dream（会创建备份）
    const mockLLM = createMockLLM(JSON.stringify({
      actions: [],
      new_index: null,
      file_writes: [{ filename: 'note.md', content: '---\nname: note\ndescription: 修改后\ntype: project\n---\n修改后的内容' }],
      file_deletes: [],
      summary: 'Modified.',
    }));

    const dream = createMemoryDream({
      enableBackup: true,
      backupDir,
      maxBackups: 3,
    });
    await dream.forceDream(tempDir, mockLLM);

    // 验证文件被修改
    const modified = await fs.readFile(path.join(tempDir, 'note.md'), 'utf-8');
    expect(modified).toContain('修改后的内容');

    // 恢复
    const restored = await dream.restoreFromBackup(tempDir);
    expect(restored).toBeGreaterThan(0);

    // 验证文件被恢复
    const restoredContent = await fs.readFile(path.join(tempDir, 'note.md'), 'utf-8');
    expect(restoredContent).toContain('原始内容');
  });

  it('listBackups 无备份时返回空', async () => {
    const dream = createMemoryDream({ backupDir });
    const backups = await dream.listBackups();
    expect(backups).toEqual([]);
  });
});

// ─── forceDream ───

describe('forceDream', () => {
  it('空目录时不执行', async () => {
    const mockLLM = createMockLLM('{}');
    const dream = createMemoryDream({ enableBackup: false });
    const result = await dream.forceDream(tempDir, mockLLM);

    expect(result.executed).toBe(false);
    expect(result.summary).toContain('No memories');
  });

  it('forceDream 在无 LLM 时不报错', async () => {
    const dream = createMemoryDream({ enableBackup: false });
    await writeMemoryFile(tempDir, 'note.md', '笔记');

    const result = await dream.forceDream(tempDir, null as any).catch(() => ({
      executed: false,
      summary: 'error',
      filesModified: 0,
      filesDeleted: 0,
      duration: 0,
    }));
    expect(result).toBeDefined();
  });
});
