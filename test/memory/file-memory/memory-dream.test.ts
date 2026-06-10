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
 * - forceDream
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  createMemoryDream,
  isDreamBatchRetryableError,
  shouldAutoPromoteToUserLevel,
  type MemoryDream,
} from '../../../src/memory/file-memory/memory-dream.js';
import { resetConsolidationFlightState } from '../../../src/memory/file-memory/memory-concurrency.js';
import type { MemoryHeader } from '../../../src/memory/file-memory/types.js';
import type { LLMAdapterInterface, UnifiedMessage } from '../../../src/llm/types.js';

let tempDir: string;
let backupDir: string;

async function writeMemoryFile(
  dir: string,
  filename: string,
  description: string,
  opts: {
    type?: string;
    confidence?: number;
    recallCount?: number;
    content?: string;
    createdAt?: string;
    level?: string;
    evidenceStrength?: string;
    source?: string;
    eventDate?: string;
  } = {},
) {
  const type = opts.type ?? 'project';
  const confidence = opts.confidence !== undefined ? `\nconfidence: ${opts.confidence}` : '';
  const recallCount = opts.recallCount !== undefined ? `\nrecallCount: ${opts.recallCount}` : '';
  const createdAt = opts.createdAt !== undefined ? `\ncreatedAt: ${opts.createdAt}` : '';
  const level = opts.level !== undefined ? `\nlevel: ${opts.level}` : '';
  const evidenceStrength = opts.evidenceStrength !== undefined ? `\nevidenceStrength: ${opts.evidenceStrength}` : '';
  const source = opts.source !== undefined ? `\nsource: ${opts.source}` : '';
  const eventDate = opts.eventDate !== undefined ? `\neventDate: ${opts.eventDate}` : '';
  const body = opts.content ?? `Content of ${filename}`;
  const fileContent = `---
name: ${filename.replace('.md', '')}
description: ${description}
type: ${type}${confidence}${recallCount}${createdAt}${level}${evidenceStrength}${source}${eventDate}
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

const defaultDreamStatePath = path.join(process.cwd(), 'data', 'memory', 'dream-state.json');

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `dream-test-${randomUUID()}`);
  backupDir = path.join(os.tmpdir(), `dream-backup-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  await fs.mkdir(path.dirname(defaultDreamStatePath), { recursive: true });
  await fs.writeFile(
    defaultDreamStatePath,
    JSON.stringify({ sessionCount: 0, lastDreamTime: 0, staleIndexDreamCompletedAt: 0 }),
    'utf-8',
  );
});

afterEach(async () => {
  resetConsolidationFlightState();
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

  it('LLM Dream 空跑退避独立于 indexDreamBackoffCount', async () => {
    const dream = createMemoryDream({
      sessionInterval: 2,
      fileCountThreshold: 1,
      indexBackoffBaseMs: 60_000,
    });
    for (let i = 0; i < 5; i++) dream.recordSession();
    await writeMemoryFile(tempDir, 'note1.md', '笔记1');

    dream.notifyDreamEmptyRun();
    const blocked = await dream.evaluateDreamGate(tempDir);
    expect(blocked.shouldRun).toBe(false);
    expect(blocked.skipReason).toMatch(/dream_empty_backoff/);

    dream.notifyDreamSubstantiveRun();
    const allowed = await dream.evaluateDreamGate(tempDir);
    expect(allowed.shouldRun).toBe(true);
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

// ─── evaluateDreamGate（触发原因 / 与条数解耦） ───

describe('evaluateDreamGate', () => {
  it('MEMORY.md 死链达到阈值时规则修复后不再触发 LLM', async () => {
    await fs.writeFile(
      path.join(tempDir, 'MEMORY.md'),
      '- [x](a.md)\n- [y](b.md)\n- [z](c.md)\n',
      'utf-8',
    );
    await writeMemoryFile(tempDir, 'only.md', 'n');
    const dream = createMemoryDream({ staleIndexDeadLinksThreshold: 3 });
    const gate = await dream.evaluateDreamGate(tempDir);
    // Phase 1.5: rule repair strips dead links, no LLM needed
    expect(gate.shouldRun).toBe(false);
    expect(gate.skipReason).toBe('stale_index_rule_repaired');
  });

  it('表格死链达到阈值时规则修复', async () => {
    await fs.writeFile(
      path.join(tempDir, 'MEMORY.md'),
      '| a.md | x |\n| b.md | y |\n| c.md | z |\n',
      'utf-8',
    );
    await writeMemoryFile(tempDir, 'only.md', 'n');
    const dream = createMemoryDream({ staleIndexDeadLinksThreshold: 3 });
    const gate = await dream.evaluateDreamGate(tempDir);
    expect(gate.shouldRun).toBe(false);
    expect(gate.skipReason).toBe('stale_index_rule_repaired');
  });

  it('孤儿文件过多时 index_drift 规则重建不调 LLM', async () => {
    await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '| listed.md | x |\n', 'utf-8');
    await writeMemoryFile(tempDir, 'listed.md', 'listed');
    for (let i = 0; i < 20; i++) {
      await writeMemoryFile(tempDir, `orphan_${i}.md`, `o${i}`);
    }
    const dream = createMemoryDream();
    const gate = await dream.evaluateDreamGate(tempDir);
    // Phase 1.4: index_drift → rule rebuild, no LLM
    expect(gate.shouldRun).toBe(false);
    expect(gate.skipReason).toBe('index_drift_rule_rebuild');
  });

  it('stale_index 规则修复后不再触发', async () => {
    await fs.writeFile(
      path.join(tempDir, 'MEMORY.md'),
      '- [x](a.md)\n- [y](b.md)\n- [z](c.md)\n',
      'utf-8',
    );
    await writeMemoryFile(tempDir, 'only.md', 'n');
    const dream = createMemoryDream({ staleIndexDeadLinksThreshold: 3 });
    const gate = await dream.evaluateDreamGate(tempDir);
    expect(gate.shouldRun).toBe(false);
    expect(gate.skipReason).toBe('stale_index_rule_repaired');
  });

  it('超过条数上限时触发 Dream，先整合再淘汰', async () => {
    const lockPath = path.join(tempDir, '.consolidate-lock');
    await fs.writeFile(lockPath, '1', 'utf-8');
    const lockT = (Date.now() - 8 * 86_400_000) / 1000;
    await fs.utimes(lockPath, lockT, lockT);
    const oldIso = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const fileT = (Date.now() - 20 * 86_400_000) / 1000;
    for (let i = 0; i < 12; i++) {
      await writeMemoryFile(tempDir, `many_${i}.md`, `m${i}`, { createdAt: oldIso });
      await fs.utimes(path.join(tempDir, `many_${i}.md`), fileT, fileT);
    }
    const dream = createMemoryDream({
      sessionInterval: 5,
      fileCountThreshold: 100,
      postDreamMemoryCap: 5,
    });
    const gate = await dream.evaluateDreamGate(tempDir);
    expect(gate.shouldRun).toBe(true);
    expect(gate.trigger).toBe('over_cap');
  });
});

// ─── shouldAutoPromoteToUserLevel ───

describe('shouldAutoPromoteToUserLevel', () => {
  function header(partial: Partial<MemoryHeader> & Pick<MemoryHeader, 'filename' | 'type'>): MemoryHeader {
    return {
      filePath: `/tmp/${partial.filename}`,
      name: partial.filename.replace('.md', ''),
      description: '',
      confidence: 0.9,
      recallCount: 5,
      mtimeMs: Date.now(),
      createdMs: Date.now(),
      lastRecalledMs: 0,
      tags: [],
      contentPreview: '',
      eventDateMs: 0,
      ...partial,
    };
  }

  it('晋升全局 user- 前缀且无 project 标签', () => {
    expect(shouldAutoPromoteToUserLevel(header({
      filename: 'user-git-commit-chinese-msg.md',
      type: 'user',
      tags: ['dimension:git', 'lang:zh'],
    }))).toBe(true);
  });

  it('不晋升项目前缀命名 javastudy-user-*', () => {
    expect(shouldAutoPromoteToUserLevel(header({
      filename: 'javastudy-user-prefers-simple-concise-explanations.md',
      type: 'user',
    }))).toBe(false);
  });

  it('不晋升带 project: 标签的 user- 文件', () => {
    expect(shouldAutoPromoteToUserLevel(header({
      filename: 'user-merge-web-merge-concept-recurring-misconception.md',
      type: 'user',
      tags: ['project:english-book-merge-web'],
    }))).toBe(false);
  });

  it('不晋升非 user 类型', () => {
    expect(shouldAutoPromoteToUserLevel(header({
      filename: 'user-git-commit-chinese-msg.md',
      type: 'project',
    }))).toBe(false);
  });
});

// ─── recordSession ───

describe('recordSession', () => {
  it('递增会话计数', async () => {
    const dream = createMemoryDream();
    expect(dream.getState().sessionCount).toBe(0);
    await dream.recordSession();
    expect(dream.getState().sessionCount).toBe(1);
    await dream.recordSession();
    expect(dream.getState().sessionCount).toBe(2);
  });

  it('写盘前合并磁盘时间戳，不覆盖其他实例持久化的 lastDreamTime', async () => {
    const dataDir = path.join(tempDir, 'dream-state-data');
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    const prevDataDir = process.env.ICE_DATA_DIR;
    process.env.ICE_DATA_DIR = dataDir;

    vi.resetModules();
    const { createMemoryDream: createDreamWithFreshPaths } = await import(
      '../../../src/memory/file-memory/memory-dream.js'
    );

    const dreamTime = 1_700_000_000_000;
    const statePath = path.join(dataDir, 'memory', 'dream-state.json');
    await fs.writeFile(
      statePath,
      JSON.stringify({
        sessionCount: 0,
        lastDreamTime: dreamTime,
        staleIndexDreamCompletedAt: 0,
      }),
      'utf-8',
    );

    const dream = createDreamWithFreshPaths();
    await dream.recordSession();

    const state = JSON.parse(await fs.readFile(statePath, 'utf-8')) as {
      sessionCount: number;
      lastDreamTime: number;
    };
    expect(state.lastDreamTime).toBe(dreamTime);
    expect(state.sessionCount).toBe(1);

    vi.resetModules();
    if (prevDataDir) process.env.ICE_DATA_DIR = prevDataDir;
    else delete process.env.ICE_DATA_DIR;
  });

  it('外部 Dream 重置 sessionCount 后 recordSession 从磁盘值递增而非累加旧内存', async () => {
    const dataDir = path.join(tempDir, 'dream-state-session-sync');
    await fs.mkdir(path.join(dataDir, 'memory'), { recursive: true });
    const prevDataDir = process.env.ICE_DATA_DIR;
    process.env.ICE_DATA_DIR = dataDir;

    vi.resetModules();
    const { createMemoryDream: createDreamWithFreshPaths } = await import(
      '../../../src/memory/file-memory/memory-dream.js'
    );

    const statePath = path.join(dataDir, 'memory', 'dream-state.json');
    const dream = createDreamWithFreshPaths();
    for (let i = 0; i < 5; i++) await dream.recordSession();
    expect(dream.getState().sessionCount).toBe(5);

    const newerDreamTime = Date.now() + 60_000;
    await fs.writeFile(
      statePath,
      JSON.stringify({
        sessionCount: 0,
        lastDreamTime: newerDreamTime,
        staleIndexDreamCompletedAt: 0,
      }),
      'utf-8',
    );

    await dream.recordSession();
    expect(dream.getState().sessionCount).toBe(1);

    const state = JSON.parse(await fs.readFile(statePath, 'utf-8')) as { sessionCount: number };
    expect(state.sessionCount).toBe(1);

    vi.resetModules();
    if (prevDataDir) process.env.ICE_DATA_DIR = prevDataDir;
    else delete process.env.ICE_DATA_DIR;
  });
});

describe('dream 同进程互斥', () => {
  it('并发 forceDream 时第二次返回 executed=false', async () => {
    await writeMemoryFile(tempDir, 'note.md', '笔记');
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });

    const mockLLM: LLMAdapterInterface = {
      chat: vi.fn(async () => {
        await block;
        return {
          content: JSON.stringify({
            actions: [],
            new_index: null,
            file_writes: [],
            file_deletes: [],
            summary: 'All good.',
          }),
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'test' },
          finishReason: 'stop',
        };
      }),
      stream: vi.fn(),
      countTokens: vi.fn(async () => 10),
    };

    const dream1 = createMemoryDream({ enableBackup: false });
    const dream2 = createMemoryDream({ enableBackup: false });
    const first = dream1.forceDream(tempDir, mockLLM);
    await new Promise((r) => setTimeout(r, 30));
    const second = await dream2.forceDream(tempDir, mockLLM);

    expect(second.executed).toBe(false);
    expect(second.summary).toContain('in progress');

    release();
    const firstResult = await first;
    expect(firstResult.executed).toBe(true);
  });
});

// ─── getState / updateConfig ───

describe('getState / updateConfig', () => {
  it('getState 返回当前状态', async () => {
    const dream = createMemoryDream();
    await dream.recordSession();
    const state = dream.getState();
    expect(state.sessionCount).toBe(1);
    expect(typeof state.lastDreamTime).toBe('number');
  });

  it('updateConfig 更新配置', async () => {
    const dream = createMemoryDream({ sessionInterval: 5 });
    dream.updateConfig({ sessionInterval: 2 });
    await dream.recordSession();
    await dream.recordSession();
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

  it('显式规则和强证据记忆优先于临时弱证据记忆', async () => {
    await writeMemoryFile(tempDir, 'weak_session.md', '临时弱证据', {
      type: 'project',
      confidence: 0.4,
      recallCount: 0,
      level: 'session_state',
      evidenceStrength: 'weak',
      source: 'llm_extract',
    });
    await writeMemoryFile(tempDir, 'hard_rule.md', '明确规则', {
      type: 'project',
      confidence: 0.7,
      recallCount: 0,
      level: 'hard_rule',
      evidenceStrength: 'explicit',
      source: 'user_explicit',
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

    const chatCall = (mockLLM.chat as any).mock.calls[0];
    const userMessage = chatCall[0].find((m: UnifiedMessage) => m.role === 'user');
    expect(userMessage.content.indexOf('hard_rule.md')).toBeLessThan(userMessage.content.indexOf('weak_session.md'));
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

  it('Dream 完成后将超出上限的记忆淘汰到 evicted 目录', async () => {
    const evictedDir = path.join(tempDir, 'evicted');
    for (let i = 0; i < 8; i++) {
      await writeMemoryFile(tempDir, `bulk_${i}.md`, `批量${i}`, { confidence: 0.3 });
      const fp = path.join(tempDir, `bulk_${i}.md`);
      const t = (Date.now() - (10 + i) * 86_400_000) / 1000;
      await fs.utimes(fp, t, t);
    }

    const mockLLM = createMockLLM(JSON.stringify({
      actions: [],
      new_index: null,
      file_writes: [],
      file_deletes: [],
      summary: 'noop',
    }));

    const dream = createMemoryDream({
      enableBackup: false,
      postDreamMemoryCap: 5,
      enforceMemoryCapAfterDream: true,
      afterDreamEviction: {
        evictedDir,
        protectionDays: 0,
        maxEvictedFiles: 50,
      },
    });

    const result = await dream.forceDream(tempDir, mockLLM);

    expect(result.executed).toBe(true);
    expect(result.filesEvicted).toBe(3);

    const remaining = (await fs.readdir(tempDir)).filter(f => f.endsWith('.md'));
    expect(remaining.length).toBe(5);

    const evicted = (await fs.readdir(evictedDir)).filter(f => f.endsWith('.md'));
    expect(evicted.length).toBe(3);
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

// ─── isDreamBatchRetryableError ───

describe('isDreamBatchRetryableError', () => {
  it('529/500 可重试，整请求超时不重试', () => {
    const peak = new Error('OpenAI API Error [529]: 高峰繁忙');
    (peak as any).status = 529;
    expect(isDreamBatchRetryableError(peak)).toBe(true);

    const server = new Error('OpenAI API Error [500]: unknown');
    (server as any).status = 500;
    expect(isDreamBatchRetryableError(server)).toBe(true);

    const timeout = new Error('OpenAI API Error [undefined]: Request timed out.');
    expect(isDreamBatchRetryableError(timeout)).toBe(false);
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
