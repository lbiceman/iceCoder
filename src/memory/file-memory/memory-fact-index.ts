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
import { tokenize, extractEntities } from './memory-tokenizer.js';
import { extractBodyFromMarkdown } from './memory-parser.js';
import { promises as fs } from 'node:fs';
import {
  MIN_FACT_LENGTH,
  MAX_FACTS_PER_FILE,
  LONG_LINE_SENTENCE_SPLIT_AT,
} from './memory-config.js';

/** Fact 最大长度 */
const MAX_FACT_LENGTH = 300;
/** Fact 排序默认返回数 */
const FACT_RANK_DEFAULT_MAX = 15;
/** 每个文件默认展示 Fact 数 */
const FACTS_PER_FILE_DEFAULT = 3;
/** Fact 实体匹配加分 */
const FACT_ENTITY_MATCH_BONUS = 0.3;

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

/**
 * 文件内容缓存条目（mtime 失效）。
 */
interface ContentCacheEntry {
  content: string;
  mtimeMs: number;
}


/**
 * Fact 索引构建器。
 *
 * 内存缓存，按文件 mtime 失效。
 * 不持久化到磁盘——fact index 是派生数据，随时可从 .md 文件重建。
 */
export class FactIndex {
  private cache = new Map<string, CacheEntry>();
  /** 文件内容缓存（避免重复 readFile） */
  private contentCache = new Map<string, ContentCacheEntry>();

  /**
   * 从记忆头信息列表构建 fact 索引。
   *
   * 自动从磁盘读取文件内容（mtime 失效时重新读取），
   * 如果外部已提供 fullContents 则优先使用（零 I/O）。
   * 回退到 contentPreview（无需额外 I/O）。
   *
   * @param memories - scanMemoryFiles 返回的记忆头信息
   * @param fullContents - 可选的完整文件内容 map（filePath → content）
   * @returns 所有 facts 的扁平列表
   */
  async buildIndex(
    memories: MemoryHeader[],
    fullContents?: Map<string, string>,
  ): Promise<FactEntry[]> {
    const allFacts: FactEntry[] = [];

    // 批量读取需要从磁盘加载的文件内容（并发）
    const toRead: MemoryHeader[] = [];
    for (const mem of memories) {
      // 检查 fact 缓存（mtime 未变则跳过）
      const cached = this.cache.get(mem.filePath);
      if (cached && cached.mtimeMs === mem.mtimeMs) {
        allFacts.push(...cached.facts);
        continue;
      }
      // 如果外部未提供 fullContents，且内容缓存未命中，则需要从磁盘读取
      if (!fullContents?.has(mem.filePath)) {
        const contentCached = this.contentCache.get(mem.filePath);
        if (!contentCached || contentCached.mtimeMs !== mem.mtimeMs) {
          toRead.push(mem);
        }
      }
    }

    // 并发读取需要从磁盘加载的文件
    if (toRead.length > 0) {
      const readResults = await Promise.allSettled(
        toRead.map(async (mem) => {
          const content = await fs.readFile(mem.filePath, 'utf-8');
          return { filePath: mem.filePath, content, mtimeMs: mem.mtimeMs };
        }),
      );
      for (const result of readResults) {
        if (result.status === 'fulfilled') {
          this.contentCache.set(result.value.filePath, {
            content: result.value.content,
            mtimeMs: result.value.mtimeMs,
          });
        }
      }
    }

    // 构建未缓存文件的 facts
    for (const mem of memories) {
      const cached = this.cache.get(mem.filePath);
      if (cached && cached.mtimeMs === mem.mtimeMs) {
        continue; // 已在上面处理
      }

      // 获取文件内容：外部传入 > 内容缓存 > contentPreview
      let text: string;
      let hasFullContent: boolean;

      if (fullContents?.has(mem.filePath)) {
        text = fullContents.get(mem.filePath)!;
        hasFullContent = true;
      } else {
        const contentCached = this.contentCache.get(mem.filePath);
        if (contentCached && contentCached.mtimeMs === mem.mtimeMs) {
          text = contentCached.content;
          hasFullContent = true;
        } else {
          text = mem.contentPreview ?? '';
          hasFullContent = false;
        }
      }

      const body = hasFullContent ? extractBodyFromMarkdown(text) : text;
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
   * 获取指定文件的所有已缓存 facts。
   * 如果缓存中没有，返回空数组（不触发读取）。
   */
  getFactsForFile(filePath: string): FactEntry[] {
    const cached = this.cache.get(filePath);
    return cached?.facts ?? [];
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
    maxResults: number = FACT_RANK_DEFAULT_MAX,
  ): FactEntry[] {
    const queryTokens = tokenize(query);
    // 空查询时直接返回前 N 条（不做排序）
    if (queryTokens.size === 0) return facts.slice(0, maxResults);

    // v6: 提取查询中的实体名（大写开头连续英文词）
    const queryEntities = extractEntities(query);

    const scored = facts.map(fact => {
      const factTokens = tokenize(fact.factText);
      let hits = 0;
      for (const token of queryTokens) {
        if (factTokens.has(token)) hits++;
      }
      let score = queryTokens.size > 0 ? hits / queryTokens.size : 0;

      // v6: 实体名精确匹配加权
      if (queryEntities.size > 0 && score > 0) {
        const factLower = fact.factText.toLowerCase();
        let entityHits = 0;
        for (const entity of queryEntities) {
          if (factLower.includes(entity)) entityHits++;
        }
        if (entityHits > 0) {
          score += FACT_ENTITY_MATCH_BONUS * (entityHits / queryEntities.size);
        }
      }

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
    maxFacts: number = FACTS_PER_FILE_DEFAULT,
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
   * 清除缓存（包括内容缓存）。
   */
  clearCache(): void {
    this.cache.clear();
    this.contentCache.clear();
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

    const shouldSplitSentences =
      line.length > LONG_LINE_SENTENCE_SPLIT_AT || line.length > MAX_FACT_LENGTH;

    if (!shouldSplitSentences) {
      facts.push(line);
      continue;
    }

    const segments = line.split(/(?<=[。；;.!！?？])\s*/);
    const pieces: string[] = [];
    for (const seg of segments) {
      const trimmed = seg.trim();
      if (trimmed.length < MIN_FACT_LENGTH) continue;
      pieces.push(
        trimmed.length > MAX_FACT_LENGTH
          ? trimmed.substring(0, MAX_FACT_LENGTH) + '...'
          : trimmed,
      );
    }

    if (pieces.length > 0) {
      facts.push(...pieces);
    } else {
      facts.push(
        line.length > MAX_FACT_LENGTH ? line.substring(0, MAX_FACT_LENGTH) + '...' : line,
      );
    }
  }

  return facts;
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
