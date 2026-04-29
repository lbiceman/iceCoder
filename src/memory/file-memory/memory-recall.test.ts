/**
 * memory-recall 单元测试（v5 — TF-IDF 加权 + 完整覆盖）。
 *
 * 覆盖：
 * - LLM 召回（正常、空、无效 JSON、限制数量、过滤不存在文件）
 * - alreadySurfaced 去重
 * - 关键词回退（TF-IDF 加权、description/filename 权重 ×2、新鲜度、置信度、频率）
 * - 否定查询展开（中文、英文、领域展开、无映射、过短）
 * - 时间范围解析（中文、英文、固定模式、无时间线索）
 * - 关联扩展（显式 relatedTo、隐式 tags Jaccard、maxExpand 限制）
 * - buildIdfMap（IDF 计算、单文档平滑、空输入）
 * - 边界情况（空目录、不存在目录、MEMORY.md 跳过、耗时）
 * - 集成测试（否定 + 关键词回退、时间范围 + 排序）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  recallRelevantMemories,
  expandNegationQuery,
  parseTimeRange,
  expandRelatedMemories,
  buildIdfMap,
} from './memory-recall.js';
import type { MemoryHeader } from './types.js';
import type { LLMAdapterInterface, UnifiedMessage } from '../../llm/types.js';

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

async function writeMemoryFile(
  dir: string,
  filename: string,
  description: string,
  opts: { type?: string; tags?: string; confidence?: number; relatedTo?: string; content?: string } = {},
) {
  const type = opts.type ?? 'user';
  const tags = opts.tags ? `\ntags: ${opts.tags}` : '';
  const confidence = opts.confidence !== undefined ? `\nconfidence: ${opts.confidence}` : '';
  const relatedTo = opts.relatedTo ? `\nrelatedTo: ${opts.relatedTo}` : '';
  const body = opts.content ?? `Some content for ${filename}`;
  const fileContent = `---
name: ${filename.replace('.md', '')}
description: ${description}
type: ${type}${tags}${confidence}${relatedTo}
---

${body}`;
  await fs.writeFile(path.join(dir, filename), fileContent, 'utf-8');
}

function makeHeader(overrides: Partial<MemoryHeader> & { filename: string }): MemoryHeader {
  return {
    filePath: `/tmp/${overrides.filename}`,
    mtimeMs: Date.now(),
    description: null,
    type: undefined,
    confidence: 0.5,
    recallCount: 0,
    lastRecalledMs: 0,
    createdMs: Date.now(),
    tags: [],
    source: undefined,
    contentPreview: '',
    relatedTo: [],
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `recall-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  process.env.ICE_USER_MEMORY_DIR = path.join(os.tmpdir(), `recall-user-mem-${randomUUID()}`);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  if (process.env.ICE_USER_MEMORY_DIR) {
    await fs.rm(process.env.ICE_USER_MEMORY_DIR, { recursive: true, force: true }).catch(() => {});
  }
  delete process.env.ICE_USER_MEMORY_DIR;
});

// ─── LLM 召回 ───

describe('recallRelevantMemories — LLM 路径', () => {
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

  it('LLM 失败时回退到关键词匹配', async () => {
    await writeMemoryFile(tempDir, 'user_role.md', '用户的角色和职责');
    const failingLLM = createMockLLM('', true);
    const result = await recallRelevantMemories('角色', tempDir, failingLLM);

    expect(result.usedLLM).toBe(false);
    expect(result.memories.length).toBeGreaterThan(0);
  });

  it('召回结果包含 facts', async () => {
    await writeMemoryFile(tempDir, 'user_role.md', '用户角色', {
      content: '用户是前端开发者\n用户偏好 React\n用户在创业公司工作',
    });
    const mockLLM = createMockLLM('{"selected": ["user_role.md"]}');
    const result = await recallRelevantMemories('用户角色', tempDir, mockLLM);

    expect(result.facts.length).toBeGreaterThan(0);
  });
});

// ─── alreadySurfaced 去重 ───

describe('recallRelevantMemories — alreadySurfaced', () => {
  it('过滤已展示过的记忆', async () => {
    await writeMemoryFile(tempDir, 'shown.md', '已展示的记忆');
    await writeMemoryFile(tempDir, 'new.md', '新记忆');

    const shownPath = path.join(tempDir, 'shown.md');
    const mockLLM = createMockLLM('{"selected": ["new.md"]}');
    const result = await recallRelevantMemories('查询', tempDir, mockLLM, new Set([shownPath]));

    const chatCall = (mockLLM.chat as any).mock.calls[0];
    const userMessage = chatCall[0].find((m: UnifiedMessage) => m.role === 'user');
    expect(userMessage.content).not.toContain('shown.md');
    expect(userMessage.content).toContain('new.md');
  });

  it('所有记忆都已展示时直接返回空', async () => {
    await writeMemoryFile(tempDir, 'only.md', '唯一的记忆');
    const onlyPath = path.join(tempDir, 'only.md');
    const mockLLM = createMockLLM('should not be called');
    const result = await recallRelevantMemories('查询', tempDir, mockLLM, new Set([onlyPath]));

    expect(result.memories).toEqual([]);
    expect(result.usedLLM).toBe(false);
    expect(mockLLM.chat).not.toHaveBeenCalled();
  });
});

// ─── 关键词回退 + TF-IDF ───

describe('recallRelevantMemories — 关键词回退（TF-IDF 加权）', () => {
  it('无 LLM 时使用关键词匹配', async () => {
    await writeMemoryFile(tempDir, 'user_role.md', '用户的角色和职责');
    await writeMemoryFile(tempDir, 'project_plan.md', '项目计划和截止日期');
    const result = await recallRelevantMemories('角色', tempDir, null);

    expect(result.usedLLM).toBe(false);
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].description).toContain('角色');
  });

  it('关键词匹配考虑文件名', async () => {
    await writeMemoryFile(tempDir, 'testing_guide.md', '无关描述', { content: 'testing related content' });
    const result = await recallRelevantMemories('testing', tempDir, null);

    expect(result.memories.length).toBeGreaterThan(0);
  });

  it('TF-IDF 加权：稀有词命中排名更高', async () => {
    // "typescript" 只出现在 1 个文件 → 高 IDF
    // "用户" 出现在所有文件 → 低 IDF
    await writeMemoryFile(tempDir, 'ts_pref.md', '用户偏好 typescript 开发');
    await writeMemoryFile(tempDir, 'user_info.md', '用户的基本信息');
    await writeMemoryFile(tempDir, 'user_role.md', '用户的角色');

    const result = await recallRelevantMemories('typescript', tempDir, null);

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].filename).toBe('ts_pref.md');
  });

  it('description 命中权重高于 contentPreview', async () => {
    // desc_match: description 包含 "vitest"
    // content_match: description 无关，但 content 包含 "vitest"
    await writeMemoryFile(tempDir, 'desc_match.md', '用户偏好 vitest 测试框架', { content: '无关内容' });
    await writeMemoryFile(tempDir, 'content_match.md', '无关描述', { content: '用户偏好 vitest 测试框架' });

    const result = await recallRelevantMemories('vitest', tempDir, null);

    expect(result.memories.length).toBe(2);
    // description 命中的应该排在前面（权重 ×2）
    expect(result.memories[0].filename).toBe('desc_match.md');
  });

  it('完全无匹配时返回空', async () => {
    await writeMemoryFile(tempDir, 'user_role.md', '用户角色');
    const result = await recallRelevantMemories('xyzzy_no_match_at_all', tempDir, null);

    expect(result.memories.length).toBe(0);
  });

  it('新鲜度影响排序', async () => {
    await writeMemoryFile(tempDir, 'old_note.md', '测试笔记旧版');
    await new Promise(r => setTimeout(r, 50));
    await writeMemoryFile(tempDir, 'new_note.md', '测试笔记新版');

    const result = await recallRelevantMemories('测试笔记', tempDir, null);

    expect(result.memories.length).toBe(2);
    expect(result.memories[0].filename).toBe('new_note.md');
  });

  it('置信度影响排序', async () => {
    await writeMemoryFile(tempDir, 'low_conf.md', '编程偏好记录', { confidence: 0.3 });
    await writeMemoryFile(tempDir, 'high_conf.md', '编程偏好记录', { confidence: 1.0 });

    const result = await recallRelevantMemories('编程偏好', tempDir, null);

    expect(result.memories.length).toBe(2);
    expect(result.memories[0].filename).toBe('high_conf.md');
  });

  it('粗筛超过 maxResults 时触发精读二次评分', async () => {
    // 创建 20 个文件，都包含 "test" 关键词
    for (let i = 0; i < 20; i++) {
      await writeMemoryFile(tempDir, `test_${i}.md`, `test 相关文件 ${i}`);
    }
    const result = await recallRelevantMemories('test', tempDir, null, new Set(), 3);

    expect(result.memories.length).toBe(3);
  });
});

// ─── buildIdfMap ───

describe('buildIdfMap', () => {
  it('空输入返回空 Map', () => {
    const idf = buildIdfMap([]);
    expect(idf.size).toBe(0);
  });

  it('单文档场景 IDF > 0（平滑处理）', () => {
    const mem = makeHeader({
      filename: 'test.md',
      description: 'typescript project',
      contentPreview: 'some content',
    });
    const idf = buildIdfMap([mem]);

    // 所有 token 的 IDF 应该 > 0（平滑后 log(2/2) + 1 = 1）
    expect(idf.size).toBeGreaterThan(0);
    for (const val of idf.values()) {
      expect(val).toBeGreaterThan(0);
    }
  });

  it('稀有词 IDF 高于常见词', () => {
    const mems = [
      makeHeader({ filename: 'a.md', description: 'common word typescript', contentPreview: '' }),
      makeHeader({ filename: 'b.md', description: 'common word python', contentPreview: '' }),
      makeHeader({ filename: 'c.md', description: 'common word java', contentPreview: '' }),
    ];
    const idf = buildIdfMap(mems);

    // "common" 和 "word" 出现在所有 3 个文档 → 低 IDF
    // "typescript" 只出现在 1 个文档 → 高 IDF
    const commonIdf = idf.get('common') ?? 0;
    const tsIdf = idf.get('typescript') ?? 0;
    expect(tsIdf).toBeGreaterThan(commonIdf);
  });

  it('中文 bigram 也参与 IDF 计算', () => {
    const mems = [
      makeHeader({ filename: 'a.md', description: '数据库查询', contentPreview: '' }),
      makeHeader({ filename: 'b.md', description: '数据分析', contentPreview: '' }),
    ];
    const idf = buildIdfMap(mems);

    // "数据" bigram 出现在两个文档 → 较低 IDF
    // "据库" bigram 只出现在 1 个文档 → 较高 IDF
    expect(idf.has('数据')).toBe(true);
    expect(idf.has('据库')).toBe(true);
    expect(idf.get('据库')!).toBeGreaterThan(idf.get('数据')!);
  });
});

// ─── 否定查询展开 ───

describe('expandNegationQuery', () => {
  it('中文 "不要用 Jest" 展开为测试领域词', () => {
    const result = expandNegationQuery('不要用 Jest');
    expect(result).toContain('jest');
    expect(result).toContain('test');
    expect(result).toContain('testing');
    expect(result).toContain('vitest');
  });

  it('英文 "don\'t use Webpack" 展开为构建领域词', () => {
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

  it('"avoid mongodb" 展开为数据库领域词', () => {
    const result = expandNegationQuery('avoid mongodb');
    expect(result).toContain('mongodb');
    expect(result).toContain('database');
    expect(result).toContain('mysql');
  });

  it('无否定模式时返回空数组', () => {
    expect(expandNegationQuery('我喜欢用 TypeScript')).toEqual([]);
  });

  it('否定对象不在映射表中时仍返回对象本身', () => {
    const result = expandNegationQuery('不要用 SomeObscureTool');
    expect(result).toContain('someobscuretool');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('过短的否定对象被忽略', () => {
    expect(expandNegationQuery('不要用 x')).toEqual([]);
  });

  it('"禁止用 redis" 展开为缓存领域词', () => {
    const result = expandNegationQuery('禁止用 redis');
    expect(result).toContain('redis');
    expect(result).toContain('cache');
  });
});

// ─── 时间范围解析 ───

describe('parseTimeRange', () => {
  const DAY = 86_400_000;

  it('"昨天" 解析为 1-2 天前', () => {
    const result = parseTimeRange('昨天记住的那个');
    expect(result).not.toBeNull();
    const now = Date.now();
    expect(result!.since).toBeCloseTo(now - 2 * DAY, -4);
    expect(result!.until).toBeCloseTo(now - DAY, -4);
    expect(result!.matchedText).toBe('昨天');
  });

  it('"前天" 解析为 2-3 天前', () => {
    const result = parseTimeRange('前天的事');
    expect(result).not.toBeNull();
    const now = Date.now();
    expect(result!.since).toBeCloseTo(now - 3 * DAY, -4);
    expect(result!.until).toBeCloseTo(now - 2 * DAY, -4);
  });

  it('"上周" 解析为 7-14 天前', () => {
    const result = parseTimeRange('上周说的偏好');
    expect(result).not.toBeNull();
    const now = Date.now();
    expect(result!.since).toBeCloseTo(now - 14 * DAY, -4);
    expect(result!.until).toBeCloseTo(now - 7 * DAY, -4);
  });

  it('"这周/本周" 解析为最近 7 天', () => {
    const result = parseTimeRange('本周的工作');
    expect(result).not.toBeNull();
    const now = Date.now();
    expect(result!.since).toBeCloseTo(now - 7 * DAY, -4);
    expect(result!.until).toBeCloseTo(now, -4);
  });

  it('"上个月" 解析为 30-60 天前', () => {
    const result = parseTimeRange('上个月的项目');
    expect(result).not.toBeNull();
    const now = Date.now();
    expect(result!.since).toBeCloseTo(now - 60 * DAY, -4);
    expect(result!.until).toBeCloseTo(now - 30 * DAY, -4);
  });

  it('"最近3天" 解析为 0-3 天前', () => {
    const result = parseTimeRange('最近3天的记忆');
    expect(result).not.toBeNull();
    const now = Date.now();
    expect(result!.since).toBeCloseTo(now - 3 * DAY, -4);
    expect(result!.until).toBeCloseTo(now, -4);
  });

  it('"最近" 解析为最近 7 天', () => {
    const result = parseTimeRange('最近记住的东西');
    expect(result).not.toBeNull();
    const now = Date.now();
    expect(result!.since).toBeCloseTo(now - 7 * DAY, -4);
  });

  it('"last week" 英文解析', () => {
    const result = parseTimeRange('what did I say last week');
    expect(result).not.toBeNull();
    expect(result!.matchedText).toBe('last week');
  });

  it('"past 5 days" 英文解析', () => {
    const result = parseTimeRange('memories from the past 5 days');
    expect(result).not.toBeNull();
    const now = Date.now();
    expect(result!.since).toBeCloseTo(now - 5 * DAY, -4);
  });

  it('"yesterday" 英文解析', () => {
    const result = parseTimeRange('what I said yesterday');
    expect(result).not.toBeNull();
    expect(result!.matchedText).toBe('yesterday');
  });

  it('"this week" 英文解析', () => {
    const result = parseTimeRange('this week tasks');
    expect(result).not.toBeNull();
  });

  it('"last month" 英文解析', () => {
    const result = parseTimeRange('last month project');
    expect(result).not.toBeNull();
  });

  it('"recently" 英文解析', () => {
    const result = parseTimeRange('recently saved');
    expect(result).not.toBeNull();
  });

  it('无时间线索时返回 null', () => {
    expect(parseTimeRange('我喜欢用 TypeScript')).toBeNull();
  });

  it('超大天数被限制（>365 天忽略 N 天模式，回退到"最近"）', () => {
    // "最近999天" 的 N>365 被忽略，但"最近"固定模式仍会匹配
    const result = parseTimeRange('最近999天');
    // 匹配的是"最近"而非"最近999天"
    expect(result).not.toBeNull();
    expect(result!.matchedText).toBe('最近');
  });
});

// ─── 关联扩展 ───

describe('expandRelatedMemories', () => {
  it('显式 relatedTo 扩展', () => {
    const selected = [makeHeader({ filename: 'a.md', relatedTo: ['b.md'] })];
    const all = [
      makeHeader({ filename: 'a.md' }),
      makeHeader({ filename: 'b.md' }),
      makeHeader({ filename: 'c.md' }),
    ];
    const expanded = expandRelatedMemories(selected, all, new Set());

    expect(expanded.length).toBe(1);
    expect(expanded[0].filename).toBe('b.md');
  });

  it('隐式 tags Jaccard ≥ 0.3 扩展', () => {
    const selected = [makeHeader({ filename: 'a.md', tags: ['lang:ts', 'tool:vite', 'test'] })];
    const all = [
      makeHeader({ filename: 'a.md', tags: ['lang:ts', 'tool:vite', 'test'] }),
      makeHeader({ filename: 'b.md', tags: ['lang:ts', 'tool:vite'] }), // Jaccard = 2/3 ≈ 0.67
      makeHeader({ filename: 'c.md', tags: ['unrelated'] }), // Jaccard = 0
    ];
    const expanded = expandRelatedMemories(selected, all, new Set());

    expect(expanded.length).toBe(1);
    expect(expanded[0].filename).toBe('b.md');
  });

  it('不扩展已选中的文件', () => {
    const selected = [
      makeHeader({ filename: 'a.md', relatedTo: ['b.md'] }),
      makeHeader({ filename: 'b.md' }),
    ];
    const all = [makeHeader({ filename: 'a.md' }), makeHeader({ filename: 'b.md' })];
    const expanded = expandRelatedMemories(selected, all, new Set());

    expect(expanded.length).toBe(0);
  });

  it('不扩展已展示过的文件', () => {
    const selected = [makeHeader({ filename: 'a.md', relatedTo: ['b.md'] })];
    const bHeader = makeHeader({ filename: 'b.md' });
    const all = [makeHeader({ filename: 'a.md' }), bHeader];
    const expanded = expandRelatedMemories(selected, all, new Set([bHeader.filePath]));

    expect(expanded.length).toBe(0);
  });

  it('maxExpand 限制扩展数量', () => {
    const selected = [makeHeader({ filename: 'a.md', relatedTo: ['b.md', 'c.md', 'd.md', 'e.md'] })];
    const all = [
      makeHeader({ filename: 'a.md' }),
      makeHeader({ filename: 'b.md' }),
      makeHeader({ filename: 'c.md' }),
      makeHeader({ filename: 'd.md' }),
      makeHeader({ filename: 'e.md' }),
    ];
    const expanded = expandRelatedMemories(selected, all, new Set(), 2);

    expect(expanded.length).toBe(2);
  });

  it('显式关联优先于隐式关联', () => {
    const selected = [makeHeader({
      filename: 'a.md',
      relatedTo: ['explicit.md'],
      tags: ['lang:ts'],
    })];
    const all = [
      makeHeader({ filename: 'a.md', tags: ['lang:ts'] }),
      makeHeader({ filename: 'explicit.md', tags: [] }),
      makeHeader({ filename: 'implicit.md', tags: ['lang:ts'] }), // Jaccard = 1.0
    ];
    const expanded = expandRelatedMemories(selected, all, new Set(), 1);

    expect(expanded.length).toBe(1);
    expect(expanded[0].filename).toBe('explicit.md'); // 显式 score=1.0 优先
  });
});

// ─── 边界情况 ───

describe('recallRelevantMemories — 边界情况', () => {
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

    const chatCall = (mockLLM.chat as any).mock.calls[0];
    const userMessage = chatCall[0].find((m: UnifiedMessage) => m.role === 'user');
    expect(userMessage.content).not.toContain('MEMORY.md');
  });

  it('返回结果包含耗时信息', async () => {
    const result = await recallRelevantMemories('查询', tempDir, null);
    expect(typeof result.duration).toBe('number');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('返回结果包含 usedLLM 标记', async () => {
    const result = await recallRelevantMemories('查询', tempDir, null);
    expect(result.usedLLM).toBe(false);
  });
});

// ─── 集成测试 ───

describe('否定查询集成', () => {
  it('关键词回退路径 — 否定展开帮助命中同领域记忆', async () => {
    const content = `---
name: testing_preference
description: 用户偏好 Vitest 做测试
type: feedback
tags: tool:vitest, testing
---

用户明确表示偏好使用 Vitest 而非 Jest 做单元测试。`;
    await fs.writeFile(path.join(tempDir, 'feedback_testing.md'), content, 'utf-8');

    const result = await recallRelevantMemories('不要用 Jest', tempDir, null);

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.memories[0].filename).toBe('feedback_testing.md');
  });
});

describe('时间范围集成', () => {
  it('关键词回退路径 — 时间范围内的记忆排序更高', async () => {
    const oldContent = `---
name: old_preference
description: 用户的编程偏好
type: user
createdAt: 2026-01-01T00:00:00.000Z
---

用户偏好 Python`;
    await fs.writeFile(path.join(tempDir, 'old_pref.md'), oldContent, 'utf-8');

    const newContent = `---
name: new_preference
description: 用户的编程偏好
type: user
---

用户偏好 TypeScript`;
    await fs.writeFile(path.join(tempDir, 'new_pref.md'), newContent, 'utf-8');

    const result = await recallRelevantMemories('最近的编程偏好', tempDir, null);

    expect(result.memories.length).toBe(2);
    expect(result.memories[0].filename).toBe('new_pref.md');
  });
});
