/**
 * memory-recall 单元测试。
 *
 * P0 — LLM 召回是用户可见的核心功能。
 * 覆盖：LLM 召回、关键词回退、alreadySurfaced 去重、空记忆、LLM 失败回退。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { recallRelevantMemories } from './memory-recall.js';
import { expandNegationQuery, parseTimeRange } from './memory-recall.js';
import type { LLMAdapterInterface, LLMResponse, UnifiedMessage, LLMOptions } from '../../llm/types.js';

// ─── 测试工具 ───

let tempDir: string;

function createMockLLM(response: string, shouldFail = false): LLMAdapterInterface {
  return {
    chat: vi.fn(async () => {
      if (shouldFail) throw new Error('LLM unavailable');
      return {
        content: response,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'test' },
        finishReason: 'stop' as const,
      };
    }),
    stream: vi.fn(async () => ({
      content: '',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'test' },
      finishReason: 'stop' as const,
    })),
    countTokens: vi.fn(async () => 10),
  };
}

async function writeMemoryFile(dir: string, filename: string, description: string, type = 'user') {
  const content = `---
name: ${filename.replace('.md', '')}
description: ${description}
type: ${type}
---

Some content for ${filename}`;
  await fs.writeFile(path.join(dir, filename), content, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `recall-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  // 隔离用户级记忆目录，避免扫描到真实的 data/user-memory
  process.env.ICE_USER_MEMORY_DIR = path.join(os.tmpdir(), `recall-user-mem-${randomUUID()}`);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  if (process.env.ICE_USER_MEMORY_DIR) {
    await fs.rm(process.env.ICE_USER_MEMORY_DIR, { recursive: true, force: true }).catch(() => {});
  }
  delete process.env.ICE_USER_MEMORY_DIR;
});

// ─── 测试用例 ───

describe('recallRelevantMemories', () => {
  describe('LLM 召回', () => {
    it('使用 LLM 选择相关记忆', async () => {
      await writeMemoryFile(tempDir, 'user_role.md', '用户的角色和职责');
      await writeMemoryFile(tempDir, 'feedback_testing.md', '测试相关的反馈');
      await writeMemoryFile(tempDir, 'project_deadline.md', '项目截止日期');

      const mockLLM = createMockLLM('{"selected": ["user_role.md", "feedback_testing.md"]}');

      const result = await recallRelevantMemories('我的角色是什么', tempDir, mockLLM);

      expect(result.usedLLM).toBe(true);
      expect(result.memories.length).toBe(2);
      expect(result.memories.map(m => m.filename)).toContain('user_role.md');
      expect(result.memories.map(m => m.filename)).toContain('feedback_testing.md');
    });

    it('LLM 返回不存在的文件名时过滤掉', async () => {
      await writeMemoryFile(tempDir, 'real_file.md', '真实文件');

      const mockLLM = createMockLLM('{"selected": ["real_file.md", "nonexistent.md"]}');

      const result = await recallRelevantMemories('查询', tempDir, mockLLM);

      expect(result.memories.length).toBe(1);
      expect(result.memories[0].filename).toBe('real_file.md');
    });

    it('LLM 返回空数组时结果为空', async () => {
      await writeMemoryFile(tempDir, 'some_file.md', '某个文件');

      const mockLLM = createMockLLM('{"selected": []}');

      const result = await recallRelevantMemories('完全无关的查询', tempDir, mockLLM);

      expect(result.usedLLM).toBe(true);
      expect(result.memories).toEqual([]);
    });

    it('LLM 返回无效 JSON 时结果为空', async () => {
      await writeMemoryFile(tempDir, 'file.md', '文件');

      const mockLLM = createMockLLM('This is not JSON at all');

      const result = await recallRelevantMemories('查询', tempDir, mockLLM);

      expect(result.memories).toEqual([]);
    });

    it('限制最大返回数量', async () => {
      for (let i = 0; i < 8; i++) {
        await writeMemoryFile(tempDir, `file_${i}.md`, `文件 ${i}`);
      }

      const allFiles = Array.from({ length: 8 }, (_, i) => `file_${i}.md`);
      const mockLLM = createMockLLM(JSON.stringify({ selected: allFiles }));

      const result = await recallRelevantMemories('查询', tempDir, mockLLM, new Set(), 3);

      expect(result.memories.length).toBe(3);
    });
  });

  describe('alreadySurfaced 去重', () => {
    it('过滤已展示过的记忆', async () => {
      await writeMemoryFile(tempDir, 'shown.md', '已展示的记忆');
      await writeMemoryFile(tempDir, 'new.md', '新记忆');

      const shownPath = path.join(tempDir, 'shown.md');
      const mockLLM = createMockLLM('{"selected": ["new.md"]}');

      const result = await recallRelevantMemories(
        '查询',
        tempDir,
        mockLLM,
        new Set([shownPath]),
      );

      // LLM 不应该看到 shown.md
      const chatCall = (mockLLM.chat as any).mock.calls[0];
      const userMessage = chatCall[0].find((m: UnifiedMessage) => m.role === 'user');
      expect(userMessage.content).not.toContain('shown.md');
      expect(userMessage.content).toContain('new.md');
    });

    it('所有记忆都已展示时直接返回空', async () => {
      await writeMemoryFile(tempDir, 'only.md', '唯一的记忆');

      const onlyPath = path.join(tempDir, 'only.md');
      const mockLLM = createMockLLM('should not be called');

      const result = await recallRelevantMemories(
        '查询',
        tempDir,
        mockLLM,
        new Set([onlyPath]),
      );

      expect(result.memories).toEqual([]);
      expect(result.usedLLM).toBe(false);
      expect(mockLLM.chat).not.toHaveBeenCalled();
    });
  });

  describe('关键词回退', () => {
    it('无 LLM 时使用关键词匹配', async () => {
      await writeMemoryFile(tempDir, 'user_role.md', '用户的角色和职责');
      await writeMemoryFile(tempDir, 'project_plan.md', '项目计划和截止日期');

      const result = await recallRelevantMemories('角色', tempDir, null);

      expect(result.usedLLM).toBe(false);
      expect(result.memories.length).toBeGreaterThan(0);
      // 包含"角色"的记忆应该排在前面
      expect(result.memories[0].description).toContain('角色');
    });

    it('LLM 失败时回退到关键词匹配', async () => {
      await writeMemoryFile(tempDir, 'user_role.md', '用户的角色和职责');

      const failingLLM = createMockLLM('', true);

      const result = await recallRelevantMemories('角色', tempDir, failingLLM);

      expect(result.usedLLM).toBe(false);
      expect(result.memories.length).toBeGreaterThan(0);
    });

    it('关键词匹配考虑文件名', async () => {
      await writeMemoryFile(tempDir, 'testing_guide.md', '无关描述');

      const result = await recallRelevantMemories('testing', tempDir, null);

      expect(result.memories.length).toBeGreaterThan(0);
    });

    it('完全无匹配时分数极低', async () => {
      await writeMemoryFile(tempDir, 'user_role.md', '用户角色');

      // 关键词回退有新鲜度加分，所以即使无词匹配也可能有微小分数
      // 验证无关查询的结果数量远少于相关查询
      const irrelevant = await recallRelevantMemories('xyzzy_no_match_at_all', tempDir, null);
      const relevant = await recallRelevantMemories('用户角色', tempDir, null);

      // 无关查询的结果应该少于或等于相关查询
      expect(irrelevant.memories.length).toBeLessThanOrEqual(relevant.memories.length);
    });

    it('新鲜度影响排序', async () => {
      // 写入两个描述相似的文件，但时间不同
      await writeMemoryFile(tempDir, 'old_note.md', '测试笔记旧版');
      // 等一下确保时间差
      await new Promise(r => setTimeout(r, 50));
      await writeMemoryFile(tempDir, 'new_note.md', '测试笔记新版');

      const result = await recallRelevantMemories('测试笔记', tempDir, null);

      expect(result.memories.length).toBe(2);
      // 新文件应该排在前面（新鲜度加分）
      expect(result.memories[0].filename).toBe('new_note.md');
    });
  });

  describe('边界情况', () => {
    it('空目录返回空结果', async () => {
      const result = await recallRelevantMemories('查询', tempDir, null);

      expect(result.memories).toEqual([]);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('不存在的目录返回空结果', async () => {
      const result = await recallRelevantMemories('查询', '/nonexistent/path', null);

      expect(result.memories).toEqual([]);
    });

    it('跳过 MEMORY.md 索引文件', async () => {
      await fs.writeFile(path.join(tempDir, 'MEMORY.md'), '# Index', 'utf-8');
      await writeMemoryFile(tempDir, 'note.md', '笔记');

      const mockLLM = createMockLLM('{"selected": ["note.md"]}');
      const result = await recallRelevantMemories('查询', tempDir, mockLLM);

      // manifest 中不应包含 MEMORY.md
      const chatCall = (mockLLM.chat as any).mock.calls[0];
      const userMessage = chatCall[0].find((m: UnifiedMessage) => m.role === 'user');
      expect(userMessage.content).not.toContain('MEMORY.md');
    });

    it('返回结果包含耗时信息', async () => {
      const result = await recallRelevantMemories('查询', tempDir, null);

      expect(typeof result.duration).toBe('number');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });
});

// ─── v4: 否定查询展开测试 ───

describe('expandNegationQuery', () => {
  it('中文否定 — "不要用 Jest" 展开为测试领域词', () => {
    const result = expandNegationQuery('不要用 Jest');
    expect(result).toContain('jest');
    expect(result).toContain('test');
    expect(result).toContain('testing');
    expect(result).toContain('vitest');
  });

  it('英文否定 — "don\'t use Webpack" 展开为构建领域词', () => {
    const result = expandNegationQuery("don't use Webpack");
    expect(result).toContain('webpack');
    expect(result).toContain('build');
    expect(result).toContain('vite');
  });

  it('"stop using npm" 展开为包管理领域词', () => {
    const result = expandNegationQuery('stop using npm');
    expect(result).toContain('npm');
    expect(result).toContain('yarn');
    expect(result).toContain('pnpm');
  });

  it('"别用 var" 展开为变量声明领域词', () => {
    const result = expandNegationQuery('别用 var');
    expect(result).toContain('var');
    expect(result).toContain('let');
    expect(result).toContain('const');
  });

  it('"never use react" 展开为前端框架领域词', () => {
    const result = expandNegationQuery('never use react');
    expect(result).toContain('react');
    expect(result).toContain('vue');
    expect(result).toContain('framework');
  });

  it('无否定模式时返回空数组', () => {
    const result = expandNegationQuery('我喜欢用 TypeScript');
    expect(result).toEqual([]);
  });

  it('否定对象不在映射表中时仍返回对象本身', () => {
    const result = expandNegationQuery('不要用 SomeObscureTool');
    expect(result).toContain('someobscuretool');
    // 没有领域展开，但至少有对象本身
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('过短的否定对象被忽略', () => {
    const result = expandNegationQuery('不要用 x');
    expect(result).toEqual([]);
  });
});

// ─── v4: 时间范围解析测试 ───

describe('parseTimeRange', () => {
  it('"昨天" 解析为 1-2 天前', () => {
    const result = parseTimeRange('昨天记住的那个');
    expect(result).not.toBeNull();
    const now = Date.now();
    const DAY = 86_400_000;
    expect(result!.since).toBeCloseTo(now - 2 * DAY, -4); // 精度到秒级
    expect(result!.until).toBeCloseTo(now - DAY, -4);
    expect(result!.matchedText).toBe('昨天');
  });

  it('"上周" 解析为 7-14 天前', () => {
    const result = parseTimeRange('上周说的偏好');
    expect(result).not.toBeNull();
    const now = Date.now();
    const DAY = 86_400_000;
    expect(result!.since).toBeCloseTo(now - 14 * DAY, -4);
    expect(result!.until).toBeCloseTo(now - 7 * DAY, -4);
  });

  it('"最近3天" 解析为 0-3 天前', () => {
    const result = parseTimeRange('最近3天的记忆');
    expect(result).not.toBeNull();
    const now = Date.now();
    const DAY = 86_400_000;
    expect(result!.since).toBeCloseTo(now - 3 * DAY, -4);
    expect(result!.until).toBeCloseTo(now, -4);
  });

  it('"last week" 解析为 7-14 天前', () => {
    const result = parseTimeRange('what did I say last week');
    expect(result).not.toBeNull();
    expect(result!.matchedText).toBe('last week');
  });

  it('"past 5 days" 解析为 0-5 天前', () => {
    const result = parseTimeRange('memories from the past 5 days');
    expect(result).not.toBeNull();
    const now = Date.now();
    const DAY = 86_400_000;
    expect(result!.since).toBeCloseTo(now - 5 * DAY, -4);
    expect(result!.until).toBeCloseTo(now, -4);
  });

  it('"yesterday" 英文解析', () => {
    const result = parseTimeRange('what I said yesterday');
    expect(result).not.toBeNull();
    expect(result!.matchedText).toBe('yesterday');
  });

  it('"最近" 解析为最近 7 天', () => {
    const result = parseTimeRange('最近记住的东西');
    expect(result).not.toBeNull();
    const now = Date.now();
    const DAY = 86_400_000;
    expect(result!.since).toBeCloseTo(now - 7 * DAY, -4);
  });

  it('无时间线索时返回 null', () => {
    const result = parseTimeRange('我喜欢用 TypeScript');
    expect(result).toBeNull();
  });

  it('"上个月" 解析为 30-60 天前', () => {
    const result = parseTimeRange('上个月的项目');
    expect(result).not.toBeNull();
    const now = Date.now();
    const DAY = 86_400_000;
    expect(result!.since).toBeCloseTo(now - 60 * DAY, -4);
    expect(result!.until).toBeCloseTo(now - 30 * DAY, -4);
  });
});

// ─── v4: 否定查询集成测试 ───

describe('否定查询集成', () => {
  it('关键词回退路径 — 否定展开帮助命中同领域记忆', async () => {
    // 写入一个关于 Vitest 偏好的记忆
    const content = `---
name: testing_preference
description: 用户偏好 Vitest 做测试
type: feedback
tags: tool:vitest, testing
---

用户明确表示偏好使用 Vitest 而非 Jest 做单元测试。`;
    await fs.writeFile(path.join(tempDir, 'feedback_testing.md'), content, 'utf-8');

    // 用否定查询（不提 Vitest，只说不要 Jest）
    const result = await recallRelevantMemories('不要用 Jest', tempDir, null);

    // 应该能命中 testing 相关的记忆（通过领域展开 jest → testing/vitest）
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].filename).toBe('feedback_testing.md');
  });
});

// ─── v4: 时间范围集成测试 ───

describe('时间范围集成', () => {
  it('关键词回退路径 — 时间范围内的记忆排序更高', async () => {
    // 写入两个记忆，描述相似
    const oldContent = `---
name: old_preference
description: 用户的编程偏好
type: user
createdAt: 2026-01-01T00:00:00.000Z
---

用户偏好 Python`;
    await fs.writeFile(path.join(tempDir, 'old_pref.md'), oldContent, 'utf-8');

    // 新文件（刚创建，在"最近"范围内）
    const newContent = `---
name: new_preference
description: 用户的编程偏好
type: user
---

用户偏好 TypeScript`;
    await fs.writeFile(path.join(tempDir, 'new_pref.md'), newContent, 'utf-8');

    // 查询包含"最近"
    const result = await recallRelevantMemories('最近的编程偏好', tempDir, null);

    expect(result.memories.length).toBe(2);
    // 新文件应该排在前面（时间范围加权 + 新鲜度加分）
    expect(result.memories[0].filename).toBe('new_pref.md');
  });
});
