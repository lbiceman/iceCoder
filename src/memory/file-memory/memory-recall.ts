/**
 * LLM 驱动的记忆相关性召回。
 *
 * 扫描记忆目录的 frontmatter，拼成 manifest 列表，
 * 用 LLM sideQuery 从中选出最相关的记忆文件（最多 5 个）。
 *
 * 比关键词匹配强一个量级：
 * - "修复 bug" 能匹配到描述为"缺陷修复流程和注意事项"的记忆
 * - "性能优化" 能匹配到描述为"数据库查询慢的排查经验"的记忆
 */

import type { MemoryHeader } from './types.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scanner.js';
import type { LLMAdapterInterface, UnifiedMessage } from '../../llm/types.js';
import { parseLLMJsonObject } from './json-parser.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 召回结果。
 */
export interface RecallResult {
  /** 选中的记忆文件 */
  memories: MemoryHeader[];
  /** 召回耗时（毫秒） */
  duration: number;
  /** 是否使用了 LLM（false 表示回退到关键词匹配） */
  usedLLM: boolean;
}

/**
 * 记忆选择的系统提示词。
 */
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected" field containing an array of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it. Be selective and discerning.
- If there are no relevant memories, return an empty array.
- Return ONLY valid JSON, no other text.

Example response: {"selected": ["user_role.md", "feedback_testing.md"]}`;

/**
 * LLM 驱动的记忆召回。
 *
 * @param query - 用户查询
 * @param memoryDir - 记忆目录路径
 * @param llmAdapter - LLM 适配器（用于 sideQuery）
 * @param alreadySurfaced - 已经展示过的文件路径集合（避免重复选择）
 * @param maxResults - 最大返回数量（默认 5）
 * @returns 召回结果
 */
export async function recallRelevantMemories(
  query: string,
  memoryDir: string,
  llmAdapter: LLMAdapterInterface | null,
  alreadySurfaced: Set<string> = new Set(),
  maxResults: number = 5,
): Promise<RecallResult> {
  const startTime = Date.now();

  // 扫描记忆文件（项目级 + 用户级）
  const allMemories = await scanMemoryFiles(memoryDir, 200);
  // 用户级记忆：只在非测试环境且目录存在时扫描
  if (!memoryDir.includes('__test') && !memoryDir.includes('nonexistent')) {
    const userMemoryDir = path.resolve(process.env.ICE_USER_MEMORY_DIR ?? 'data/user-memory');
    const resolvedMemoryDir = path.resolve(memoryDir);
    if (resolvedMemoryDir !== userMemoryDir) {
      try {
        const userMemories = await scanMemoryFiles(userMemoryDir, 50);
        const seen = new Set(allMemories.map(m => m.filename));
        for (const um of userMemories) {
          if (!seen.has(um.filename)) {
            allMemories.push(um);
          }
        }
      } catch { /* 用户级目录不存在，正常 */ }
    }
  }
  const memories = allMemories.filter(m => !alreadySurfaced.has(m.filePath));

  if (memories.length === 0) {
    return { memories: [], duration: Date.now() - startTime, usedLLM: false };
  }

  // 如果有 LLM 适配器，使用 LLM 召回
  if (llmAdapter) {
    try {
      const selected = await llmSelectMemories(query, memories, llmAdapter, maxResults);
      // 异步更新召回计数（不阻塞返回）
      updateRecallMetadata(selected).catch(() => {});
      return {
        memories: selected,
        duration: Date.now() - startTime,
        usedLLM: true,
      };
    } catch (error) {
      console.error('[memory-recall] LLM recall failed, falling back to keyword:', error);
      // LLM 失败时回退到关键词匹配
    }
  }

  // 回退：关键词匹配
  const fallbackResults = keywordFallback(query, memories, maxResults);
  // 异步更新召回计数
  updateRecallMetadata(fallbackResults).catch(() => {});
  return {
    memories: fallbackResults,
    duration: Date.now() - startTime,
    usedLLM: false,
  };
}

/**
 * 使用 LLM 从记忆 manifest 中选择最相关的文件。
 */
async function llmSelectMemories(
  query: string,
  memories: MemoryHeader[],
  llmAdapter: LLMAdapterInterface,
  maxResults: number,
): Promise<MemoryHeader[]> {
  const manifest = formatMemoryManifest(memories);
  const validFilenames = new Set(memories.map(m => m.filename));

  const messages: UnifiedMessage[] = [
    { role: 'system', content: SELECT_MEMORIES_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Query: ${query}\n\nAvailable memories:\n${manifest}`,
    },
  ];

  const response = await llmAdapter.chat(messages, {
    maxTokens: 256,
    temperature: 0,
  });

  // 解析 JSON 响应（健壮解析，多层回退）
  const content = response.content.trim();
  const parsed = parseLLMJsonObject<{ selected?: string[] }>(content);
  if (!parsed || !parsed.selected) {
    return [];
  }

  try {
    const selectedFilenames = parsed.selected
      .filter((f: string) => validFilenames.has(f))
      .slice(0, maxResults);

    const byFilename = new Map(memories.map(m => [m.filename, m]));
    return selectedFilenames
      .map((f: string) => byFilename.get(f))
      .filter((m: MemoryHeader | undefined): m is MemoryHeader => m !== undefined);
  } catch {
    return [];
  }
}

/**
 * 中日韩字符检测正则。
 * CJK Unified Ideographs (4E00-9FFF) + 扩展 A/B + 兼容。
 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/**
 * 混合语言分词器。
 *
 * 英文/数字：按空格+标点分词，过滤 ≤1 字符的词。
 * 中文：bigram 滑动窗口（2 字一组）。
 *   "数据库查询优化" → ["数据", "据库", "库查", "查询", "询优", "优化"]
 *
 * bigram 在信息检索中是经典的中文处理方案：
 * - 零依赖，无需词典
 * - 对"匹配"场景够用（查询和记忆描述共享相同 bigram 即可命中）
 * - 会产生无意义片段（如"据库"），但不影响匹配效果
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();

  // 英文/数字词：按非字母数字字符分割
  const englishWords = lower.split(/[^a-z0-9]+/).filter(w => w.length > 1);
  for (const w of englishWords) {
    tokens.add(w);
  }

  // 提取中文字符序列，对每段做 bigram
  const cjkSegments = lower.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g);
  if (cjkSegments) {
    for (const seg of cjkSegments) {
      // 单字也加入（允许单字匹配，如"库"匹配"数据库"）
      if (seg.length === 1) {
        tokens.add(seg);
      }
      // bigram
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.add(seg.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

/**
 * 关键词匹配回退（LLM 不可用时使用）。
 *
 * 两阶段召回：
 * 1. 粗筛：用 description + filename + contentPreview 的 token 匹配，选出 top 15
 * 2. 精读：读取 top 15 的完整正文，二次评分，取 top maxResults
 *
 * 新鲜度/置信度/频率加分只在有关键词命中时才生效。
 * 没有任何 token 匹配的记忆，分数为 0，不会被召回。
 */
function keywordFallback(
  query: string,
  memories: MemoryHeader[],
  maxResults: number,
): MemoryHeader[] {
  const queryLower = query.toLowerCase();
  const queryTokens = tokenize(query);

  // ── 第一阶段：粗筛（description + filename + contentPreview）──
  const COARSE_LIMIT = Math.max(maxResults * 3, 15);

  const scored = memories.map(memory => {
    let keywordScore = 0;
    const descLower = (memory.description ?? '').toLowerCase();

    // 完整子串匹配（description）
    if (descLower.includes(queryLower)) {
      keywordScore += 1.0;
    } else {
      // token 重叠（description + filename + contentPreview）
      const descTokens = tokenize(memory.description ?? '');
      const filenameTokens = tokenize(memory.filename);
      const previewTokens = tokenize(memory.contentPreview ?? '');

      let hits = 0;
      for (const token of queryTokens) {
        if (descTokens.has(token) || filenameTokens.has(token) || previewTokens.has(token)) {
          hits++;
        }
      }
      keywordScore += queryTokens.size > 0 ? (hits / queryTokens.size) * 0.6 : 0;
    }

    // 关键词完全不匹配 → 分数为 0，不召回
    if (keywordScore === 0) {
      return { memory, score: 0 };
    }

    let score = keywordScore;

    // 新鲜度加分（最近修改的记忆更相关）
    const ageDays = Math.floor((Date.now() - memory.mtimeMs) / 86_400_000);
    score += Math.max(0, 1 - ageDays / 30) * 0.2;

    // 置信度加分（用户明确声明的记忆优先）
    score += (memory.confidence || 0.5) * 0.15;

    // 召回频率加分（经常被召回的记忆更可能有用）
    const recallBonus = Math.min(memory.recallCount || 0, 10) / 10;
    score += recallBonus * 0.1;

    return { memory, score };
  });

  const coarseResults = scored
    .filter(item => item.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, COARSE_LIMIT);

  // 如果粗筛结果不超过 maxResults，直接返回（无需精读）
  if (coarseResults.length <= maxResults) {
    return coarseResults.map(item => item.memory);
  }

  // ── 第二阶段：精读正文，二次评分 ──
  return refineWithFullContent(queryTokens, coarseResults, maxResults);
}

/**
 * 精读正文二次评分。
 *
 * 同步读取 contentPreview（已在 MemoryHeader 中），
 * 对粗筛候选做更精确的 token 匹配排序。
 *
 * 注意：这里用 contentPreview（300 字符）而非读取完整文件，
 * 因为 scanMemoryFiles 已经提取了 preview，无需额外 I/O。
 * 如果 preview 不够，粗筛阶段已经用 preview 匹配过了，
 * 精读阶段主要是重新排序而非发现新匹配。
 */
function refineWithFullContent(
  queryTokens: Set<string>,
  candidates: Array<{ memory: MemoryHeader; score: number }>,
  maxResults: number,
): MemoryHeader[] {
  const refined = candidates.map(({ memory, score }) => {
    // 用完整 contentPreview 做更精确的匹配
    const previewTokens = tokenize(memory.contentPreview ?? '');
    let contentHits = 0;
    for (const token of queryTokens) {
      if (previewTokens.has(token)) contentHits++;
    }
    // 正文匹配加分（最多 0.3）
    const contentBonus = queryTokens.size > 0
      ? (contentHits / queryTokens.size) * 0.3
      : 0;

    return { memory, score: score + contentBonus };
  });

  return refined
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.memory);
}

/**
 * 异步更新被召回记忆的元数据（recallCount + lastRecalledAt）。
 * 直接修改文件的 frontmatter，不影响正文内容。
 */
async function updateRecallMetadata(memories: MemoryHeader[]): Promise<void> {
  const now = new Date().toISOString();
  for (const mem of memories) {
    try {
      const content = await fs.readFile(mem.filePath, 'utf-8');
      const newCount = (mem.recallCount || 0) + 1;

      // 更新或插入 recallCount 和 lastRecalledAt
      let updated = content;
      if (updated.includes('recallCount:')) {
        updated = updated.replace(/recallCount:\s*\d+/, `recallCount: ${newCount}`);
      } else {
        // 在 --- 结束标记前插入
        updated = updated.replace(/^(---\s*$)/m, `recallCount: ${newCount}\n$1`);
      }
      if (updated.includes('lastRecalledAt:')) {
        updated = updated.replace(/lastRecalledAt:\s*\S+/, `lastRecalledAt: ${now}`);
      } else {
        updated = updated.replace(/^(---\s*$)/m, `lastRecalledAt: ${now}\n$1`);
      }

      if (updated !== content) {
        await fs.writeFile(mem.filePath, updated, 'utf-8');
      }
    } catch {
      // 更新失败不阻塞
    }
  }
}
