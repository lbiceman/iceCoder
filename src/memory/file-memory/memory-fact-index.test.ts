/**
 * memory-fact-index 全覆盖单元测试。
 *
 * 覆盖范围：
 * - FactIndex.buildIndex: fact 提取、frontmatter 跳过、Markdown 格式清理、
 *   短行过滤、超长行分割、MAX_FACTS_PER_FILE 限制、元数据继承、
 *   fullContents 优先级、contentPreview 回退、空内容
 * - FactIndex.rankFacts: 英文匹配、中文 bigram 匹配、混合语言、
 *   空查询回退、无匹配返回空、maxResults 限制、分数排序
 * - FactIndex.getTopFactsForFile: 有查询精排、无查询返回前 N、
 *   文件不在缓存、空 facts
 * - 缓存: mtime 命中、mtime 失效、clearCache、getCacheStats
 * - 全局单例: getFactIndex、resetFactIndex
 * - 多文件: 跨文件构建、跨文件精排
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FactIndex, getFactIndex, resetFactIndex } from './memory-fact-index.js';
import type { MemoryHeader } from './types.js';

// ─── 测试工具 ───

function makeHeader(overrides: Partial<MemoryHeader> = {}): MemoryHeader {
  return {
    filename: 'test.md',
    filePath: '/mem/test.md',
    mtimeMs: Date.now(),
    description: 'test memory',
    type: 'user',
    confidence: 0.8,
    recallCount: 0,
    lastRecalledMs: 0,
    createdMs: Date.now(),
    tags: [],
    source: 'llm_extract',
    contentPreview: '',
    ...overrides,
  };
}

let index: FactIndex;

beforeEach(() => {
  resetFactIndex();
  index = new FactIndex();
});


// ═══════════════════════════════════════════════
// buildIndex — fact 提取
// ═══════════════════════════════════════════════

describe('buildIndex — 基本提取', () => {
  it('从 contentPreview 提取多行 facts', () => {
    const mem = makeHeader({
      contentPreview: '用户偏好 TypeScript 语言\n用户使用 React 框架开发\n用户习惯用 Vitest 做测试',
    });
    const facts = index.buildIndex([mem]);
    expect(facts.length).toBe(3);
    expect(facts[0].factText).toBe('用户偏好 TypeScript 语言');
    expect(facts[1].factText).toBe('用户使用 React 框架开发');
    expect(facts[2].factText).toBe('用户习惯用 Vitest 做测试');
  });

  it('从 fullContents 提取 facts（跳过 frontmatter）', () => {
    const mem = makeHeader({ filePath: '/mem/a.md', contentPreview: '' });
    const full = new Map<string, string>();
    full.set('/mem/a.md', `---
name: test
description: test desc
type: user
---

用户是前端开发者角色
偏好 React 和 TypeScript
在创业公司工作多年`);
    const facts = index.buildIndex([mem], full);
    expect(facts.length).toBe(3);
    expect(facts[0].factText).toBe('用户是前端开发者角色');
  });

  it('fullContents 优先于 contentPreview', () => {
    const mem = makeHeader({
      filePath: '/mem/b.md',
      contentPreview: 'preview content here',
    });
    const full = new Map<string, string>();
    full.set('/mem/b.md', '来自完整文件的内容信息');
    const facts = index.buildIndex([mem], full);
    expect(facts.length).toBe(1);
    expect(facts[0].factText).toBe('来自完整文件的内容信息');
  });
});

describe('buildIndex — Markdown 格式清理', () => {
  it('去除标题标记 (#)', () => {
    const mem = makeHeader({ contentPreview: '## 用户角色和职责信息' });
    const facts = index.buildIndex([mem]);
    expect(facts[0].factText).toBe('用户角色和职责信息');
  });

  it('去除无序列表标记 (- * +)', () => {
    const mem = makeHeader({ contentPreview: '- 前端开发者的偏好\n* 后端开发者的偏好\n+ 全栈开发者偏好' });
    const facts = index.buildIndex([mem]);
    expect(facts.map(f => f.factText)).toEqual([
      '前端开发者的偏好',
      '后端开发者的偏好',
      '全栈开发者偏好',
    ]);
  });

  it('去除引用标记 (>)', () => {
    const mem = makeHeader({ contentPreview: '> 偏好 React 框架开发' });
    const facts = index.buildIndex([mem]);
    expect(facts[0].factText).toBe('偏好 React 框架开发');
  });

  it('去除有序列表标记 (1.)', () => {
    const mem = makeHeader({ contentPreview: '1. 使用 TypeScript 语言\n2. 偏好函数式编程风格' });
    const facts = index.buildIndex([mem]);
    expect(facts.map(f => f.factText)).toEqual([
      '使用 TypeScript 语言',
      '偏好函数式编程风格',
    ]);
  });

  it('跳过时间戳行和分隔线', () => {
    const full = new Map<string, string>();
    full.set('/mem/c.md', `---
name: test
type: user
---

用户偏好 TypeScript 语言

---
*Extracted: 2026-04-29T08:00:00Z*
*Updated: 2026-04-29T09:00:00Z*
*保存时间: 2026-04-29*`);
    const mem = makeHeader({ filePath: '/mem/c.md', contentPreview: '' });
    const facts = index.buildIndex([mem], full);
    expect(facts.length).toBe(1);
    expect(facts[0].factText).toBe('用户偏好 TypeScript 语言');
  });
});

describe('buildIndex — 过滤和分割', () => {
  it('过滤短于 MIN_FACT_LENGTH(6) 的行', () => {
    const mem = makeHeader({
      contentPreview: '好的\nok\n用户偏好 TypeScript 语言\nyes\n项目使用 React 框架',
    });
    const facts = index.buildIndex([mem]);
    expect(facts.length).toBe(2);
    expect(facts[0].factText).toContain('TypeScript');
    expect(facts[1].factText).toContain('React');
  });

  it('超长行（>200 字符）按句号分割', () => {
    const longLine = 'A'.repeat(100) + '。' + 'B'.repeat(100) + '。' + 'C'.repeat(50);
    const full = new Map<string, string>();
    full.set('/mem/long.md', longLine);
    const mem = makeHeader({ filePath: '/mem/long.md', contentPreview: '' });
    const facts = index.buildIndex([mem], full);
    expect(facts.length).toBeGreaterThan(1);
  });

  it('分割后仍然过滤短片段', () => {
    // 句号分割后 "好。" 只有 2 字符，应被过滤
    const longLine = 'A'.repeat(150) + '。好。' + 'B'.repeat(50) + '这是一段有意义的内容。';
    const mem = makeHeader({ contentPreview: longLine });
    const facts = index.buildIndex([mem]);
    for (const f of facts) {
      expect(f.factText.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('每个文件最多 MAX_FACTS_PER_FILE(20) 条', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `这是第 ${String(i + 1).padStart(2, '0')} 条事实信息内容`).join('\n');
    const mem = makeHeader({ contentPreview: lines });
    const facts = index.buildIndex([mem]);
    expect(facts.length).toBe(20);
  });

  it('空内容返回空 facts', () => {
    const mem = makeHeader({ contentPreview: '' });
    expect(index.buildIndex([mem])).toEqual([]);
  });

  it('只有空行和格式标记的内容返回空', () => {
    const mem = makeHeader({ contentPreview: '\n\n---\n\n' });
    expect(index.buildIndex([mem])).toEqual([]);
  });
});

describe('buildIndex — 元数据继承', () => {
  it('facts 继承源文件的所有元数据', () => {
    const mem = makeHeader({
      filename: 'user_role.md',
      filePath: '/mem/user_role.md',
      type: 'feedback',
      confidence: 0.95,
      tags: ['role:frontend', 'lang:typescript'],
      createdMs: 1700000000000,
      mtimeMs: 1700100000000,
      contentPreview: '用户是高级前端工程师',
    });
    const facts = index.buildIndex([mem]);
    expect(facts.length).toBe(1);
    const f = facts[0];
    expect(f.sourceFile).toBe('user_role.md');
    expect(f.sourceFilePath).toBe('/mem/user_role.md');
    expect(f.type).toBe('feedback');
    expect(f.confidence).toBe(0.95);
    expect(f.tags).toEqual(['role:frontend', 'lang:typescript']);
    expect(f.createdMs).toBe(1700000000000);
    expect(f.mtimeMs).toBe(1700100000000);
  });

  it('type 为 undefined 时正确继承', () => {
    const mem = makeHeader({ type: undefined, contentPreview: '某条没有类型的记忆内容' });
    const facts = index.buildIndex([mem]);
    expect(facts[0].type).toBeUndefined();
  });
});


// ═══════════════════════════════════════════════
// 缓存
// ═══════════════════════════════════════════════

describe('缓存机制', () => {
  it('相同 filePath + mtimeMs 命中缓存', () => {
    const mem = makeHeader({ mtimeMs: 1000000, contentPreview: '用户偏好 TypeScript 语言' });
    const facts1 = index.buildIndex([mem]);
    const facts2 = index.buildIndex([mem]);
    expect(facts1).toEqual(facts2);
    expect(index.getCacheStats().fileCount).toBe(1);
  });

  it('mtimeMs 变化时缓存失效并重新提取', () => {
    const mem1 = makeHeader({ mtimeMs: 1000000, contentPreview: '这是旧的事实内容信息' });
    index.buildIndex([mem1]);
    const mem2 = makeHeader({ mtimeMs: 2000000, contentPreview: '这是新的事实内容信息' });
    const facts = index.buildIndex([mem2]);
    expect(facts[0].factText).toBe('这是新的事实内容信息');
  });

  it('不同 filePath 独立缓存', () => {
    const memA = makeHeader({ filePath: '/mem/a.md', mtimeMs: 1000, contentPreview: '事实 A 的内容信息' });
    const memB = makeHeader({ filePath: '/mem/b.md', mtimeMs: 1000, contentPreview: '事实 B 的内容信息' });
    index.buildIndex([memA]);
    index.buildIndex([memB]);
    expect(index.getCacheStats().fileCount).toBe(2);
    expect(index.getCacheStats().totalFacts).toBe(2);
  });

  it('clearCache 清除所有缓存', () => {
    index.buildIndex([makeHeader({ contentPreview: '用户偏好 TypeScript 语言' })]);
    expect(index.getCacheStats().fileCount).toBe(1);
    index.clearCache();
    expect(index.getCacheStats()).toEqual({ fileCount: 0, totalFacts: 0 });
  });

  it('getCacheStats 返回正确的统计', () => {
    const mems = [
      makeHeader({ filePath: '/a.md', contentPreview: '事实一的内容\n事实二的内容' }),
      makeHeader({ filePath: '/b.md', contentPreview: '事实三的内容' }),
    ];
    index.buildIndex(mems);
    const stats = index.getCacheStats();
    expect(stats.fileCount).toBe(2);
    expect(stats.totalFacts).toBe(3);
  });
});

// ═══════════════════════════════════════════════
// rankFacts — 关键词精排
// ═══════════════════════════════════════════════

describe('rankFacts', () => {
  it('英文关键词匹配并排序', () => {
    const facts = index.buildIndex([makeHeader({
      contentPreview: 'User prefers TypeScript language\nProject uses Python scripting\nDatabase is PostgreSQL system',
    })]);
    const ranked = index.rankFacts('TypeScript', facts, 3);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].factText).toContain('TypeScript');
  });

  it('中文 bigram 关键词匹配', () => {
    const facts = index.buildIndex([makeHeader({
      contentPreview: '用户偏好函数式编程风格\n项目截止日期是下周五\n数据库查询需要优化处理',
    })]);
    const ranked = index.rankFacts('数据库优化', facts, 5);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].factText).toContain('数据库');
  });

  it('混合中英文匹配', () => {
    const facts = index.buildIndex([makeHeader({
      contentPreview: '用户偏好 TypeScript 语言\n项目使用 Python 脚本\n部署使用 Docker 容器',
    })]);
    const ranked = index.rankFacts('TypeScript 语言', facts, 5);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].factText).toContain('TypeScript');
  });

  it('空查询返回前 N 条（不过滤）', () => {
    const facts = index.buildIndex([makeHeader({
      contentPreview: '用户偏好 TypeScript 语言\n项目使用 React 框架\n数据库选择 PostgreSQL',
    })]);
    const ranked = index.rankFacts('', facts, 2);
    expect(ranked.length).toBe(2);
  });

  it('无匹配时返回空数组', () => {
    const facts = index.buildIndex([makeHeader({ contentPreview: '用户偏好 React 框架开发' })]);
    const ranked = index.rankFacts('xyzzy_no_match_at_all', facts, 5);
    expect(ranked).toEqual([]);
  });

  it('限制 maxResults', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `TypeScript 相关事实内容 ${i}`).join('\n');
    const facts = index.buildIndex([makeHeader({ contentPreview: lines })]);
    const ranked = index.rankFacts('TypeScript', facts, 3);
    expect(ranked.length).toBeLessThanOrEqual(3);
  });

  it('按相关性分数降序排列', () => {
    const facts = index.buildIndex([makeHeader({
      contentPreview: 'TypeScript is great for development\nPython is also good for scripting\nTypeScript and React work well together',
    })]);
    const ranked = index.rankFacts('TypeScript React', facts, 5);
    // "TypeScript and React" 应该排在 "TypeScript is great" 前面（匹配更多词）
    if (ranked.length >= 2) {
      expect(ranked[0].factText).toContain('React');
    }
  });

  it('空 facts 列表返回空', () => {
    expect(index.rankFacts('query', [], 5)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════
// getTopFactsForFile
// ═══════════════════════════════════════════════

describe('getTopFactsForFile', () => {
  it('有查询时返回精排后的 top facts', () => {
    const mem = makeHeader({
      filePath: '/mem/user.md',
      contentPreview: '偏好 TypeScript 语言开发\n使用 React 框架构建\n习惯 Vitest 做测试',
    });
    index.buildIndex([mem]);
    const topFacts = index.getTopFactsForFile('/mem/user.md', 'TypeScript', 2);
    expect(topFacts.length).toBeLessThanOrEqual(2);
    expect(topFacts[0]).toContain('TypeScript');
  });

  it('无查询时返回前 N 条（原始顺序）', () => {
    const mem = makeHeader({
      filePath: '/mem/test.md',
      contentPreview: '用户偏好 TypeScript 语言\n项目使用 React 框架\n数据库选择 PostgreSQL\n部署使用 Docker 容器\n测试框架是 Vitest',
    });
    index.buildIndex([mem]);
    const topFacts = index.getTopFactsForFile('/mem/test.md', '', 3);
    expect(topFacts.length).toBe(3);
    expect(topFacts[0]).toBe('用户偏好 TypeScript 语言');
  });

  it('文件不在缓存中返回空数组', () => {
    expect(index.getTopFactsForFile('/nonexistent.md', 'query', 3)).toEqual([]);
  });

  it('文件有缓存但 facts 为空时返回空数组', () => {
    const mem = makeHeader({ filePath: '/mem/empty.md', contentPreview: '' });
    index.buildIndex([mem]); // 空内容，facts 为空
    expect(index.getTopFactsForFile('/mem/empty.md', 'query', 3)).toEqual([]);
  });

  it('返回值是 string[] 不是 FactEntry[]', () => {
    const mem = makeHeader({ filePath: '/mem/x.md', contentPreview: '用户偏好 TypeScript 语言' });
    index.buildIndex([mem]);
    const result = index.getTopFactsForFile('/mem/x.md', '', 1);
    expect(typeof result[0]).toBe('string');
  });
});

// ═══════════════════════════════════════════════
// 全局单例
// ═══════════════════════════════════════════════

describe('全局单例', () => {
  it('getFactIndex 返回同一个实例', () => {
    const a = getFactIndex();
    const b = getFactIndex();
    expect(a).toBe(b);
  });

  it('resetFactIndex 后返回新实例', () => {
    const a = getFactIndex();
    resetFactIndex();
    const b = getFactIndex();
    expect(a).not.toBe(b);
  });

  it('resetFactIndex 清除旧实例的缓存', () => {
    const inst = getFactIndex();
    inst.buildIndex([makeHeader({ contentPreview: '用户偏好 TypeScript 语言' })]);
    expect(inst.getCacheStats().fileCount).toBe(1);
    resetFactIndex();
    const newInst = getFactIndex();
    expect(newInst.getCacheStats().fileCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// 多文件场景
// ═══════════════════════════════════════════════

describe('多文件场景', () => {
  it('跨文件构建索引', () => {
    const mems = [
      makeHeader({ filename: 'a.md', filePath: '/mem/a.md', contentPreview: '用户偏好 TypeScript 语言' }),
      makeHeader({ filename: 'b.md', filePath: '/mem/b.md', contentPreview: '项目截止日期是 2026-05-15' }),
    ];
    const facts = index.buildIndex(mems);
    expect(facts.length).toBe(2);
    expect(facts[0].sourceFile).toBe('a.md');
    expect(facts[1].sourceFile).toBe('b.md');
  });

  it('精排时跨文件排序', () => {
    const mems = [
      makeHeader({ filename: 'a.md', filePath: '/mem/a.md', contentPreview: '项目使用 Python 和 Django 框架' }),
      makeHeader({ filename: 'b.md', filePath: '/mem/b.md', contentPreview: '用户偏好 TypeScript 和 React 开发' }),
    ];
    const facts = index.buildIndex(mems);
    const ranked = index.rankFacts('TypeScript React', facts, 5);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].sourceFile).toBe('b.md');
  });

  it('部分文件命中缓存，部分重新提取', () => {
    const memA = makeHeader({ filePath: '/mem/a.md', mtimeMs: 1000, contentPreview: '事实 A 的内容信息' });
    index.buildIndex([memA]); // 缓存 A

    const memB = makeHeader({ filePath: '/mem/b.md', mtimeMs: 2000, contentPreview: '事实 B 的内容信息' });
    const facts = index.buildIndex([memA, memB]); // A 命中缓存，B 新建
    expect(facts.length).toBe(2);
    expect(index.getCacheStats().fileCount).toBe(2);
  });
});
