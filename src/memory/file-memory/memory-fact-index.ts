/**
 * Fact 级记忆索引。
 *
 * 从 .md 记忆文件中提取独立事实（fact），构建内存索引，
 * 用于召回时的精确匹配和 Key Expansion。
 *
 * 设计原则：
 * - 不改变 .md 文件存储格式（派生数据，随时可重建）
 * - 纯规则提取，零 LLM 成本
 * - 内存缓存 + mtime 失效（和 MultiLevelMemoryLoader 对齐）
 * - 每条 fact 关联回源文件，保持溯源能力
 *
 * 基于 LongMemEval（ICLR 2025）的实验结论：
 * - Fact 粒度的 Key Expansion 提升 Recall@k 9.4%
 * - Fact 粒度在多会话推理（Multi-Session Reasoning）上显著优于文件粒度
 */

import type { MemoryHeader, FileMemoryType } from './types.js';

/**
 * 单条事实。
 */
export interface FactEntry {
  /** 事实文本（一句话） */
  factText: string;
  /** 来源文件名（相对路径） */
  sourceFile: string;
  /** 来源文件绝对路径 */
  sourceFilePath: string;
  /** 记忆类型（继承源文件） */
  type: FileMemoryType | undefined;
  /** 置信度（继承源文件） */
  confidence: number;
  /** 语义标签（继承源文件） */
  tags: string[];
  /** 创建时间（毫秒时间戳，继承源文件） */
  createdMs: number;
  /** 文件修改时间（毫秒时间戳，用于新鲜度） */
  mtimeMs: number;
}

/**
 * 缓存条目：一个文件对应的 facts + 缓存时的 mtime。
 */
interface CacheEntry {
  facts: FactEntry[];
  mtimeMs: number;
}

/** 最小 fact 长度（过短的行没有信息量） */
const MIN_FACT_LENGTH = 6;
/** 最大 fact 长度（超长行按标点分割） */
const MAX_FACT_LENGTH = 200;
/** 每个文件最多提取的 fact 数量 */
const MAX_FACTS_PER_FILE = 20;

/**
 * Fact 索引构建器。
 *
 * 内存缓存，按文件 mtime 失效。
 * 不持久化到磁盘——fact index 是派生数据，随时可从 .md 文件重建。
 */
export class FactIndex {
  private cache = new Map<string, CacheEntry>();

  /**
   * 从记忆头信息列表构建 fact 索引。
   *
   * 优先读取完整文件内容（精确的行分割），
   * 回退到 contentPreview（空格分隔，按句号分割）。
   *
   * @param memories - scanMemoryFiles 返回的记忆头信息
   * @param fullContents - 可选的完整文件内容 map（filePath → content）
   * @returns 所有 facts 的扁平列表
   */
  buildIndex(
    memories: MemoryHeader[],
    fullContents?: Map<string, string>,
  ): FactEntry[] {
    const allFacts: FactEntry[] = [];

    for (const mem of memories) {
      // 检查缓存
      const cached = this.cache.get(mem.filePath);
      if (cached && cached.mtimeMs === mem.mtimeMs) {
        allFacts.push(...cached.facts);
        continue;
      }

      // 优先使用 fullContents，其次 contentPreview
      const text = fullContents?.get(mem.filePath) ?? mem.contentPreview ?? '';
      const hasFullContent = fullContents?.has(mem.filePath) ?? false;
      const body = hasFullContent ? extractBody(text) : text;
      const rawFacts = splitIntoFacts(body);
      const facts: FactEntry[] = rawFacts.slice(0, MAX_FACTS_PER_FILE).map(factText => ({
        factText,
        sourceFile: mem.filename,
        sourceFilePath: mem.filePath,
        type: mem.type,
        confidence: mem.confidence,
        tags: mem.tags,
        createdMs: mem.createdMs,
        mtimeMs: mem.mtimeMs,
      }));

      // 更新缓存
      this.cache.set(mem.filePath, { facts, mtimeMs: mem.mtimeMs });
      allFacts.push(...facts);
    }

    return allFacts;
  }

  /**
   * 对 facts 做关键词精排。
   *
   * 使用和 memory-recall.ts 相同的 tokenize + 重叠度算法，
   * 对 fact 文本做关键词匹配，返回按相关性排序的 top-N facts。
   */
  rankFacts(
    query: string,
    facts: FactEntry[],
    maxResults: number = 15,
  ): FactEntry[] {
    const queryTokens = tokenize(query);
    // 空查询时直接返回前 N 条（不做排序）
    if (queryTokens.size === 0) return facts.slice(0, maxResults);

    const scored = facts.map(fact => {
      const factTokens = tokenize(fact.factText);
      let hits = 0;
      for (const token of queryTokens) {
        if (factTokens.has(token)) hits++;
      }
      const score = queryTokens.size > 0 ? hits / queryTokens.size : 0;
      return { fact, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.fact);
  }

  /**
   * 获取指定文件的 top-N facts（用于 manifest Key Expansion）。
   */
  getTopFactsForFile(
    filePath: string,
    query: string,
    maxFacts: number = 3,
  ): string[] {
    const cached = this.cache.get(filePath);
    if (!cached || cached.facts.length === 0) return [];

    if (!query) {
      return cached.facts.slice(0, maxFacts).map(f => f.factText);
    }

    const ranked = this.rankFacts(query, cached.facts, maxFacts);
    return ranked.map(f => f.factText);
  }

  /**
   * 清除缓存。
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计。
   */
  getCacheStats(): { fileCount: number; totalFacts: number } {
    let totalFacts = 0;
    for (const entry of this.cache.values()) {
      totalFacts += entry.facts.length;
    }
    return { fileCount: this.cache.size, totalFacts };
  }
}

// ─── 内部工具函数 ───

/**
 * 从 Markdown 内容中提取正文（跳过 frontmatter）。
 */
function extractBody(content: string): string {
  const lines = content.split('\n');
  let bodyStart = 0;

  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
    }
  }

  return lines.slice(bodyStart)
    .map(l => l.trim())
    .filter(l =>
      l.length > 0 &&
      l !== '---' &&
      !l.startsWith('*Extracted:') &&
      !l.startsWith('*Updated:') &&
      !l.startsWith('*保存时间:'),
    )
    .join('\n');
}

/**
 * 将正文分割为独立事实。
 *
 * 策略：
 * 1. 按换行符分割
 * 2. 去除 Markdown 格式标记（#、-、*、>）
 * 3. 过滤过短的行（< MIN_FACT_LENGTH）
 * 4. 超长行按中英文句号/分号分割
 */
function splitIntoFacts(body: string): string[] {
  const facts: string[] = [];
  const lines = body.split('\n');

  for (const rawLine of lines) {
    // 去除 Markdown 格式标记
    let line = rawLine
      .replace(/^#{1,6}\s+/, '')   // 标题
      .replace(/^\s*[-*+]\s+/, '') // 列表项
      .replace(/^\s*>\s+/, '')     // 引用
      .replace(/^\s*\d+\.\s+/, '') // 有序列表
      .trim();

    if (line.length < MIN_FACT_LENGTH) continue;

    if (line.length <= MAX_FACT_LENGTH) {
      facts.push(line);
    } else {
      // 超长行按句号/分号分割
      const segments = line.split(/(?<=[。；;.!！?？])\s*/);
      for (const seg of segments) {
        const trimmed = seg.trim();
        if (trimmed.length >= MIN_FACT_LENGTH) {
          facts.push(trimmed.length > MAX_FACT_LENGTH
            ? trimmed.substring(0, MAX_FACT_LENGTH) + '...'
            : trimmed);
        }
      }
    }
  }

  return facts;
}

/**
 * 混合语言分词器（和 memory-recall.ts 中的实现一致）。
 *
 * 英文/数字：按空格+标点分词，过滤 ≤1 字符的词。
 * 中文：bigram 滑动窗口。
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();

  // 英文/数字词
  const englishWords = lower.split(/[^a-z0-9]+/).filter(w => w.length > 1);
  for (const w of englishWords) {
    tokens.add(w);
  }

  // 中文 bigram
  const cjkSegments = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g);
  if (cjkSegments) {
    for (const seg of cjkSegments) {
      if (seg.length === 1) {
        tokens.add(seg);
      }
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.add(seg.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

// ─── 全局单例 ───

let globalFactIndex: FactIndex | null = null;

/**
 * 获取全局 FactIndex 实例。
 */
export function getFactIndex(): FactIndex {
  if (!globalFactIndex) {
    globalFactIndex = new FactIndex();
  }
  return globalFactIndex;
}

/**
 * 重置全局 FactIndex（用于测试）。
 */
export function resetFactIndex(): void {
  globalFactIndex = null;
}
