/**
 * session-memory 单元测试。
 *
 * P1 — 触发条件是有状态的判断逻辑，边界情况多。
 * 覆盖：shouldUpdateSessionMemory 双阈值触发、模板创建、section 截断、空检测。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  shouldUpdateSessionMemory,
  initSessionMemoryState,
  setupSessionMemoryFile,
  buildSessionMemoryUpdatePrompt,
  truncateSessionMemoryForCompact,
  isSessionMemoryEmpty,
  getSessionMemoryContent,
  SESSION_MEMORY_TEMPLATE,
  type SessionMemoryState,
} from './session-memory.js';

// Mock remote config
vi.mock('./memory-remote-config.js', () => ({
  getSessionMemoryConfig: vi.fn(() => ({
    enabled: true,
    minTokensToInit: 1000,
    minTokensBetweenUpdate: 500,
    toolCallsBetweenUpdates: 3,
  })),
}));

let tempDir: string;
let state: SessionMemoryState;

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `session-mem-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  state = initSessionMemoryState(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ─── shouldUpdateSessionMemory ───

describe('shouldUpdateSessionMemory', () => {
  it('token 不足时返回 false（未初始化）', () => {
    const result = shouldUpdateSessionMemory(state, 500, 10, false);
    expect(result).toBe(false);
    expect(state.initialized).toBe(false);
  });

  it('token 达到初始化阈值后标记 initialized', () => {
    shouldUpdateSessionMemory(state, 1500, 0, false);
    expect(state.initialized).toBe(true);
  });

  it('初始化后 token 增长不足时返回 false', () => {
    // 先初始化
    state.initialized = true;
    state.tokensAtLastExtraction = 1000;

    // token 增长 200 < 500 阈值
    const result = shouldUpdateSessionMemory(state, 1200, 5, false);
    expect(result).toBe(false);
  });

  it('token 阈值 + 工具调用阈值都满足时返回 true', () => {
    state.initialized = true;
    state.tokensAtLastExtraction = 1000;

    // token 增长 600 >= 500，工具调用 5 >= 3
    const result = shouldUpdateSessionMemory(state, 1600, 5, true);
    expect(result).toBe(true);
  });

  it('token 阈值满足 + 无工具调用（自然断点）时返回 true', () => {
    state.initialized = true;
    state.tokensAtLastExtraction = 1000;

    // token 增长 600 >= 500，工具调用 1 < 3，但 hasToolCallsInLastTurn = false
    const result = shouldUpdateSessionMemory(state, 1600, 1, false);
    expect(result).toBe(true);
  });

  it('token 阈值满足但工具调用不足且有工具调用时返回 false', () => {
    state.initialized = true;
    state.tokensAtLastExtraction = 1000;

    // token 增长 600 >= 500，工具调用 1 < 3，hasToolCallsInLastTurn = true
    const result = shouldUpdateSessionMemory(state, 1600, 1, true);
    expect(result).toBe(false);
  });

  it('工具调用满足但 token 不足时返回 false', () => {
    state.initialized = true;
    state.tokensAtLastExtraction = 1000;

    // token 增长 100 < 500，工具调用 10 >= 3
    const result = shouldUpdateSessionMemory(state, 1100, 10, false);
    expect(result).toBe(false);
  });
});

// ─── setupSessionMemoryFile ───

describe('setupSessionMemoryFile', () => {
  it('创建模板文件', async () => {
    const content = await setupSessionMemoryFile(state);

    expect(content).toContain('# Session Title');
    expect(content).toContain('# Current State');
    expect(content).toContain('# Worklog');
  });

  it('文件已存在时不覆盖', async () => {
    const customContent = '# Custom Notes\nMy notes';
    await fs.writeFile(state.notesPath, customContent, 'utf-8');

    const content = await setupSessionMemoryFile(state);

    expect(content).toBe(customContent);
  });

  it('自动创建目录', async () => {
    const nestedDir = path.join(tempDir, 'nested', 'deep');
    const nestedState = initSessionMemoryState(nestedDir);

    const content = await setupSessionMemoryFile(nestedState);

    expect(content).toContain('# Session Title');
  });
});

// ─── buildSessionMemoryUpdatePrompt ───

describe('buildSessionMemoryUpdatePrompt', () => {
  it('包含当前笔记内容', () => {
    const notes = '# Session Title\n测试会话\n\n# Current State\n正在测试';
    const prompt = buildSessionMemoryUpdatePrompt(notes, '/path/to/notes.md');

    expect(prompt).toContain('测试会话');
    expect(prompt).toContain('正在测试');
    expect(prompt).toContain('/path/to/notes.md');
  });

  it('包含编辑规则', () => {
    const prompt = buildSessionMemoryUpdatePrompt(SESSION_MEMORY_TEMPLATE, '/notes.md');

    expect(prompt).toContain('section 标题');
    expect(prompt).toContain('write_file');
  });

  it('超大 section 时生成精简提醒', () => {
    // 构造一个超大的 section
    const bigSection = '# Session Title\n测试\n\n# Current State\n' + 'x'.repeat(10000);
    const prompt = buildSessionMemoryUpdatePrompt(bigSection, '/notes.md');

    expect(prompt).toContain('精简');
  });
});

// ─── truncateSessionMemoryForCompact ───

describe('truncateSessionMemoryForCompact', () => {
  it('短内容不截断', () => {
    const content = '# Session Title\n测试标题\n\n# Current State\n正在工作';
    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(content);

    expect(wasTruncated).toBe(false);
    expect(truncatedContent).toBe(content);
  });

  it('超长 section 被截断', () => {
    const longContent = '# Session Title\n测试\n\n# Current State\n' + 'A'.repeat(20000);
    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(longContent);

    expect(wasTruncated).toBe(true);
    expect(truncatedContent).toContain('截断');
    expect(truncatedContent.length).toBeLessThan(longContent.length);
  });

  it('保留所有 section 标题', () => {
    const content = SESSION_MEMORY_TEMPLATE.replace(
      '# Worklog\n_逐步记录尝试了什么、做了什么？每步非常简短的摘要_',
      '# Worklog\n' + 'log entry\n'.repeat(3000),
    );

    const { truncatedContent } = truncateSessionMemoryForCompact(content);

    expect(truncatedContent).toContain('# Session Title');
    expect(truncatedContent).toContain('# Current State');
    expect(truncatedContent).toContain('# Worklog');
  });
});

// ─── isSessionMemoryEmpty ───

describe('isSessionMemoryEmpty', () => {
  it('模板内容返回 true', () => {
    expect(isSessionMemoryEmpty(SESSION_MEMORY_TEMPLATE)).toBe(true);
  });

  it('有实际内容返回 false', () => {
    const content = SESSION_MEMORY_TEMPLATE.replace(
      '_简短而独特的 5-10 词描述性标题，信息密集，无填充词_',
      '修复登录页面 Bug',
    );
    expect(isSessionMemoryEmpty(content)).toBe(false);
  });

  it('空字符串返回 false（不等于模板）', () => {
    expect(isSessionMemoryEmpty('')).toBe(false);
  });
});

// ─── getSessionMemoryContent ───

describe('getSessionMemoryContent', () => {
  it('文件存在时返回内容', async () => {
    await fs.writeFile(state.notesPath, '# Notes\nContent', 'utf-8');

    const content = await getSessionMemoryContent(state);
    expect(content).toBe('# Notes\nContent');
  });

  it('文件不存在时返回 null', async () => {
    const content = await getSessionMemoryContent(state);
    expect(content).toBeNull();
  });
});

// ─── initSessionMemoryState ───

describe('initSessionMemoryState', () => {
  it('创建独立的状态实例', () => {
    const state1 = initSessionMemoryState('/dir1');
    const state2 = initSessionMemoryState('/dir2');

    state1.initialized = true;
    state1.tokensAtLastExtraction = 5000;

    expect(state2.initialized).toBe(false);
    expect(state2.tokensAtLastExtraction).toBe(0);
  });

  it('notesPath 指向 session-notes.md', () => {
    const s = initSessionMemoryState('/my/session');
    expect(s.notesPath).toBe(path.join('/my/session', 'session-notes.md'));
  });
});
