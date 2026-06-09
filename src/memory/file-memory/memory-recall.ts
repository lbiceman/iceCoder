/**
 * LLM 驱动的记忆相关性召回（v5 — TF-IDF 加权关键词回退）。
 *
 * 扫描记忆目录的 frontmatter，拼成 manifest 列表，
 * 用 LLM sideQuery 从中选出最相关的记忆文件（最多 5 个）。
 * 选中后，对文件内的 facts 做关键词精排，返回最相关的 facts。
 *
 * v2 改进（基于 LongMemEval ICLR 2025）：
 * - manifest 中每个文件附加 top-3 facts 作为 Key Expansion
 * - 召回结果包含 fact 级精排结果
 * - LLM sideQuery 仍然选文件（不选 fact），保持 256 token 输出预算
 *
 * v4 改进：
 * - 否定查询展开：LLM prompt 加否定意识 + 关键词路径加领域展开表
 *   "不要用 Jest" → 补充搜索词 ["test", "testing", "vitest", ...]
 * - 时间范围加权：解析"上周"/"最近三天"等相对时间，软加权匹配记忆
 *   不硬过滤，只提升时间范围内记忆的优先级
 *
 * v5 改进：
 * - TF-IDF 加权关键词回退：给 token 加逆文档频率权重，稀有词权重更高
 * - description/filename token 权重 ×2（比 contentPreview 更重要）
 */

import type { MemoryHeader } from './types.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scanner.js';
import { getScannerCache } from './memory-scanner-cache.js';
import type { LLMAdapterInterface, UnifiedMessage } from '../../llm/types.js';
import { parseLLMJsonObject } from './json-parser.js';
import { getFactIndex, type FactEntry } from './memory-fact-index.js';
import { tokenize, extractEntities } from './memory-tokenizer.js';
import { memoryDecayFactor } from './memory-age.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type RelevanceGateConfig,
  DEFAULT_RELEVANCE_GATE_CONFIG,
  DEFAULT_RECALL_CONFIG,
  DEFAULT_CONFIDENCE_FALLBACK,
  STALE_THRESHOLD_DAYS,
  EXPIRED_THRESHOLD_DAYS,
} from './memory-config.js';

/** 时间范围加权倍数 */
const TIME_RANGE_BOOST = 1.5;
/** 事件时间加权倍数 */
const EVENT_TIME_BOOST = 2.0;
/** 关联扩展最大数量 */
const MAX_RELATED_EXPAND = 3;
/** 召回元数据批量写入间隔（毫秒） */
const RECALL_FLUSH_INTERVAL_MS = 30_000;
/** LLM 召回超时（毫秒） */
const LLM_RECALL_TIMEOUT_MS = 30_000;
/** LLM 召回最少候选数：候选数不足时直接走关键词回退，避免无意义的 LLM 调用 */
export const LLM_RECALL_MIN_CANDIDATES = 4;
/** LLM 召回最大输出 token */
const LLM_RECALL_MAX_TOKENS = 512;
/** Fact 选择上限 */
const FACT_SELECTION_LIMIT = 30;
/** 置信度过滤阈值（低于此值的记忆不参与召回） */
const CONFIDENCE_FILTER_THRESHOLD = 0.3;
/** 置信度加分权重 */
const CONFIDENCE_BONUS_WEIGHT = 0.15;
/** 召回频率加分权重 */
const RECALL_BONUS_WEIGHT = 0.1;
/** 召回频率加分上限 */
const RECALL_BONUS_CAP = 10;
/** 预取命中加分 */
const PREFETCH_HIT_BONUS = 0.2;
/** 实体匹配加分上限 */
const ENTITY_MATCH_BONUS_MAX = 0.3;
/** 内容匹配加分上限 */
const CONTENT_BONUS_MAX = 0.3;
/** description/filename 权重倍数（比 contentPreview 更重要） */
const DESC_FILENAME_WEIGHT_MULTIPLIER = 2;
/** 分数过滤阈值 */
const SCORE_FILTER_THRESHOLD = 0.05;
/** 关键词粗筛倍数 */
const COARSE_LIMIT_MULTIPLIER = 3;
/** 关键词粗筛最小数量 */
const COARSE_LIMIT_MIN = 15;
/** Tags Jaccard 阈值（关联扩展） */
const TAGS_JACCARD_THRESHOLD = 0.2;

/**
 * 召回结果。
 */
/** 召回选项 */
export interface RecallOptions {
  /** 粗召回：降低过滤阈值，零命中时按活跃度兜底 */
  relaxed?: boolean;
}

export interface RecallResult {
  /** 选中的记忆文件 */
  memories: MemoryHeader[];
  /** 选中文件中精排后的 facts（按相关性排序） */
  facts: FactEntry[];
  /** 召回耗时（毫秒） */
  duration: number;
  /** 是否使用了 LLM（false 表示回退到关键词匹配） */
  usedLLM: boolean;
}

type RecallIntent = 'execute' | 'inspect' | 'question';

export function inferRecallIntent(query: string): RecallIntent {
  const q = query.toLowerCase();
  if (/修复|修改|实现|新增|创建|重构|测试|运行|验证|fix|edit|modify|implement|create|refactor|test|run|verify/.test(q)) {
    return 'execute';
  }
  if (/查看|读取|搜索|解释|说明|分析|read|search|inspect|explain|analyze/.test(q)) return 'inspect';
  return 'question';
}

export function filterByMemoryLevelForIntent(memories: MemoryHeader[], intent: RecallIntent): MemoryHeader[] {
  return memories.filter(memory => {
    // Backward compatibility: old memory files/tests do not have v2 metadata.
    // Keep their previous recall behavior until they are naturally rewritten.
    if (!memory.level || !memory.evidenceStrength) return true;
    if (intent === 'execute') {
      return memory.level !== 'session_state';
    }
    if (intent === 'inspect') {
      return memory.level !== 'session_state' || memory.evidenceStrength === 'explicit';
    }
    return true;
  });
}

function dedupeConflictingMemories(memories: MemoryHeader[]): MemoryHeader[] {
  const groups = new Map<string, MemoryHeader[]>();
  for (const memory of memories) {
    const key = conflictKey(memory);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }

  const suppressed = new Set<string>();
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const winner = [...group].sort(compareMemoryPriority)[0];
    for (const memory of group) {
      if (memory.filePath !== winner.filePath) suppressed.add(memory.filePath);
    }
  }
  return memories.filter(memory => !suppressed.has(memory.filePath));
}

function conflictKey(memory: MemoryHeader): string | null {
  if (!memory.level || !memory.evidenceStrength) return null;
  const topicTag = memory.tags.find(tag => /^(pref|preference|rule|topic|tool|lang|framework):/.test(tag));
  if (topicTag) return `${memory.level}:${topicTag.toLowerCase()}`;
  return null;
}

function compareMemoryPriority(a: MemoryHeader, b: MemoryHeader): number {
  const evidenceRank: Record<string, number> = { explicit: 4, repeated: 3, inferred: 2, weak: 1 };
  const evidenceDelta = (evidenceRank[b.evidenceStrength] ?? 0) - (evidenceRank[a.evidenceStrength] ?? 0);
  if (evidenceDelta !== 0) return evidenceDelta;
  const confidenceDelta = b.confidence - a.confidence;
  if (confidenceDelta !== 0) return confidenceDelta;
  return b.mtimeMs - a.mtimeMs;
}

/**
 * 记忆选择的系统提示词（v7 — 合并选文件和精排为一次调用）。
 */
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to an AI assistant as it processes a user's query. You will be given the user's query and a list of available memory files, each with key facts.

Return a JSON object with:
- "selected": array of filenames for ALL memories relevant to the query
- "selected_facts": array of objects, each with "id" (fact ID like F1, F2...) and "reasoning" (why this fact is relevant)

Guidelines:
- **Strict relevance**: Select a memory only when it directly helps answer or execute the current query. When in doubt, leave it out.
- For coding/debugging/editing tasks, prefer project facts and concrete technical constraints. Include personal preferences only when they strongly match the requested action.
- If no memories are relevant, return empty arrays.
- **Negation awareness**: If the query expresses a negative preference ("don't use X", "不要用 X"), also select memories about alternatives to X.
- **Time awareness**: If the query references a time period, prefer memories with timestamps in that period, but do not exclude others.
- **Fact selection**: From the selected files, pick only the specific facts most relevant to answering or executing the query. Limit to 30 facts total.
- Return ONLY valid JSON, no other text.
Example: {"selected": ["user_role.md", "feedback_testing.md"], "selected_facts": [{"id": "F1", "reasoning": "Directly answers the query about user role"}, {"id": "F5", "reasoning": "Provides context about testing preferences"}]}`;

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
  prefetchedPaths: Set<string> = new Set(),
  topicSwitched: boolean = false,
  options?: RecallOptions,
): Promise<RecallResult> {
  const relaxed = options?.relaxed === true;
  const confidenceThreshold = relaxed ? 0.2 : CONFIDENCE_FILTER_THRESHOLD;
  const scoreThreshold = relaxed ? 0.01 : SCORE_FILTER_THRESHOLD;
  const startTime = Date.now();

  // ── 空目录快速跳过 ──
  // 如果扫描缓存已知该目录为空（且未过期），直接返回，避免重复扫描
  const scannerCache = getScannerCache();
  const cachedCount = scannerCache.getCachedCount(memoryDir);
  if (cachedCount === 0) {
    return { memories: [], facts: [], duration: Date.now() - startTime, usedLLM: false };
  }

  // 扫描记忆文件（项目级 + 用户级，使用扫描缓存）
  const allMemories = await scannerCache.scan(memoryDir, 200);
  // 用户级记忆：只在非测试环境且目录存在时扫描
  if (!memoryDir.includes('__test') && !memoryDir.includes('nonexistent')) {
    const userMemoryDir = path.resolve(process.env.ICE_USER_MEMORY_DIR ?? 'data/user-memory');
    const resolvedMemoryDir = path.resolve(memoryDir);
    if (resolvedMemoryDir !== userMemoryDir) {
      try {
        const userMemories = await scannerCache.scan(userMemoryDir, 50);
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

  // 过滤极低置信度和不适合当前任务类型的记忆（减少噪声，降低幻觉）
  const filteredMemories = dedupeConflictingMemories(
    filterByMemoryLevelForIntent(
      memories.filter(m => m.confidence >= confidenceThreshold),
      inferRecallIntent(query),
    ),
  );

  if (filteredMemories.length === 0) {
    return { memories: [], facts: [], duration: Date.now() - startTime, usedLLM: false };
  }

  // v4: 预计算否定展开和时间范围（两条路径共用）
  const negationExpansions = expandNegationQuery(query);
  const timeRange = parseTimeRange(query);

  if (negationExpansions.length > 0) {
    console.debug(`[memory-recall] Negation expansion: +${negationExpansions.length} tokens [${negationExpansions.slice(0, 5).join(', ')}${negationExpansions.length > 5 ? '...' : ''}]`);
  }
  if (timeRange) {
    console.debug(`[memory-recall] Time range detected: "${timeRange.matchedText}" → ${new Date(timeRange.since).toISOString().split('T')[0]} ~ ${new Date(timeRange.until).toISOString().split('T')[0]}`);
  }

  // 构建 Fact Index（缓存，mtime 失效）
  // FactIndex 现在自行管理文件内容缓存，无需外部读取
  const factIndex = getFactIndex();
  await factIndex.buildIndex(filteredMemories);

  // 如果有 LLM 适配器且候选数足够，使用 LLM 召回（v7：一次调用同时选文件和精排 facts）
  // 候选数不足时直接走关键词回退，避免无意义的 LLM 调用（10-14s 开销）
  if (llmAdapter && filteredMemories.length >= LLM_RECALL_MIN_CANDIDATES) {
    try {
      // LLM 召回带 30 秒超时，防止无限挂起
      const llmResult = await Promise.race([
        llmSelectAndRankMemories(query, filteredMemories, llmAdapter, maxResults, factIndex, timeRange, topicSwitched),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`LLM recall timeout (${LLM_RECALL_TIMEOUT_MS / 1000}s)`)), LLM_RECALL_TIMEOUT_MS)),
      ]);
      // ── 关联扩展（1 跳）──
      const expanded = expandRelatedMemories(llmResult.selectedMemories, filteredMemories, alreadySurfaced);
      const allSelected = [...llmResult.selectedMemories, ...expanded];
      if (allSelected.length > 0) {
        // 如果有关联扩展的文件，补充它们的 facts
        let selectedFacts = llmResult.selectedFacts;
        if (expanded.length > 0) {
          const expandedFacts = await extractFactsFromSelected(query, expanded, factIndex);
          selectedFacts = [...selectedFacts, ...expandedFacts].slice(0, FACT_SELECTION_LIMIT);
        }
        // 异步更新召回计数（不阻塞返回）
        updateRecallMetadata(allSelected).catch(() => {});
        return {
          memories: allSelected,
          facts: selectedFacts,
          duration: Date.now() - startTime,
          usedLLM: true,
        };
      }
      console.debug('[memory-recall] LLM recall returned empty selection, falling back to keyword');
    } catch (error) {
      console.error('[memory-recall] LLM recall failed, falling back to keyword:', error);
      // LLM 失败时回退到关键词匹配
    }
  }

  // 回退：关键词匹配
  let fallbackResults = keywordFallback(
    query,
    filteredMemories,
    maxResults,
    negationExpansions,
    timeRange,
    prefetchedPaths,
    topicSwitched,
    scoreThreshold,
  );
  if (relaxed && fallbackResults.length === 0 && filteredMemories.length > 0) {
    fallbackResults = recallActivityFallback(filteredMemories, maxResults);
  }
  // ── 关联扩展（关键词回退路径也支持）──
  const fallbackExpanded = expandRelatedMemories(fallbackResults, filteredMemories, alreadySurfaced);
  const allFallback = [...fallbackResults, ...fallbackExpanded];
  const fallbackFacts = await extractFactsFromSelected(query, allFallback, factIndex);
  // 异步更新召回计数
  updateRecallMetadata(allFallback).catch(() => {});
  return {
    memories: allFallback,
    facts: fallbackFacts,
    duration: Date.now() - startTime,
    usedLLM: false,
  };
}

/**
 * LLM 一次调用同时选文件和精排 facts 的结果。
 */
interface LLMSelectResult {
  /** 选中的记忆文件 */
  selectedMemories: MemoryHeader[];
  /** LLM 选中的 fact IDs 对应的精排结果 */
  selectedFacts: FactEntry[];
}

/**
 * 使用 LLM 从记忆 manifest 中选择最相关的文件，同时精排 facts（v7 — 合并为一次调用）。
 *
 * 之前需要两次 LLM 调用：选文件 + 精排 facts。
 * 现在一次 LLM 调用同时返回选中的文件和 facts，节省 ~40% token。
 */
async function llmSelectAndRankMemories(
  query: string,
  memories: MemoryHeader[],
  llmAdapter: LLMAdapterInterface,
  maxResults: number,
  factIndex: import('./memory-fact-index.js').FactIndex,
  timeRange: TimeRange | null = null,
  topicSwitched: boolean = false,
): Promise<LLMSelectResult> {
  const { manifest, factIdMap } = formatManifestWithFactIds(memories, query, factIndex);
  const validFilenames = new Set(memories.map(m => m.filename));

  // v4: 时间范围提示
  const timeHint = timeRange
    ? `\n\nNote: The user is asking about memories from ${new Date(timeRange.since).toISOString().split('T')[0]} to ${new Date(timeRange.until).toISOString().split('T')[0]} ("${timeRange.matchedText}"). Prefer memories with timestamps in this range.`
    : '';

  // 话题切换提示：优先项目约定，降低用户偏好权重
  const topicHint = topicSwitched
    ? `\n\nNote: The conversation has shifted to a new topic. Prioritize project conventions and technical facts over personal preferences. Only include preferences if directly relevant to the current query.`
    : '';

  const messages: UnifiedMessage[] = [
    { role: 'system', content: SELECT_MEMORIES_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Query: ${query}\n\nAvailable memories:\n${manifest}${timeHint}${topicHint}`,
    },
  ];

  const response = await llmAdapter.chat(messages, {
    maxTokens: LLM_RECALL_MAX_TOKENS,
    temperature: 0,
  });

  // 解析 JSON 响应
  const content = response.content.trim();
  console.debug(`[memory-recall] LLM select+rank response: ${content.substring(0, 500)}`);
  const parsed = parseLLMJsonObject<{
    selected?: string[];
    selected_facts?: Array<{ id: string; reasoning: string }>;
  }>(content);

  if (!parsed || !parsed.selected || parsed.selected.length === 0) {
    console.debug(`[memory-recall] LLM returned no selections. Manifest had ${memories.length} files.`);
    return { selectedMemories: [], selectedFacts: [] };
  }

  try {
    // 解析选中的文件
    const selectedFilenames = parsed.selected
      .filter((f: string) => validFilenames.has(f))
      .slice(0, maxResults);

    const byFilename = new Map(memories.map(m => [m.filename, m]));
    const selectedMemories = selectedFilenames
      .map((f: string) => byFilename.get(f))
      .filter((m: MemoryHeader | undefined): m is MemoryHeader => m !== undefined);

    // 解析选中的 facts
    let selectedFacts: FactEntry[] = [];
    if (parsed.selected_facts && factIdMap.size > 0) {
      const factEntries: FactEntry[] = [];
      for (const sf of parsed.selected_facts) {
        const fact = factIdMap.get(sf.id);
        if (fact) factEntries.push(fact);
      }
      if (factEntries.length > 0) {
        selectedFacts = factEntries.slice(0, FACT_SELECTION_LIMIT);
      }
    }

    // 如果 LLM 没有返回 selected_facts，回退到关键词精排
    if (selectedFacts.length === 0 && selectedMemories.length > 0) {
      selectedFacts = await extractFactsFromSelected(query, selectedMemories, factIndex);
    }

    return { selectedMemories, selectedFacts };
  } catch {
    return { selectedMemories: [], selectedFacts: [] };
  }
}

// ─── v4: 否定查询展开 ───

/**
 * 否定查询正则：匹配"不要用 X"、"don't use X"等模式，提取否定对象。
 */
const NEGATION_PATTERNS: RegExp[] = [
  // 中文否定
  /(?:不要|别|不用|禁止|停止|以后不要?|以后别)\s*(?:用|写|加|做|搞)?\s*(\S+)/,
  // 英文否定
  /(?:don'?t use|never use|stop using|no more|avoid)\s+(\S+)/i,
];

/**
 * 领域展开表：否定对象 → 同领域搜索词。
 *
 * 不做同义词映射（Jest→Vitest），而是做领域展开（Jest→testing）。
 * 领域映射表小且稳定，维护成本低。
 * 同时包含常见替代品名称，提高命中率。
 */
const DOMAIN_EXPANSION: Record<string, string[]> = {
  // 测试框架
  jest:       ['test', 'testing', '测试', 'vitest', 'mocha', 'playwright', 'cypress'],
  vitest:     ['test', 'testing', '测试', 'jest', 'mocha'],
  mocha:      ['test', 'testing', '测试', 'jest', 'vitest'],
  cypress:    ['test', 'testing', 'e2e', '测试', 'playwright'],
  playwright: ['test', 'testing', 'e2e', '测试', 'cypress'],
  // 构建工具
  webpack:    ['build', 'bundler', '构建', '打包', 'vite', 'esbuild', 'rollup'],
  rollup:     ['build', 'bundler', '构建', 'vite', 'webpack', 'esbuild'],
  vite:       ['build', 'bundler', '构建', 'webpack', 'rollup', 'esbuild'],
  esbuild:    ['build', 'bundler', '构建', 'vite', 'webpack'],
  // 包管理
  npm:        ['package', 'install', '包管理', 'yarn', 'pnpm'],
  yarn:       ['package', 'install', '包管理', 'npm', 'pnpm'],
  pnpm:       ['package', 'install', '包管理', 'npm', 'yarn'],
  // 变量声明 / JS 语法
  var:        ['variable', 'declaration', '变量', 'let', 'const'],
  semicolons: ['style', 'format', '风格', '分号', 'prettier', 'eslint'],
  // 框架
  react:      ['framework', 'frontend', '前端', '框架', 'vue', 'svelte', 'angular'],
  vue:        ['framework', 'frontend', '前端', '框架', 'react', 'svelte'],
  angular:    ['framework', 'frontend', '前端', '框架', 'react', 'vue'],
  // 语言
  javascript: ['language', '语言', 'typescript', 'js', 'ts'],
  python:     ['language', '语言', 'java', 'golang', 'rust'],
  // 数据库
  mysql:      ['database', 'db', '数据库', 'postgres', 'sqlite', 'mongodb'],
  mongodb:    ['database', 'db', '数据库', 'mysql', 'postgres'],
  postgres:   ['database', 'db', '数据库', 'mysql', 'mongodb', 'postgresql'],
  redis:      ['cache', '缓存', 'memcached'],
};

/**
 * 从查询中提取否定对象并展开为同领域搜索词。
 *
 * "不要用 Jest" → ["jest", "test", "testing", "测试", "vitest", "mocha", ...]
 * "don't use Webpack" → ["webpack", "build", "bundler", "构建", "vite", ...]
 *
 * 即使没有映射表命中，也把否定对象本身加入搜索词
 * （"不要用 Jest" 至少能匹配到包含 "jest" 的记忆）。
 *
 * @returns 补充的搜索词列表（空数组表示查询中没有否定模式）
 */
export function expandNegationQuery(query: string): string[] {
  const extra: string[] = [];
  for (const pattern of NEGATION_PATTERNS) {
    const match = query.match(pattern);
    if (!match || !match[1]) continue;
    const target = match[1].toLowerCase().replace(/['".,;!?。，；！？]/g, '');
    if (target.length < 2) continue; // 过短的匹配忽略

    // 否定对象本身加入搜索词
    extra.push(target);

    // 领域展开
    const expansions = DOMAIN_EXPANSION[target];
    if (expansions) {
      extra.push(...expansions);
    }
  }
  return extra;
}

// ─── v4: 时间范围加权 ───

/**
 * 时间范围描述。
 */
export interface TimeRange {
  /** 起始时间（毫秒时间戳） */
  since: number;
  /** 结束时间（毫秒时间戳） */
  until: number;
  /** 匹配的原始文本（用于 LLM 提示） */
  matchedText: string;
}

/**
 * 从查询中解析相对时间表达式。
 *
 * 支持：
 * - 中文："上周"、"昨天"、"前天"、"最近三天"、"这周"、"本周"、"上个月"、"最近"
 * - 英文："last week"、"yesterday"、"past 3 days"、"this week"、"last month"、"recently"
 * - 绝对月份："July 2023"、"2023年7月"
 * - 绝对日期："18 July 2023"、"2023年7月18日"、"2023-07-18"
 *
 * 返回 null 表示查询中没有时间线索。
 */
export function parseTimeRange(query: string): TimeRange | null {
  const now = Date.now();
  const DAY = 86_400_000;

  // ── 绝对日期（优先级最高，最精确）──

  // ISO 格式：2023-07-18
  const isoDate = query.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDate) {
    const d = new Date(`${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T00:00:00Z`);
    if (!isNaN(d.getTime())) {
      return { since: d.getTime(), until: d.getTime() + DAY, matchedText: isoDate[0] };
    }
  }

  // 中文绝对日期：2023年7月18日
  const absDateCN = query.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (absDateCN) {
    const d = new Date(Date.UTC(parseInt(absDateCN[1]), parseInt(absDateCN[2]) - 1, parseInt(absDateCN[3])));
    if (!isNaN(d.getTime())) {
      return { since: d.getTime(), until: d.getTime() + DAY, matchedText: absDateCN[0] };
    }
  }

  // 英文绝对日期：18 July 2023 / July 18, 2023 / July 18 2023
  const MONTH_NAMES = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
  const MONTH_MAP: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const absDateEN1 = query.match(new RegExp(`(\\d{1,2})\\s+(${MONTH_NAMES})\\s+(\\d{4})`, 'i'));
  if (absDateEN1) {
    const month = MONTH_MAP[absDateEN1[2].toLowerCase()];
    if (month !== undefined) {
      const d = Date.UTC(parseInt(absDateEN1[3]), month, parseInt(absDateEN1[1]));
      return { since: d, until: d + DAY, matchedText: absDateEN1[0] };
    }
  }
  const absDateEN2 = query.match(new RegExp(`(${MONTH_NAMES})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'));
  if (absDateEN2) {
    const month = MONTH_MAP[absDateEN2[1].toLowerCase()];
    if (month !== undefined) {
      const d = Date.UTC(parseInt(absDateEN2[3]), month, parseInt(absDateEN2[2]));
      return { since: d, until: d + DAY, matchedText: absDateEN2[0] };
    }
  }

  // ── 绝对月份 ──

  // 中文：2023年7月
  const absMonthCN = query.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (absMonthCN && !absDateCN) { // 避免和绝对日期重复匹配
    const year = parseInt(absMonthCN[1]);
    const month = parseInt(absMonthCN[2]) - 1;
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 1));
    if (!isNaN(start.getTime())) {
      return { since: start.getTime(), until: end.getTime(), matchedText: absMonthCN[0] };
    }
  }

  // 英文：July 2023 / in July 2023
  const absMonthEN = query.match(new RegExp(`(?:in\\s+)?(${MONTH_NAMES})\\s+(\\d{4})`, 'i'));
  if (absMonthEN && !absDateEN1 && !absDateEN2) {
    const month = MONTH_MAP[absMonthEN[1].toLowerCase()];
    if (month !== undefined) {
      const year = parseInt(absMonthEN[2]);
      const start = Date.UTC(year, month, 1);
      const end = Date.UTC(year, month + 1, 1);
      return { since: start, until: end, matchedText: absMonthEN[0] };
    }
  }

  // ── 相对时间（现有逻辑）──

  // "the [weekday] before [date]" — LoCoMo 高频模式
  // e.g., "the Sunday before 25 May 2023" → 21 May 2023
  const WEEKDAY_NAMES = '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)';
  const WEEKDAY_MAP: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  };
  // "the week before [date]" → 7-day range ending before date
  const weekBeforeMatch = query.match(new RegExp(`the\\s+week\\s+before\\s+(\\d{1,2})\\s+(${MONTH_NAMES})\\s+(\\d{4})`, 'i'));
  if (weekBeforeMatch) {
    const month = MONTH_MAP[weekBeforeMatch[2].toLowerCase()];
    if (month !== undefined) {
      const refDate = Date.UTC(parseInt(weekBeforeMatch[3]), month, parseInt(weekBeforeMatch[1]));
      return { since: refDate - 7 * DAY, until: refDate, matchedText: weekBeforeMatch[0] };
    }
  }
  // "the [weekday] before [date]"
  const weekdayBeforeMatch = query.match(new RegExp(`the\\s+(${WEEKDAY_NAMES})\\s+before\\s+(\\d{1,2})\\s+(${MONTH_NAMES})\\s+(\\d{4})`, 'i'));
  if (weekdayBeforeMatch) {
    const targetWeekday = WEEKDAY_MAP[weekdayBeforeMatch[1].toLowerCase()];
    const month = MONTH_MAP[weekdayBeforeMatch[3].toLowerCase()];
    if (targetWeekday !== undefined && month !== undefined) {
      const refDate = new Date(Date.UTC(parseInt(weekdayBeforeMatch[4]), month, parseInt(weekdayBeforeMatch[2])));
      // Walk back from refDate to find the previous target weekday
      const refDay = refDate.getUTCDay();
      let daysBack = refDay - targetWeekday;
      if (daysBack <= 0) daysBack += 7; // ensure we go backwards at least 1 day
      const targetMs = refDate.getTime() - daysBack * DAY;
      return { since: targetMs, until: targetMs + DAY, matchedText: weekdayBeforeMatch[0] };
    }
  }
  // "the week before [ISO date]"
  const weekBeforeISO = query.match(/the\s+week\s+before\s+(\d{4})-(\d{2})-(\d{2})/i);
  if (weekBeforeISO) {
    const refDate = new Date(`${weekBeforeISO[1]}-${weekBeforeISO[2]}-${weekBeforeISO[3]}T00:00:00Z`);
    if (!isNaN(refDate.getTime())) {
      return { since: refDate.getTime() - 7 * DAY, until: refDate.getTime(), matchedText: weekBeforeISO[0] };
    }
  }
  // "N years/days/months ago"
  const nTimeAgo = query.match(/(\d+)\s+(years?|months?|days?)\s+ago/i);
  if (nTimeAgo) {
    const n = parseInt(nTimeAgo[1], 10);
    const unit = nTimeAgo[2].toLowerCase();
    if (n > 0 && n <= 100) {
      let since: number;
      if (unit.startsWith('year')) since = now - n * 365 * DAY;
      else if (unit.startsWith('month')) since = now - n * 30 * DAY;
      else since = now - n * DAY;
      return { since, until: now, matchedText: nTimeAgo[0] };
    }
  }

  // 中文：最近N天
  const recentDaysCN = query.match(/最近\s*(\d+)\s*天/);
  if (recentDaysCN) {
    const days = parseInt(recentDaysCN[1], 10);
    if (days > 0 && days <= 365) {
      return { since: now - days * DAY, until: now, matchedText: recentDaysCN[0] };
    }
  }

  // 英文：past/last N days
  const recentDaysEN = query.match(/(?:past|last)\s+(\d+)\s+days?/i);
  if (recentDaysEN) {
    const days = parseInt(recentDaysEN[1], 10);
    if (days > 0 && days <= 365) {
      return { since: now - days * DAY, until: now, matchedText: recentDaysEN[0] };
    }
  }

  // 固定模式（按优先级排列，先匹配更具体的）
  const fixedPatterns: Array<{ re: RegExp; since: number; until: number }> = [
    { re: /昨天|yesterday/i,           since: now - 2 * DAY,  until: now - DAY },
    { re: /前天/,                       since: now - 3 * DAY,  until: now - 2 * DAY },
    { re: /上周|last\s+week/i,         since: now - 14 * DAY, until: now - 7 * DAY },
    { re: /这周|本周|this\s+week/i,    since: now - 7 * DAY,  until: now },
    { re: /上个月|last\s+month/i,      since: now - 60 * DAY, until: now - 30 * DAY },
    { re: /最近|recently/i,            since: now - 7 * DAY,  until: now },
  ];

  for (const { re, since, until } of fixedPatterns) {
    const match = query.match(re);
    if (match) {
      return { since, until, matchedText: match[0] };
    }
  }

  return null;
}

/**
 * 计算记忆的时间范围加权因子。
 *
 * 优先使用事件时间（eventDateMs），回退到文件活跃时间。
 * - 事件时间精确匹配：返回 EVENT_TIME_BOOST（最高优先级）
 * - 文件活跃时间匹配：返回 TIME_RANGE_BOOST
 * - 不在范围内：返回 1.0（不惩罚，只加分）
 *
 * 软加权设计：即使时间解析不精确，也不会漏掉相关记忆。
 */
function computeTimeBoost(memory: MemoryHeader, range: TimeRange): number {
  // 优先用事件时间（eventDateMs）— 这是事实发生的真实时间
  const eventMs = memory.eventDateMs || 0;
  if (eventMs > 0 && eventMs >= range.since && eventMs <= range.until) {
    return EVENT_TIME_BOOST;
  }

  // 回退：文件活跃时间（写入/修改/召回时间）
  const activeMs = Math.max(memory.lastRecalledMs || 0, memory.mtimeMs, memory.createdMs);
  if (activeMs >= range.since && activeMs <= range.until) {
    return TIME_RANGE_BOOST;
  }
  return 1.0;
}

// ─── v5: TF-IDF 加权 ───

/**
 * 构建逆文档频率（IDF）表。
 *
 * IDF(token) = log(N / df(token))
 * - N = 文档总数
 * - df(token) = 包含该 token 的文档数
 *
 * 稀有词（如 "typescript"）IDF 高，常见词（如 "the"）IDF 低。
 * 零额外 I/O：复用已扫描的 MemoryHeader 中的 description + filename + contentPreview。
 */
export function buildIdfMap(memories: MemoryHeader[]): Map<string, number> {
  const N = memories.length;
  if (N === 0) return new Map();

  // 统计每个 token 出现在多少个文档中
  const df = new Map<string, number>();
  for (const mem of memories) {
    const docTokens = new Set<string>();
    for (const t of tokenize(mem.description ?? '')) docTokens.add(t);
    for (const t of tokenize(mem.filename)) docTokens.add(t);
    for (const t of tokenize(mem.contentPreview ?? '')) docTokens.add(t);

    for (const token of docTokens) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  // 计算 IDF：log((N + 1) / (df + 1)) + 1
  // 加 1 平滑避免 log(1)=0 的问题（单文档场景）
  const idfMap = new Map<string, number>();
  for (const [token, count] of df) {
    idfMap.set(token, Math.log((N + 1) / (count + 1)) + 1);
  }
  return idfMap;
}

// ─── IDF 表缓存 ───

/** IDF 缓存条目 */
interface IdfCacheEntry {
  idfMap: Map<string, number>;
  /** 缓存时记忆列表的指纹（filenames + mtimeMs 排序后的哈希） */
  fingerprint: string;
}

/** 进程级 IDF 缓存 */
let idfCache: IdfCacheEntry | null = null;

/**
 * 计算记忆列表的指纹（用于判断是否需要重建 IDF 表）。
 * 基于 filenames + mtimeMs 排序后拼接，快速判断记忆列表是否变化。
 * 使用 hash 避免大记忆集（100+ 文件）时截断导致指纹碰撞。
 */
function computeMemoriesFingerprint(memories: MemoryHeader[]): string {
  const sorted = memories
    .map(m => `${m.filename}:${m.mtimeMs}`)
    .sort()
    .join('|');
  // 简单 hash：将完整字符串压缩为确定性短字符串
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    hash = ((hash << 5) - hash + sorted.charCodeAt(i)) | 0;
  }
  return `${memories.length}:${Math.abs(hash).toString(36)}`;
}

/**
 * 带缓存的 IDF 表构建。
 *
 * 如果记忆列表未变化（指纹相同），直接返回缓存结果；
 * 否则重新计算并更新缓存。
 */
export function buildIdfMapCached(memories: MemoryHeader[]): Map<string, number> {
  const fingerprint = computeMemoriesFingerprint(memories);

  if (idfCache && idfCache.fingerprint === fingerprint) {
    return idfCache.idfMap;
  }

  const idfMap = buildIdfMap(memories);
  idfCache = { idfMap, fingerprint };
  return idfMap;
}

/**
 * 使 IDF 缓存失效（记忆文件变更后调用）。
 */
export function invalidateIdfCache(): void {
  idfCache = null;
}

/**
 * 关键词匹配回退（LLM 不可用时使用）。
 *
 * 两阶段召回：
 * 1. 粗筛：用 description + filename + contentPreview 的 TF-IDF 加权匹配，选出 top 15
 * 2. 精读：读取 top 15 的完整正文，二次评分，取 top maxResults
 *
 * 新鲜度/置信度/频率加分只在有关键词命中时才生效。
 * 没有任何 token 匹配的记忆，分数为 0，不会被召回。
 *
 * v4 改进：
 * - 否定展开词合并到 queryTokens（扩大匹配面）
 * - 时间范围加权（范围内记忆 score ×1.5）
 *
 * v5 改进：
 * - TF-IDF 加权：稀有 token 命中权重更高（"typescript" > "the"）
 * - description/filename 命中权重 ×2（比 contentPreview 更重要）
 */
/** 粗召回零命中时按活跃度兜底 */
function recallActivityFallback(memories: MemoryHeader[], maxResults: number): MemoryHeader[] {
  return [...memories]
    .sort((a, b) => {
      const scoreA = (a.recallCount || 0) * 2 + (a.confidence || 0.5) + (a.type === 'user' ? 1.5 : 0);
      const scoreB = (b.recallCount || 0) * 2 + (b.confidence || 0.5) + (b.type === 'user' ? 1.5 : 0);
      return scoreB - scoreA;
    })
    .slice(0, maxResults);
}

function keywordFallback(
  query: string,
  memories: MemoryHeader[],
  maxResults: number,
  negationExpansions: string[] = [],
  timeRange: TimeRange | null = null,
  prefetchedPaths: Set<string> = new Set(),
  topicSwitched: boolean = false,
  scoreFilterThreshold: number = SCORE_FILTER_THRESHOLD,
): MemoryHeader[] {
  const queryLower = query.toLowerCase();
  const queryTokens = tokenize(query);

  // v6: 提取实体名（大写开头的连续英文词），用于精确匹配加权
  const queryEntities = extractEntities(query);

  // v4: 否定展开词合并到搜索 token 集合
  if (negationExpansions.length > 0) {
    for (const word of negationExpansions) {
      for (const token of tokenize(word)) {
        queryTokens.add(token);
      }
    }
  }

  // v5: 构建 IDF 表（带缓存，记忆列表未变化时零计算）
  const idfMap = buildIdfMapCached(memories);

  // 计算查询 token 的总 IDF 权重（用于归一化）
  let totalQueryIdf = 0;
  for (const token of queryTokens) {
    totalQueryIdf += idfMap.get(token) ?? 1.0; // 未知 token 默认 IDF=1.0
  }

  // ── 第一阶段：粗筛（description + filename + contentPreview，TF-IDF 加权）──
  const COARSE_LIMIT = Math.max(maxResults * COARSE_LIMIT_MULTIPLIER, COARSE_LIMIT_MIN);

  const scored = memories.map(memory => {
    let keywordScore = 0;
    const descLower = (memory.description ?? '').toLowerCase();

    // 完整子串匹配（description）— 最高优先级
    if (descLower.includes(queryLower)) {
      keywordScore += 1.0;
    } else {
      // v5: TF-IDF 加权 token 匹配
      const descTokens = tokenize(memory.description ?? '');
      const filenameTokens = tokenize(memory.filename);
      const previewTokens = tokenize(memory.contentPreview ?? '');

      let weightedHits = 0;
      for (const token of queryTokens) {
        const idf = idfMap.get(token) ?? 1.0;
        // description/filename 命中权重 ×2（更重要的字段）
        if (descTokens.has(token) || filenameTokens.has(token)) {
          weightedHits += idf * DESC_FILENAME_WEIGHT_MULTIPLIER;
        } else if (previewTokens.has(token)) {
          weightedHits += idf;
        }
      }
      keywordScore += totalQueryIdf > 0 ? (weightedHits / (totalQueryIdf * DESC_FILENAME_WEIGHT_MULTIPLIER)) * CONTENT_BONUS_MAX : 0;
    }

    // v6: 实体名精确匹配加权 — 查询中的实体名出现在记忆中时额外加分
    if (queryEntities.size > 0 && keywordScore > 0) {
      const memText = `${memory.description ?? ''} ${memory.contentPreview ?? ''} ${memory.filename}`.toLowerCase();
      let entityHits = 0;
      for (const entity of queryEntities) {
        if (memText.includes(entity)) entityHits++;
      }
      if (entityHits > 0) {
        keywordScore += ENTITY_MATCH_BONUS_MAX * (entityHits / queryEntities.size);
      }
    }

    // 关键词完全不匹配 → 分数为 0，不召回
    if (keywordScore === 0) {
      return { memory, score: 0 };
    }

    let score = keywordScore;

    // 新鲜度加分：使用 decay factor（stale 0.5x, expired 0.1x）
    const decay = memoryDecayFactor(memory);
    score *= decay;

    // 置信度加分（用户明确声明的记忆优先）
    score += (memory.confidence || DEFAULT_CONFIDENCE_FALLBACK) * CONFIDENCE_BONUS_WEIGHT;

    // 召回频率加分（经常被召回的记忆更可能有用）
    const recallBonus = Math.min(memory.recallCount || 0, RECALL_BONUS_CAP) / RECALL_BONUS_CAP;
    score += recallBonus * RECALL_BONUS_WEIGHT;

    // v4: 时间范围加权（范围内记忆 score ×1.5）
    if (timeRange) {
      score *= computeTimeBoost(memory, timeRange);
    }

    // 预取命中加分（预取器提前识别的相关记忆）
    if (prefetchedPaths.has(memory.filePath)) {
      score += PREFETCH_HIT_BONUS;
    }

    // 话题切换时按记忆类型调整权重
    if (topicSwitched && score > 0 && memory.type) {
      const weights = DEFAULT_RECALL_CONFIG.topicSwitchWeight;
      const typeWeight = weights[memory.type] ?? 1.0;
      score *= typeWeight;
    }

    return { memory, score };
  });

  const coarseResults = scored
    .filter(item => item.score > scoreFilterThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, COARSE_LIMIT);

  // 如果粗筛结果不超过 maxResults，直接返回（无需精读）
  if (coarseResults.length <= maxResults) {
    return coarseResults.map(item => item.memory);
  }

  // ── 第二阶段：精读正文，二次评分 ──
  return refineWithFullContent(queryTokens, coarseResults, maxResults, idfMap);
}

/**
 * 精读正文二次评分。
 *
 * 同步读取 contentPreview（已在 MemoryHeader 中），
 * 对粗筛候选做更精确的 TF-IDF 加权匹配排序。
 *
 * 注意：这里用 contentPreview（300 字符）而非读取完整文件，
 * 因为 scanMemoryFiles 已经提取了 preview，无需额外 I/O。
 *
 * v5: 使用 IDF 加权，稀有 token 命中贡献更大。
 */
function refineWithFullContent(
  queryTokens: Set<string>,
  candidates: Array<{ memory: MemoryHeader; score: number }>,
  maxResults: number,
  idfMap: Map<string, number> = new Map(),
): MemoryHeader[] {
  const refined = candidates.map(({ memory, score }) => {
    const previewTokens = tokenize(memory.contentPreview ?? '');
    let weightedHits = 0;
    let totalWeight = 0;
    for (const token of queryTokens) {
      const idf = idfMap.get(token) ?? 1.0;
      totalWeight += idf;
      if (previewTokens.has(token)) weightedHits += idf;
    }
    // 正文匹配加分（最多 0.3）
    const contentBonus = totalWeight > 0
      ? (weightedHits / totalWeight) * CONTENT_BONUS_MAX
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
 *
 * v6: 批量延迟写入 — 内存计数器 + 30 秒定时 flush。
 * 避免每次召回都对每个文件做 readFile + writeFile。
 */
/** 内存中的待更新计数器 */
const pendingUpdates = new Map<string, { count: number; lastRecalledAt: string }>();

/** flush 定时器 */
let flushTimer: ReturnType<typeof setInterval> | null = null;

/** 启动 flush 定时器（懒启动） */
function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushRecallMetadata().catch(() => {});
  }, RECALL_FLUSH_INTERVAL_MS);
  // 允许进程正常退出（不阻塞）
  if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
    flushTimer.unref();
  }
}

/** 将内存中的召回计数批量写入文件 */
async function flushRecallMetadata(): Promise<void> {
  if (pendingUpdates.size === 0) return;

  // 取出所有待更新条目
  const updates = new Map(pendingUpdates);
  pendingUpdates.clear();

  for (const [filePath, { count, lastRecalledAt }] of updates) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');

      let updated = content;
      if (updated.includes('recallCount:')) {
        // 读取当前值并加上增量
        const currentMatch = updated.match(/recallCount:\s*(\d+)/);
        const currentCount = currentMatch ? parseInt(currentMatch[1], 10) : 0;
        updated = updated.replace(/recallCount:\s*\d+/, `recallCount: ${currentCount + count}`);
      } else {
        const fmEnd = updated.indexOf('---', updated.indexOf('---') + 3);
        if (fmEnd > 0) {
          updated = updated.slice(0, fmEnd) + `recallCount: ${count}\n` + updated.slice(fmEnd);
        }
      }
      if (updated.includes('lastRecalledAt:')) {
        updated = updated.replace(/lastRecalledAt:\s*\S+/, `lastRecalledAt: ${lastRecalledAt}`);
      } else {
        const fmEnd = updated.indexOf('---', updated.indexOf('---') + 3);
        if (fmEnd > 0) {
          updated = updated.slice(0, fmEnd) + `lastRecalledAt: ${lastRecalledAt}\n` + updated.slice(fmEnd);
        }
      }

      if (updated !== content) {
        await fs.writeFile(filePath, updated, 'utf-8');
      }
    } catch {
      // 更新失败不阻塞
    }
  }
}

/** 记录召回计数到内存（不立即写文件） */
function updateRecallMetadata(memories: MemoryHeader[]): Promise<void> {
  const now = new Date().toISOString();
  for (const mem of memories) {
    const existing = pendingUpdates.get(mem.filePath);
    if (existing) {
      existing.count += 1;
      existing.lastRecalledAt = now;
    } else {
      pendingUpdates.set(mem.filePath, { count: 1, lastRecalledAt: now });
    }
  }
  // 启动定时器
  ensureFlushTimer();
  // 立即返回，不等待 flush
  return Promise.resolve();
}

/**
 * 强制刷新所有待写入的召回计数（用于优雅关闭时调用）。
 */
export async function drainRecallMetadata(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushRecallMetadata();
}

// ─── v3: 关联扩展 ───

/**
 * 关联扩展：从选中文件的 tags 相似度中发现关联文件。
 *
 * 使用 tags Jaccard 系数计算隐式关联，纯代码计算，无需 LLM 提取。
 *
 * 只扩展 1 跳，不递归。最多扩展 MAX_RELATED_EXPAND 个文件。
 */
export function expandRelatedMemories(
  selected: MemoryHeader[],
  allMemories: MemoryHeader[],
  alreadySurfaced: Set<string>,
  maxExpand: number = MAX_RELATED_EXPAND,
): MemoryHeader[] {
  const selectedPaths = new Set(selected.map(m => m.filePath));

  // 候选集：按 tags Jaccard 分数排序
  const candidates = new Map<string, { mem: MemoryHeader; score: number }>();

  // ── 隐式关联（tags Jaccard >= 0.2）──
  for (const candidate of allMemories) {
    if (selectedPaths.has(candidate.filePath)) continue;
    if (alreadySurfaced.has(candidate.filePath)) continue;
    if (!candidate.tags || candidate.tags.length === 0) continue;

    // 计算与所有选中文件的最大 tags Jaccard
    let maxJaccard = 0;
    for (const sel of selected) {
      if (!sel.tags || sel.tags.length === 0) continue;
      const jaccard = computeTagJaccard(sel.tags, candidate.tags);
      if (jaccard > maxJaccard) maxJaccard = jaccard;
    }

    if (maxJaccard >= TAGS_JACCARD_THRESHOLD) {
      candidates.set(candidate.filePath, { mem: candidate, score: maxJaccard });
    }
  }

  // 按分数降序排列，取前 maxExpand 个
  const sorted = Array.from(candidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxExpand);

  if (sorted.length > 0) {
    console.debug(
      `[memory-recall] Relation expansion: +${sorted.length} files (tags-based)`,
    );
  }

  return sorted.map(s => s.mem);
}

/**
 * 计算两组 tags 的 Jaccard 系数。
 */
function computeTagJaccard(tagsA: string[], tagsB: string[]): number {
  const setA = new Set(tagsA.map(t => t.trim().toLowerCase()));
  const setB = new Set(tagsB.map(t => t.trim().toLowerCase()));
  let intersection = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ─── v2: Fact Key Expansion 辅助函数 ───

/**
 * 格式化带 Fact ID 的 manifest（v7 — 用于合并 LLM 调用）。
 *
 * 每条 fact 标注唯一 ID（如 F1、F2），LLM 可以直接引用 fact ID。
 * 返回 manifest 文本和 fact ID → FactEntry 的映射。
 *
 * 格式示例：
 * - [user] user_role.md (2026-04-29T...): 用户的角色和职责 [event: 2026-04-29]
 *   · F1: 用户是前端开发者，偏好 React + TypeScript
 *   · F2: 用户在一家创业公司工作
 *   · F3: 用户习惯使用 Vitest 做测试
 */
function formatManifestWithFactIds(
  memories: MemoryHeader[],
  query: string,
  factIndex: import('./memory-fact-index.js').FactIndex,
): { manifest: string; factIdMap: Map<string, FactEntry> } {
  const factIdMap = new Map<string, FactEntry>();
  let factCounter = 0;
  const lines: string[] = [];

  for (const m of memories) {
    const tag = m.type ? `[${m.type}] ` : '';
    const ts = new Date(m.mtimeMs).toISOString();
    const desc = m.description || '';
    const preview = m.contentPreview
      ? ` | ${m.contentPreview.substring(0, 150)}`
      : '';
    const eventDateStr = m.eventDateMs
      ? ` [event: ${new Date(m.eventDateMs).toISOString().split('T')[0]}]`
      : '';

    // 获取该文件的 ranked facts（带 FactEntry）
    const rankedFacts = factIndex.rankFacts(query, factIndex.getFactsForFile(m.filePath), 5);

    const factLines = rankedFacts.length > 0
      ? '\n' + rankedFacts.map(f => {
          factCounter++;
          const id = `F${factCounter}`;
          factIdMap.set(id, f);
          return `  · ${id}: ${f.factText.substring(0, 120)}`;
        }).join('\n')
      : '';

    const header = desc
      ? `- ${tag}${m.filename} (${ts}): ${desc}${eventDateStr}${preview}`
      : `- ${tag}${m.filename} (${ts})${eventDateStr}${preview}`;
    lines.push(header + factLines);
  }

  return { manifest: lines.join('\n'), factIdMap };
}

/**
 * 格式化带 Fact Key Expansion 的 manifest（旧版，用于回退）。
 *
 * 在每个文件的描述后附加 top-3 facts，帮助 LLM sideQuery
 * 看到更多上下文信息，做出更精确的选择。
 *
 * 格式示例：
 * - [user] user_role.md (2026-04-29T...): 用户的角色和职责
 *   · 用户是前端开发者，偏好 React + TypeScript
 *   · 用户在一家创业公司工作
 *   · 用户习惯使用 Vitest 做测试
 */
function formatManifestWithFacts(
  memories: MemoryHeader[],
  query: string,
  factIndex: import('./memory-fact-index.js').FactIndex,
): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : '';
      const ts = new Date(m.mtimeMs).toISOString();
      const desc = m.description || '';
      const preview = m.contentPreview
        ? ` | ${m.contentPreview.substring(0, 150)}`
        : '';
      // 事件日期标注（帮助 LLM 按时间选择记忆）
      const eventDateStr = m.eventDateMs
        ? ` [event: ${new Date(m.eventDateMs).toISOString().split('T')[0]}]`
        : '';

      // Key Expansion: 附加 top-3 facts
      const topFacts = factIndex.getTopFactsForFile(m.filePath, query, 3);
      const factLines = topFacts.length > 0
        ? '\n' + topFacts.map(f => `  · ${f.substring(0, 100)}`).join('\n')
        : '';

      return desc
        ? `- ${tag}${m.filename} (${ts}): ${desc}${eventDateStr}${preview}${factLines}`
        : `- ${tag}${m.filename} (${ts})${eventDateStr}${preview}${factLines}`;
    })
    .join('\n');
}

/**
 * 从选中的记忆文件中提取并精排 facts。
 *
 * 对选中文件的所有 facts 做关键词匹配精排，
 * 返回按相关性排序的 top-15 facts。
 */
async function extractFactsFromSelected(
  query: string,
  selectedMemories: MemoryHeader[],
  factIndex: import('./memory-fact-index.js').FactIndex,
): Promise<import('./memory-fact-index.js').FactEntry[]> {
  // 收集选中文件的所有 facts（已在 buildIndex 时缓存）
  const selectedPaths = new Set(selectedMemories.map(m => m.filePath));
  // 重新调用 buildIndex 会命中缓存（mtime 未变）
  const allFacts = await factIndex.buildIndex(selectedMemories);
  const relevantFacts = allFacts.filter(f => selectedPaths.has(f.sourceFilePath));

  if (relevantFacts.length === 0) return [];

  // 关键词精排：如果有匹配则按相关性排序，否则返回全部（文件已被选中，facts 本身就是相关的）
  const ranked = factIndex.rankFacts(query, relevantFacts, 15);
  return ranked.length > 0 ? ranked : relevantFacts.slice(0, 15);
}

// ─── 记忆相关性门控（Relevance Gate） ───

/**
 * 从消息列表中提取关键词集合。
 * 合并用户消息和助手消息的文本内容，统一 tokenize。
 */
function extractContextKeywords(messages: UnifiedMessage[], maxMessages: number): Set<string> {
  const recentMessages = messages.slice(-maxMessages);
  const combinedText = recentMessages
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join(' ');
      }
      return '';
    })
    .join(' ');

  return tokenize(combinedText, { minWordLength: 3 });
}

/**
 * Layer 1: 快速关键词重叠过滤（零成本）。
 *
 * 检查记忆的 tags/description/contentPreview 与最近对话的关键词是否重叠。
 * 重叠数 >= minKeywordOverlap 则通过。
 */
function hasKeywordOverlap(
  memory: MemoryHeader,
  contextKeywords: Set<string>,
  minOverlap: number,
): boolean {
  if (contextKeywords.size === 0) return true; // 无上下文关键词时放行

  // 构建记忆的关键词集合：tags + description + contentPreview
  const memoryText = [
    memory.tags.join(' '),
    memory.description || '',
    memory.contentPreview || '',
  ].join(' ');
  const memoryKeywords = tokenize(memoryText, { minWordLength: 3 });

  // 计算交集大小
  let overlap = 0;
  for (const kw of memoryKeywords) {
    if (contextKeywords.has(kw)) {
      overlap++;
      if (overlap >= minOverlap) return true;
    }
  }

  return false;
}

/**
 * Layer 2: LLM 验证（可选，节约 token）。
 *
 * 将记忆的关键词 + 摘要 与最近对话关键词一起发给 LLM，
 * 让 LLM 判断每条记忆是否与当前对话相关。
 * 返回通过验证的记忆索引集合。
 */
async function llmRelevanceCheck(
  memories: MemoryHeader[],
  contextKeywords: Set<string>,
  llmAdapter: LLMAdapterInterface,
  topicSwitched: boolean = false,
): Promise<Set<number>> {
  // 构建上下文摘要（只取关键词，节约 token）
  const contextSnippet = Array.from(contextKeywords).slice(0, 50).join(', ');

  // 构建记忆摘要列表（每条记忆只取 filename + description + top-3 tags）
  const memoryList = memories.map((m, i) => {
    const tags = m.tags.slice(0, 3).join(', ');
    const desc = m.description ? m.description.substring(0, 80) : '';
    return `${i + 1}. [${m.filename}] ${desc} | tags: ${tags}`;
  }).join('\n');

  const topicNote = topicSwitched
    ? `\nNote: The conversation has shifted topics. Prioritize project conventions and technical facts. Only include personal preferences if directly relevant.`
    : '';

  const prompt = `You are checking if recalled memories are relevant to the current conversation.

Conversation keywords: ${contextSnippet}

Recalled memories:
${memoryList}${topicNote}

For each memory, decide if it's relevant to the conversation topic. Return a JSON object with "relevant" as an array of 1-based indices of relevant memories. If none are relevant, return {"relevant": []}.
Return ONLY the JSON object, no other text.`;

  try {
    const response = await llmAdapter.chat(
      [
        { role: 'system', content: 'You are a relevance filter. Return only JSON.' },
        { role: 'user', content: prompt },
      ],
      { tools: [] },
    );

    const content = response.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*"relevant"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const indices: number[] = parsed.relevant || [];
      return new Set(
        indices
          .filter(i => i >= 1 && i <= memories.length)
          .map(i => i - 1),
      );
    }
  } catch (err) {
    console.debug('[memory-recall] LLM relevance check failed:', err instanceof Error ? err.message : err);
  }

  // Fallback: 全部通过
  return new Set(memories.map((_, i) => i));
}

// ─── Rescue 优化：缓存 + 短预览匹配 ───

/** rescue 结果缓存（LRU）：key = 过滤记忆 ID 哈希，value = rescue 后应召回的索引集 */
const rescueCache = new Map<string, Set<number>>();
/** 缓存最大条目数（从配置读取，运行时更新） */
let rescueCacheMaxSize = 20;

/**
 * 计算过滤记忆集的缓存键。
 * 基于排序后的文件名拼接，快速确定性哈希。
 */
function rescueCacheKey(memories: MemoryHeader[]): string {
  const sorted = memories.map(m => m.filename).sort().join('|');
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    hash = ((hash << 5) - hash + sorted.charCodeAt(i)) | 0;
  }
  return `${memories.length}:${Math.abs(hash).toString(36)}`;
}

/**
 * 向 rescue 缓存写入结果（LRU 淘汰）。
 */
function setRescueCache(key: string, indices: Set<number>): void {
  if (rescueCache.size >= rescueCacheMaxSize) {
    // LRU：删除最早的条目
    const firstKey = rescueCache.keys().next().value;
    if (firstKey !== undefined) rescueCache.delete(firstKey);
  }
  rescueCache.set(key, indices);
}

/**
 * 清空 rescue 缓存（manifest 变化时调用）。
 */
export function invalidateRescueCache(): void {
  rescueCache.clear();
}

/**
 * 短预览关键词匹配（替代 LLM rescue）。
 *
 * 当被过滤记忆的 contentPreview 总长度 < 阈值时，
 * 用 token 重叠度（Jaccard 变体）快速判断相关性，
 * 选取得分最高且 > 0.1 的前 2 条。
 *
 * @returns rescue 后应召回的索引集，或 null（应使用 LLM rescue）
 */
function shortPreviewMatch(
  memories: MemoryHeader[],
  contextKeywords: Set<string>,
  previewThreshold: number,
): Set<number> | null {
  if (contextKeywords.size === 0) return null;

  // 计算总预览长度
  const totalPreviewLen = memories.reduce((sum, m) => sum + (m.contentPreview?.length || 0), 0);
  if (totalPreviewLen >= previewThreshold) return null; // 预览太长，交给 LLM

  // 对每条记忆计算 token 重叠度
  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < memories.length; i++) {
    const preview = memories[i].contentPreview || '';
    if (preview.length === 0) continue;

    const previewTokens = tokenize(preview, { minWordLength: 2 });
    let hits = 0;
    for (const token of contextKeywords) {
      if (previewTokens.has(token)) hits++;
    }
    // Jaccard 变体：hits / union
    const union = contextKeywords.size + previewTokens.size - hits;
    const score = union > 0 ? hits / union : 0;
    if (score > 0.1) {
      scored.push({ index: i, score });
    }
  }

  if (scored.length === 0) return null; // 无匹配，交给 LLM

  // 取得分最高的前 2 条
  scored.sort((a, b) => b.score - a.score);
  const result = new Set(scored.slice(0, 2).map(s => s.index));
  console.debug(`[memory-recall] Short preview match: ${result.size}/${memories.length} rescued (skipping LLM)`);
  return result;
}

/**
 * 记忆相关性门控（两层过滤）。
 *
 * 在召回记忆注入上下文之前，检查每条记忆是否与最近对话相关。
 * 解决问题：无关记忆（如 vitest 配置）被注入到无关任务中，干扰 agent。
 *
 * Layer 1: 快速关键词重叠（零成本，过滤明显无关的记忆）
 * Layer 2: LLM 验证（自动触发：当 Layer 1 通过率低于 rescueThreshold 时）
 *
 * @param memories - 召回的记忆列表
 * @param recentMessages - 最近的对话消息（用于构建上下文）
 * @param llmAdapter - LLM 适配器（rescue 时需要）
 * @param config - 门控配置
 * @returns 通过门控的记忆列表
 */
export async function filterByContextRelevance(
  memories: MemoryHeader[],
  recentMessages: UnifiedMessage[],
  llmAdapter: LLMAdapterInterface | null,
  config: Partial<RelevanceGateConfig> = {},
  topicSwitched: boolean = false,
): Promise<MemoryHeader[]> {
  if (memories.length === 0) return [];

  const cfg = { ...DEFAULT_RELEVANCE_GATE_CONFIG, ...config };
  if (!cfg.enabled) return memories;

  // 提取上下文关键词
  const contextKeywords = extractContextKeywords(recentMessages, cfg.contextWindow);

  // Layer 1: 快速关键词重叠过滤
  const layer1Passed: MemoryHeader[] = [];
  const layer1Failed: MemoryHeader[] = [];

  for (const memory of memories) {
    if (hasKeywordOverlap(memory, contextKeywords, cfg.minKeywordOverlap)) {
      layer1Passed.push(memory);
    } else {
      layer1Failed.push(memory);
    }
  }

  const passRate = layer1Passed.length / memories.length;

  // 通过率足够高 → 直接返回，不浪费 LLM token
  if (passRate >= cfg.rescueThreshold) {
    console.debug(`[memory-recall] Relevance gate: ${layer1Passed.length}/${memories.length} passed (${(passRate * 100).toFixed(0)}%)`);
    return layer1Passed;
  }

  // 通过率太低 → rescue（缓存 > 短预览匹配 > LLM）
  rescueCacheMaxSize = cfg.rescueCacheSize || 20;

  // 1. 检查 rescue 缓存
  const cacheKey = rescueCacheKey(layer1Failed);
  let layer2Indices = rescueCache.get(cacheKey);

  if (layer2Indices) {
    console.debug(`[memory-recall] Relevance gate: rescue cache hit`);
  } else {
    // 2. 短预览关键词匹配（避免 LLM 调用）
    const previewMatch = shortPreviewMatch(
      layer1Failed, contextKeywords, cfg.rescueShortPreviewThreshold || 500,
    );

    if (previewMatch) {
      layer2Indices = previewMatch;
      setRescueCache(cacheKey, layer2Indices);
    } else {
      // 3. LLM rescue（兜底）
      if (!llmAdapter) {
        console.debug(`[memory-recall] Relevance gate: ${layer1Passed.length}/${memories.length} passed, no LLM for rescue`);
        return layer1Passed;
      }
      console.debug(`[memory-recall] Relevance gate: ${layer1Passed.length}/${memories.length} passed (${(passRate * 100).toFixed(0)}%), triggering LLM rescue`);
      layer2Indices = await llmRelevanceCheck(layer1Failed, contextKeywords, llmAdapter, topicSwitched);
      setRescueCache(cacheKey, layer2Indices);
    }
  }

  const rescued = layer1Failed.filter((_, i) => layer2Indices!.has(i));

  const result = [...layer1Passed, ...rescued];
  console.debug(`[memory-recall] Relevance gate: ${layer1Passed.length} keyword + ${rescued.length} rescued = ${result.length}/${memories.length}`);
  return result;
}

// ─── 上下文预算过滤 ───

/**
 * 估算文本的 token 数（1 token ≈ 4 字符）。
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 记忆预算条目（带权重和预估 token 数）。
 */
export interface BudgetItem {
  memory: MemoryHeader;
  weight: number;
  estimatedTokens: number;
}

/**
 * 记忆预算过滤结果。
 */
export interface BudgetFilterResult {
  /** 过滤后的记忆列表 */
  filtered: MemoryHeader[];
  /** 被跳过的记忆数（超预算） */
  skippedCount: number;
  /** 被截断为摘要的记忆文件名 */
  truncatedFiles: string[];
}

/**
 * 计算 recencyScore（新鲜度分数）。
 * 基于 memory-age 的衰减状态：fresh=1.0, stale=0.6, expired=0.3。
 */
function recencyScore(memory: MemoryHeader): number {
  const daysSinceActive = Math.max(0, (Date.now() - Math.max(memory.lastRecalledMs || 0, memory.mtimeMs)) / 86_400_000);
  if (daysSinceActive >= EXPIRED_THRESHOLD_DAYS) return 0.3;
  if (daysSinceActive >= STALE_THRESHOLD_DAYS) return 0.6;
  return 1.0;
}

/**
 * 按上下文预算过滤记忆列表。
 *
 * 按 weight = confidence * recencyScore 降序排序，
 * 逐条累加 token 数直到预算上限，但至少保留 minResults 条。
 *
 * @param memories - 候选记忆列表
 * @param budgetTokens - 可用于记忆注入的 token 预算
 * @param minResults - 至少保留的记忆数（默认 3）
 * @returns 过滤结果
 */
export function filterByBudget(
  memories: MemoryHeader[],
  budgetTokens: number,
  minResults: number = 3,
): BudgetFilterResult {
  if (memories.length === 0) {
    return { filtered: [], skippedCount: 0, truncatedFiles: [] };
  }

  // 按权重排序：confidence * recencyScore
  const scored = memories.map(m => ({
    memory: m,
    weight: (m.confidence || DEFAULT_CONFIDENCE_FALLBACK) * recencyScore(m),
    estimatedTokens: estimateTokenCount(m.contentPreview || m.description || ''),
  }));
  scored.sort((a, b) => b.weight - a.weight);

  const filtered: MemoryHeader[] = [];
  const truncatedFiles: string[] = [];
  let usedTokens = 0;

  for (const item of scored) {
    // 至少保留 minResults 条（无条件加入）
    if (filtered.length < minResults) {
      filtered.push(item.memory);
      usedTokens += item.estimatedTokens;
      continue;
    }

    // 预算检查
    if (usedTokens + item.estimatedTokens <= budgetTokens) {
      filtered.push(item.memory);
      usedTokens += item.estimatedTokens;
    } else {
      // 超预算：尝试用 contentPreview 替代（约 75 tokens = 300 chars / 4）
      const previewTokens = estimateTokenCount(item.memory.contentPreview || '');
      if (previewTokens > 0 && usedTokens + previewTokens <= budgetTokens) {
        filtered.push(item.memory);
        usedTokens += previewTokens;
        truncatedFiles.push(item.memory.filename);
      }
      // 否则跳过
    }
  }

  const skippedCount = memories.length - filtered.length;
  if (skippedCount > 0) {
    console.debug(`[memory-recall] Budget filter: ${memories.length} → ${filtered.length} (${skippedCount} skipped, ${truncatedFiles.length} truncated, budget=${budgetTokens} tokens)`);
  }

  return { filtered, skippedCount, truncatedFiles };
}
