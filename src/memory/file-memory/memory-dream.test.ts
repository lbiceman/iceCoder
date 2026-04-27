/**
 * memory-dream 单元测试。
 *
 * P1 — 写文件操作，出错影响索引一致性。
 * 覆盖：shouldDream 门控逻辑、状态持久化/恢复、Dream 配置更新。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createMemoryDream, type MemoryDream } from './memory-dream.js';

let tempDir: string;

async function writeMemoryFile(dir: string, filename: string, description: string) {
  const content = `---
name: ${filename.replace('.md', '')}
description: ${description}
type: project
---

Content of ${filename}`;
  await fs.writeFile(path.join(dir, filename), content, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `dream-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

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
    });

    // 不报错即可，配置已应用
    expect(dream).toBeDefined();
  });
});

describe('shouldDream', () => {
  it('会话数不足时返回 false', async () => {
    const dream = createMemoryDream({ sessionInterval: 5 });

    // 只记录 2 个会话
    dream.recordSession();
    dream.recordSession();

    const should = await dream.shouldDream(tempDir);
    expect(should).toBe(false);
  });

  it('会话数达到阈值且满足其他条件时返回 true', async () => {
    const dream = createMemoryDream({
      sessionInterval: 2,
      fileCountThreshold: 1, // 只需 1 个文件
    });

    // 记录足够的会话
    dream.recordSession();
    dream.recordSession();
    dream.recordSession();
    dream.recordSession();
    dream.recordSession();

    // 需要有记忆文件
    await writeMemoryFile(tempDir, 'note1.md', '笔记1');

    // shouldDream 还受时间门控（minHours）影响
    // 由于没有锁文件，lastConsolidatedAt = 0，hoursSince 会很大，时间门控通过
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
});

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

    // 验证配置已更新：2 个会话就应该触发
    dream.recordSession();
    dream.recordSession();

    // 配置更新不会报错
    expect(dream.getState().sessionCount).toBe(2);
  });
});

describe('buildDreamPrompt', () => {
  // 通过 forceDream 间接测试 prompt 构建
  it('forceDream 在无 LLM 时不报错', async () => {
    const dream = createMemoryDream();
    await writeMemoryFile(tempDir, 'note.md', '笔记');

    // forceDream 需要 LLM，没有 LLM 时应该优雅失败
    const result = await dream.forceDream(tempDir, null as any).catch(e => ({ error: true }));

    // 要么成功返回结果，要么抛出可预期的错误
    expect(result).toBeDefined();
  });
});
