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

  // 扫描记忆文件
  const allMemories = await scanMemoryFiles(memoryDir, 200);
  const memories = allMemories.filter(m => !alreadySurfaced.has(m.filePath));

  if (memories.length === 0) {
    return { memories: [], duration: Date.now() - startTime, usedLLM: false };
  }

  // 如果有 LLM 适配器，使用 LLM 召回
  if (llmAdapter) {
    try {
      const selected = await llmSelectMemories(query, memories, llmAdapter, maxResults);
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
 * 关键词匹配回退（LLM 不可用时使用）。
 */
function keywordFallback(
  query: string,
  memories: MemoryHeader[],
  maxResults: number,
): MemoryHeader[] {
  const queryLower = query.toLowerCase();
  const queryWords = new Set(
    queryLower.split(/\s+/).filter(w => w.length > 1)
  );

  const scored = memories.map(memory => {
    let score = 0;
    const descLower = (memory.description ?? '').toLowerCase();
    const filenameLower = memory.filename.toLowerCase();

    // 完整子串匹配
    if (descLower.includes(queryLower)) {
      score += 1.0;
    } else {
      // 词重叠
      let hits = 0;
      for (const word of queryWords) {
        if (descLower.includes(word) || filenameLower.includes(word)) {
          hits++;
        }
      }
      score += queryWords.size > 0 ? (hits / queryWords.size) * 0.6 : 0;
    }

    // 新鲜度加分
    const ageDays = Math.floor((Date.now() - memory.mtimeMs) / 86_400_000);
    score += Math.max(0, 1 - ageDays / 30) * 0.2;

    return { memory, score };
  });

  return scored
    .filter(item => item.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.memory);
}
