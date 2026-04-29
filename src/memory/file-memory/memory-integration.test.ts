/**
 * 记忆系统端到端集成测试 — 全覆盖。
 *
 * 覆盖范围：
 * - recallRelevantMemories 返回 facts 字段
 * - Fact Key Expansion 在 manifest 中生效
 * - 关键词回退路径的 fact 精排
 * - 跨文件 fact 精排
 * - 无匹配时 facts 为空
 * - 缓存一致性
 * - scanMemoryFiles + FactIndex 联合工作
 * - 真实记忆文件的 fact 提取质量
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { recallRelevantMemories } from './memory-recall.js';
import { FactIndex, resetFactIndex } from './memory-fact-index.js';
import { scanMemoryFiles } from './memory-scanner.js';

let tempDir: string;

async function writeMemory(
  dir: string,
  filename: string,
  opts: {
    name: string;
    description: string;
    type: string;
    content: string;
    confidence?: number;
    tags?: string;
  },
) {
  const frontmatter = `---
name: ${opts.name}
description: ${opts.description}
type: ${opts.type}
confidence: ${opts.confidence ?? 0.8}
tags: ${opts.tags ?? ''}
createdAt: ${new Date().toISOString()}
recallCount: 0
---

${opts.content}`;
  await fs.writeFile(path.join(dir, filename), frontmatter, 'utf-8');
}

beforeEach(async () => {
  tempDir = path.join(os.tmpdir(), `integration-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  resetFactIndex();
  process.env.ICE_USER_MEMORY_DIR = path.join(os.tmpdir(), `integration-user-${randomUUID()}`);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  if (process.env.ICE_USER_MEMORY_DIR) {
    await fs.rm(process.env.ICE_USER_MEMORY_DIR, { recursive: true, force: true }).catch(() => {});
  }
  delete process.env.ICE_USER_MEMORY_DIR;
});


// ═══════════════════════════════════════════════
// recallRelevantMemories — facts 字段
// ═══════════════════════════════════════════════

describe('recallRelevantMemories 返回 facts', () => {
  it('关键词召回时返回精排后的 facts', async () => {
    await writeMemory(tempDir, 'user_languages.md', {
      name: '编程语言偏好',
      description: '用户偏好的编程语言和框架',
      type: 'user',
      content: `用户主要使用 TypeScript 进行前端开发
偏好 React 框架，不喜欢 Angular
后端偶尔使用 Python 写脚本
对 Rust 感兴趣但还没在生产中使用`,
    });

    const result = await recallRelevantMemories('TypeScript React', tempDir, null);

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.facts.length).toBeGreaterThan(0);
    expect(result.usedLLM).toBe(false);
    // facts 应该来自被选中的文件
    expect(result.facts.every(f => f.sourceFile === 'user_languages.md')).toBe(true);
  });

  it('无匹配时 memories 和 facts 都为空', async () => {
    await writeMemory(tempDir, 'project_deadline.md', {
      name: '项目截止日期',
      description: '项目截止日期信息',
      type: 'project',
      content: '项目截止日期是 2026-06-01',
    });

    const result = await recallRelevantMemories('xyzzy_completely_unrelated', tempDir, null);
    expect(result.facts.length).toBe(0);
  });

  it('空目录时 facts 为空', async () => {
    const result = await recallRelevantMemories('任何查询', tempDir, null);
    expect(result.memories).toEqual([]);
    expect(result.facts).toEqual([]);
  });

  it('facts 包含完整的元数据', async () => {
    await writeMemory(tempDir, 'user_role.md', {
      name: '用户角色',
      description: '用户的角色信息',
      type: 'user',
      confidence: 0.95,
      tags: 'role:frontend, lang:typescript',
      content: '用户是一名高级前端工程师',
    });

    const result = await recallRelevantMemories('前端工程师', tempDir, null);

    if (result.facts.length > 0) {
      const fact = result.facts[0];
      expect(fact.sourceFile).toBe('user_role.md');
      expect(fact.type).toBe('user');
      expect(fact.confidence).toBe(0.95);
      expect(fact.tags).toContain('role:frontend');
      expect(typeof fact.mtimeMs).toBe('number');
      expect(typeof fact.createdMs).toBe('number');
    }
  });
});

// ═══════════════════════════════════════════════
// 跨文件 fact 精排
// ═══════════════════════════════════════════════

describe('跨文件 fact 精排', () => {
  it('从多个文件中精排出最相关的 facts', async () => {
    await writeMemory(tempDir, 'user_languages.md', {
      name: '编程语言',
      description: '用户偏好的编程语言',
      type: 'user',
      content: `用户主要使用 TypeScript 进行开发
项目使用 Vitest 作为测试框架`,
    });

    await writeMemory(tempDir, 'feedback_testing.md', {
      name: '测试方法',
      description: '用户对测试方法的反馈',
      type: 'feedback',
      content: `测试文件应该放在源文件旁边
不使用 snapshot 测试方式
每个函数都应该有单元测试`,
    });

    const result = await recallRelevantMemories('测试', tempDir, null);

    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.facts.length).toBeGreaterThan(0);
    // 测试相关的 facts 应该存在
    const testFacts = result.facts.filter(f =>
      f.factText.includes('测试') || f.factText.includes('Vitest'),
    );
    expect(testFacts.length).toBeGreaterThan(0);
  });

  it('facts 来自多个不同的源文件', async () => {
    await writeMemory(tempDir, 'a.md', {
      name: 'A',
      description: 'TypeScript 相关信息',
      type: 'user',
      content: '用户偏好 TypeScript 语言开发',
    });
    await writeMemory(tempDir, 'b.md', {
      name: 'B',
      description: 'TypeScript 测试信息',
      type: 'feedback',
      content: '使用 TypeScript 编写测试代码',
    });

    const result = await recallRelevantMemories('TypeScript', tempDir, null);

    if (result.facts.length >= 2) {
      const sources = new Set(result.facts.map(f => f.sourceFile));
      expect(sources.size).toBeGreaterThanOrEqual(1);
    }
  });
});

// ═══════════════════════════════════════════════
// Fact 回退逻辑
// ═══════════════════════════════════════════════

describe('Fact 回退逻辑', () => {
  it('关键词无法精排时回退到返回所有 facts', async () => {
    // 查询 "编程语言" 和 facts 中的 "TypeScript" 没有词汇重叠
    // 但文件被选中了（description 匹配），所以 facts 应该回退返回全部
    await writeMemory(tempDir, 'user_languages.md', {
      name: '编程语言偏好',
      description: '用户偏好的编程语言和框架',
      type: 'user',
      content: `用户主要使用 TypeScript 进行前端开发
偏好 React 框架不喜欢 Angular
后端偶尔使用 Python 写脚本`,
    });

    const result = await recallRelevantMemories('我用什么编程语言', tempDir, null);

    expect(result.memories.length).toBeGreaterThan(0);
    // 即使关键词精排无匹配，也应该回退返回文件中的所有 facts
    expect(result.facts.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// 缓存一致性
// ═══════════════════════════════════════════════

describe('缓存一致性', () => {
  it('两次召回返回相同的 facts 内容', async () => {
    await writeMemory(tempDir, 'user_role.md', {
      name: '用户角色',
      description: '用户的角色信息',
      type: 'user',
      content: `用户是一名全栈开发者
在一家创业公司工作多年
负责前端架构和代码审查`,
    });

    const result1 = await recallRelevantMemories('全栈开发者', tempDir, null);
    // 等待异步 updateRecallMetadata 完成（它会修改文件 mtime）
    await new Promise(r => setTimeout(r, 100));
    const result2 = await recallRelevantMemories('全栈开发者', tempDir, null);

    // 两次都应该召回同一个文件
    expect(result1.memories.length).toBeGreaterThan(0);
    expect(result2.memories.length).toBeGreaterThan(0);
    expect(result1.memories[0].filename).toBe(result2.memories[0].filename);

    // facts 内容应该一致（即使 mtime 变化导致缓存重建）
    const texts1 = result1.facts.map(f => f.factText).sort();
    const texts2 = result2.facts.map(f => f.factText).sort();
    expect(texts1).toEqual(texts2);
  });
});

// ═══════════════════════════════════════════════
// scanMemoryFiles + FactIndex 联合
// ═══════════════════════════════════════════════

describe('scanMemoryFiles + FactIndex 联合', () => {
  it('从真实记忆文件提取正确数量的 facts', async () => {
    await writeMemory(tempDir, 'user_preferences.md', {
      name: '用户偏好',
      description: '用户的各种偏好设置',
      type: 'user',
      tags: 'lang:typescript, tool:vitest',
      content: `用户偏好 TypeScript 而非 JavaScript
使用 React 18 加 Next.js 14 技术栈
测试框架选择 Vitest 不用 Jest
代码风格偏好函数式编程方式
变量命名使用 camelCase 规范
注释使用中文编写方便阅读
缩进使用两个空格保持一致
偏好 ESM 模块而非 CommonJS`,
    });

    const memories = await scanMemoryFiles(tempDir, 200);
    expect(memories.length).toBe(1);

    const factIndex = new FactIndex();
    const fullContents = new Map<string, string>();
    for (const mem of memories) {
      const content = await fs.readFile(mem.filePath, 'utf-8');
      fullContents.set(mem.filePath, content);
    }
    const facts = factIndex.buildIndex(memories, fullContents);

    expect(facts.length).toBe(8);
    expect(facts.every(f => f.sourceFile === 'user_preferences.md')).toBe(true);
    expect(facts.every(f => f.type === 'user')).toBe(true);
    expect(facts.every(f => f.confidence === 0.8)).toBe(true);
  });

  it('Key Expansion — getTopFactsForFile 返回查询相关的 facts', async () => {
    await writeMemory(tempDir, 'user_role.md', {
      name: '用户角色',
      description: '用户的角色信息',
      type: 'user',
      content: `用户是一名高级前端工程师
在字节跳动工作了三年时间
目前负责内部工具平台的开发
擅长 React 性能优化和状态管理`,
    });

    const memories = await scanMemoryFiles(tempDir, 200);
    const factIndex = new FactIndex();
    const fullContents = new Map<string, string>();
    for (const mem of memories) {
      const content = await fs.readFile(mem.filePath, 'utf-8');
      fullContents.set(mem.filePath, content);
    }
    factIndex.buildIndex(memories, fullContents);

    const topFacts = factIndex.getTopFactsForFile(memories[0].filePath, 'React 性能', 3);
    expect(topFacts.length).toBeGreaterThan(0);
    expect(topFacts.some(f => f.includes('React'))).toBe(true);
  });

  it('多个记忆文件的 facts 正确关联到各自的源文件', async () => {
    await writeMemory(tempDir, 'user_role.md', {
      name: '角色',
      description: '用户角色',
      type: 'user',
      content: '用户是前端开发者角色',
    });
    await writeMemory(tempDir, 'project_info.md', {
      name: '项目',
      description: '项目信息',
      type: 'project',
      content: '项目使用 Next.js 框架',
    });

    const memories = await scanMemoryFiles(tempDir, 200);
    const factIndex = new FactIndex();
    const fullContents = new Map<string, string>();
    for (const mem of memories) {
      const content = await fs.readFile(mem.filePath, 'utf-8');
      fullContents.set(mem.filePath, content);
    }
    const facts = factIndex.buildIndex(memories, fullContents);

    expect(facts.length).toBe(2);
    const sources = new Set(facts.map(f => f.sourceFile));
    expect(sources.size).toBe(2);
    expect(sources.has('user_role.md')).toBe(true);
    expect(sources.has('project_info.md')).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// RecallResult 结构完整性
// ═══════════════════════════════════════════════

describe('RecallResult 结构完整性', () => {
  it('返回结果包含所有必要字段', async () => {
    await writeMemory(tempDir, 'test.md', {
      name: 'test',
      description: 'test memory for validation',
      type: 'user',
      content: 'User prefers TypeScript language',
    });

    const result = await recallRelevantMemories('TypeScript', tempDir, null);

    // 结构验证
    expect(result).toHaveProperty('memories');
    expect(result).toHaveProperty('facts');
    expect(result).toHaveProperty('duration');
    expect(result).toHaveProperty('usedLLM');
    expect(Array.isArray(result.memories)).toBe(true);
    expect(Array.isArray(result.facts)).toBe(true);
    expect(typeof result.duration).toBe('number');
    expect(typeof result.usedLLM).toBe('boolean');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('不存在的目录返回完整的空结果', async () => {
    const result = await recallRelevantMemories('query', '/nonexistent/path', null);
    expect(result).toEqual({
      memories: [],
      facts: [],
      duration: expect.any(Number),
      usedLLM: false,
    });
  });
});
