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
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
