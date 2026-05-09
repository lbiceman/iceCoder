/**
 * LLM 驱动的记忆自动提取。
 *
 * 替代硬编码正则规则，用 LLM 分析对话内容，
 * 判断什么值得记住并自动写入记忆文件。
 *
 * 支持 prompt cache 优化：接收主对话的消息历史前缀，
 * 只在末尾追加提取指令，共享 prompt cache 降低成本。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LLMAdapterInterface, UnifiedMessage } from '../../llm/types.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scanner.js';
import { getScannerCache } from './memory-scanner-cache.js';
import type { MemoryHeader } from './types.js';
import { validatePath, PathTraversalError } from './memory-security.js';
import { parseLLMJsonArray } from './json-parser.js';
import { scanForSecrets, redactSecrets } from './memory-secret-scanner.js';
import {
  DEFAULT_LLM_EXTRACTION_CONFIG,
  USER_LEVEL_CONFIDENCE_THRESHOLD,
  DEFAULT_CONFIDENCE_FALLBACK,
} from './memory-config.js';

/** 消息内容截断字符数 */
const EXTRACTION_MESSAGE_TRUNCATE = 2000;
/** Tags Jaccard 阈值（去重） */
const TAGS_JACCARD_DEDUP_THRESHOLD = 0.6;
import { evictIfNeeded } from './memory-eviction.js';

/**
 * 提取配置。
 */
export interface LLMExtractionConfig {
  /** 最大提取的记忆数量 */
  maxMemories: number;
  /** 最大 token 预算（输出） */
  maxOutputTokens: number;
  /** 是否启用 prompt cache 优化 */
  enablePromptCache: boolean;
}

/**
 * 矛盾信息。
 */
export interface ContradictionInfo {
  /** 新提取的记忆文件名 */
  newFile: string;
  /** 被矛盾的已有记忆文件名 */
  contradictsFile: string;
  /** 新记忆的简要描述（用于通知用户） */
  newSummary: string;
}

/**
 * 提取结果。
 */
export interface ExtractionResult {
  /** 写入的记忆文件路径 */
  writtenPaths: string[];
  /** 提取耗时（毫秒） */
  duration: number;
  /** 是否传入了 prompt cache 前缀 */
  usedPromptCache: boolean;
  /** 提供商是否真正命中了 prompt cache（基于 API 返回的 cacheReadTokens） */
  cacheActuallyHit: boolean;
  /** 检测到的矛盾列表（需要用户确认后才更新旧记忆） */
  contradictions: ContradictionInfo[];
}

/**
 * 提取 Agent 的系统提示词。
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction subagent. Analyze the conversation and extract durable information worth remembering for future conversations. Be precise: noisy or weak memories are harmful because they can distract future coding tasks.

## Memory types
- user: User's role, goals, preferences, knowledge, habits, preferred programming languages, frameworks, work style, personal details (name, location, family, pets, hobbies)
- feedback: Guidance on how to work — corrections AND confirmations
- project: Ongoing work context not derivable from code/git
- reference: Pointers to external systems/resources

## Evidence threshold
- Explicit "remember this" / "记住" requests should be saved.
- Clear corrections or stable preferences may be saved.
- A single weak signal, temporary debugging detail, or ordinary tool output should NOT become long-term memory.
- If a fact only matters for the current task, prefer leaving it out; session notes can handle temporary state.

## What NOT to save
- Code patterns, architecture, file paths — derivable from reading the project
- Git history, recent changes — git log/blame are authoritative
- Debugging solutions — the fix is in the code
- Tool call details, system prompts, ephemeral task state

## Contradiction detection / 矛盾检测
When extracting, check if the new fact CONTRADICTS an existing memory:
- If the user corrects a previously remembered fact (e.g., "I actually use Python now, not Java"), this is a contradiction
- If the conversation reveals that a previous memory is outdated or wrong, this is a contradiction
- Mark contradicted memories with the "contradicts" field pointing to the existing file

**Important**: Contradictions require user confirmation before updating. Only mark a contradiction when the user EXPLICITLY states the old information is wrong — not when you infer it might be outdated.

## Output format
Return a JSON array of memories to save. Each memory object has:
- "filename": string (e.g., "user_role.md", "feedback_testing.md", "user_preferred_languages.md")
- "type": "user" | "feedback" | "project" | "reference"
- "name": string (short name, include date if time-specific)
- "description": string (one-line description for future relevance matching — be SPECIFIC, include names/dates/key details)
- "content": string (the memory content — include ALL relevant details, not summaries)
- "eventDate": string | null (YYYY-MM-DD format, when this event/fact occurred. null if not time-specific)
- "contradicts": string | null (filename of existing memory that this new fact contradicts. null if no contradiction)
- "level": "hard_rule" | "project_fact" | "preference" | "observation" | "session_state"
- "evidenceStrength": "explicit" | "repeated" | "inferred" | "weak"

If nothing is worth saving, return an empty array: []
Return ONLY valid JSON, no other text.

## CRITICAL COMPLETENESS RULES
1. **Extract EVERY distinct fact.** Each fact = separate memory entry. Do NOT merge unrelated facts.
2. **Preserve ALL list items.** If the conversation mentions 5 countries, extract all 5 — not just the first 2.
3. **Include ALL names, dates, quantities, locations.** These are the most valuable recall anchors.
4. **Capture personal details.** Family members, pets, hobbies, health, relationships, travel — these are frequently asked about.
5. **Capture implicit preferences.** "I usually use..." or "Let's go with X again" = preference for X.
6. **Convert relative dates to absolute dates.** "next Thursday" → "2024-03-07".
7. **Preserve exact quotes when they matter.** Names, technical terms, specific wording.
8. **When in doubt, do not extract.** Prefer fewer high-confidence memories over noisy long-term memory.`;

/**
 * 基于 tags 重叠度查找重复记忆。
 *
 * 同类型 + tags Jaccard 重叠 ≥ 0.6 → 视为重复，应合并到已有文件。
 * 返回重叠度最高的已有记忆，或 null。
 */
function findDuplicateByTags(
  newTags: string[],
  newType: string,
  existing: MemoryHeader[],
): MemoryHeader | null {
  if (newTags.length === 0) return null;

  const newSet = new Set(newTags.map(t => t.trim().toLowerCase()));
  let bestMatch: MemoryHeader | null = null;
  let bestOverlap = 0;

  for (const mem of existing) {
    // 只比较同类型的记忆
    if (mem.type !== newType) continue;
    if (!mem.tags || mem.tags.length === 0) continue;

    const existingSet = new Set(mem.tags.map(t => t.trim().toLowerCase()));

    // Jaccard 系数 = |A ∩ B| / |A ∪ B|
    let intersection = 0;
    for (const tag of newSet) {
      if (existingSet.has(tag)) intersection++;
    }
    const union = newSet.size + existingSet.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;

    if (jaccard >= TAGS_JACCARD_DEDUP_THRESHOLD && jaccard > bestOverlap) {
      bestOverlap = jaccard;
      bestMatch = mem;
    }
  }

  return bestMatch;
}

function normalizeMemoryLevel(raw: unknown, type: string): string {
  if (typeof raw === 'string' && ['hard_rule', 'project_fact', 'preference', 'observation', 'session_state'].includes(raw)) {
    return raw;
  }
  if (type === 'feedback') return 'preference';
  if (type === 'project' || type === 'reference') return 'project_fact';
  return 'observation';
}

function normalizeEvidenceStrength(raw: unknown, confidence: number): string {
  if (typeof raw === 'string' && ['explicit', 'repeated', 'inferred', 'weak'].includes(raw)) {
    return raw;
  }
  if (confidence >= 0.95) return 'explicit';
  if (confidence >= 0.75) return 'repeated';
  if (confidence >= 0.45) return 'inferred';
  return 'weak';
}

/**
 * LLM 驱动的记忆提取器。
 */
export class LLMMemoryExtractor {
  private config: LLMExtractionConfig;

  constructor(config?: Partial<LLMExtractionConfig>) {
    this.config = { ...DEFAULT_LLM_EXTRACTION_CONFIG, ...config };
  }

  /**
   * 从对话中提取记忆。
   *
   * prompt cache 优化：如果提供了 conversationPrefix（主对话的消息历史），
   * 将其作为消息前缀传给 LLM，这样 LLM 提供商可以复用已缓存的 KV cache，
   * 只需计算增量部分的 token。
   *
   * @param recentMessages - 最近的对话消息（用于提取）
   * @param memoryDir - 记忆目录路径
   * @param llmAdapter - LLM 适配器
   * @param conversationPrefix - 主对话的消息历史前缀（用于 prompt cache 优化）
   * @returns 提取结果
   */
  async extract(
    recentMessages: UnifiedMessage[],
    memoryDir: string,
    llmAdapter: LLMAdapterInterface,
    conversationPrefix?: UnifiedMessage[],
  ): Promise<ExtractionResult> {
    const startTime = Date.now();

    // 获取现有记忆清单（避免重复）
    let existingManifest = '';
    try {
      const existing = await getScannerCache().scan(memoryDir, 200);
      if (existing.length > 0) {
        existingManifest = `\n\nExisting memory files (do not duplicate):\n${formatMemoryManifest(existing)}`;
      }
    } catch (err) {
      console.debug('[LLMMemoryExtractor] scanMemoryFiles failed:', err instanceof Error ? err.message : err);
    }

    // 构建提取消息
    const userContent = this.buildExtractionPrompt(recentMessages, existingManifest);

    // 构建消息列表（支持 prompt cache 优化）
    let messages: UnifiedMessage[];
    let usedPromptCache = false;

    if (this.config.enablePromptCache && conversationPrefix && conversationPrefix.length > 0) {
      // prompt cache 优化：复用主对话的消息前缀
      // LLM 提供商（如 Anthropic）会自动检测前缀匹配并复用 KV cache
      messages = [
        ...conversationPrefix,
        { role: 'user', content: userContent },
      ];
      usedPromptCache = true;
    } else {
      messages = [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ];
    }

    try {
      const response = await llmAdapter.chat(messages, {
        maxTokens: this.config.maxOutputTokens,
        temperature: 0,
      });

      // 检测提供商是否真正命中了 prompt cache
      const cacheActuallyHit = (response.usage?.cacheReadTokens ?? 0) > 0;

      const memories = this.parseExtractionResponse(response.content);
      const { writtenPaths, contradictions } = await this.saveMemories(memories, memoryDir);

      return {
        writtenPaths,
        duration: Date.now() - startTime,
        usedPromptCache,
        cacheActuallyHit,
        contradictions,
      };
    } catch (error) {
      console.error('[LLMMemoryExtractor] Extraction failed:', error);
      return {
        writtenPaths: [],
        duration: Date.now() - startTime,
        usedPromptCache,
        cacheActuallyHit: false,
        contradictions: [],
      };
    }
  }

  /**
   * 构建提取提示词。
   * 包含现有记忆清单用于去重，以及结构化去重指令。
   */
  private buildExtractionPrompt(
    recentMessages: UnifiedMessage[],
    existingManifest: string,
  ): string {
    // 只提取 user 和 assistant 消息的文本内容
    const conversationText = recentMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : '';
        return `${m.role}: ${content.substring(0, EXTRACTION_MESSAGE_TRUNCATE)}`;
      })
      .join('\n\n');

    return `${EXTRACTION_SYSTEM_PROMPT}

## Deduplication rules
- Check the existing memory list below CAREFULLY before creating new memories
- If an existing memory covers the same topic, UPDATE it (use the same filename) instead of creating a new one
- For user habits: if "user_preferred_languages.md" exists and user now also uses Go, update that file to add Go
- Include "tags" field for semantic dedup: e.g., ["lang:typescript", "lang:python", "tool:vite"]
- Include "confidence" field: 1.0 for user explicit statements ("I prefer X"), 0.5 for inferred patterns
- Include "source" field: always "llm_extract"
- Include "level": hard_rule only for explicit durable rules; project_fact for technical facts; preference for user preferences; observation for soft facts; session_state only for current-session state that should not become long-term user memory
- Include "evidenceStrength": explicit for direct user statements, repeated for repeated behavior, inferred for model inference, weak for uncertain signals

## Recent conversation to analyze

${conversationText}${existingManifest}

Extract memories worth saving from the conversation above. Return JSON array only.
Each object must have: filename, type, name, description, content, tags (string[]), confidence (number 0-1), source ("llm_extract"), eventDate (string YYYY-MM-DD or null), level, evidenceStrength`;
  }

  /**
   * 解析 LLM 的提取响应。
   */
  private parseExtractionResponse(content: string): Array<{
    filename: string;
    type: string;
    name: string;
    description: string;
    content: string;
    tags?: string[];
    confidence?: number;
    source?: string;
    eventDate?: string | null;
    contradicts?: string | null;
    level?: string;
    evidenceStrength?: string;
  }> {
    // 使用健壮的 JSON 解析器（多层回退策略）
    const parsed = parseLLMJsonArray<any[]>(content);
    if (!parsed) return [];

    return parsed
      .filter(
        (m: any) =>
          m.filename &&
          m.type &&
          m.name &&
          m.content &&
          ['user', 'feedback', 'project', 'reference'].includes(m.type)
      )
      .slice(0, this.config.maxMemories);
  }

  /**
   * 将提取的记忆保存到文件。
   *
   * 去重策略：
   * - 同名文件已存在 → 更新而非新建
   * - tags Jaccard 重叠 ≥ 0.6 → 合并到已有文件
   *
   * 写入路由：
   * - user 类型 + confidence=1（用户明确声明）→ 写入用户级目录（跨项目共享）
   * - user 类型 + confidence<1（LLM 推断）→ 写入项目级目录作为候选，等 Dream 整合确认后提升
   * - 其他类型 → 写入项目级目录
   */
  private async saveMemories(
    memories: Array<{
      filename: string;
      type: string;
      name: string;
      description: string;
      content: string;
      tags?: string[];
      confidence?: number;
      source?: string;
      eventDate?: string | null;
      contradicts?: string | null;
      level?: string;
      evidenceStrength?: string;
    }>,
    memoryDir: string,
  ): Promise<{ writtenPaths: string[]; contradictions: ContradictionInfo[] }> {
    const writtenPaths: string[] = [];
    const contradictions: ContradictionInfo[] = [];
    const userMemoryDir = path.resolve(process.env.ICE_USER_MEMORY_DIR ?? 'data/user-memory');

    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(userMemoryDir, { recursive: true });

    // v4: 预扫描已有记忆，用于 tags 重叠度去重（使用 ScannerCache）
    const scannerCache = getScannerCache();
    const targetDirs = [memoryDir, userMemoryDir];
    const existingByDir = new Map<string, Awaited<ReturnType<typeof scannerCache.scan>>>();
    for (const dir of targetDirs) {
      try {
        existingByDir.set(dir, await scannerCache.scan(dir, 200));
      } catch {
        existingByDir.set(dir, []);
      }
    }

    for (const memory of memories) {
      try {
        // 安全验证文件名
        const safeFilename = memory.filename
          .replace(/[^a-zA-Z0-9_\-.\u4e00-\u9fa5]/g, '_')
          .replace(/\.{2,}/g, '_');

        // 路径安全验证
        // user 类型 + 高置信度（用户明确声明）→ 用户级目录（跨项目共享）
        // user 类型 + 低置信度（LLM 推断）→ 项目级目录（候选，等 Dream 提升）
        // 其他类型 → 项目级目录
        const memConfidence = memory.confidence ?? DEFAULT_CONFIDENCE_FALLBACK;
        const isExplicitUser = memory.type === 'user' && memConfidence >= USER_LEVEL_CONFIDENCE_THRESHOLD;
        const targetDir = isExplicitUser ? userMemoryDir : memoryDir;
        let filePath: string;
        try {
          filePath = validatePath(safeFilename, targetDir);
        } catch (e) {
          if (e instanceof PathTraversalError) {
            console.error(`[LLMMemoryExtractor] Path security violation: ${e.message}`);
            continue;
          }
          throw e;
        }

        // 结构化去重：检查文件是否已存在（同名）
        let isUpdate = false;
        try {
          await fs.access(filePath);
          isUpdate = true;
        } catch { /* 文件不存在，正常创建 */ }

        // v4: tags 重叠度硬去重 — 新文件时检查是否与已有记忆高度重复
        if (!isUpdate && memory.tags && memory.tags.length > 0) {
          const existing = existingByDir.get(targetDir) || [];
          const duplicate = findDuplicateByTags(memory.tags, memory.type, existing);
          if (duplicate) {
            // 重定向到已有文件（合并而非新建）
            console.log(
              `[LLMMemoryExtractor] Tags dedup: "${safeFilename}" → merging into "${duplicate.filename}" (overlap ≥60%)`,
            );
            filePath = duplicate.filePath;
            isUpdate = true;
          }
        }

        // 矛盾检测：LLM 标记了 contradicts 字段 → 记录但不覆盖，等用户确认
        if (memory.contradicts) {
          contradictions.push({
            newFile: safeFilename,
            contradictsFile: memory.contradicts,
            newSummary: memory.description || memory.name,
          });
          console.log(
            `[LLMMemoryExtractor] Contradiction detected: "${safeFilename}" contradicts "${memory.contradicts}" — deferring update`,
          );
          // 仍写入新记忆（作为候选），但不覆盖旧文件
          // 旧文件的更新需要用户确认后由 Dream 或手动完成
        }

        const tags = memory.tags && memory.tags.length > 0 ? memory.tags.join(', ') : '';
        const confidence = memory.confidence ?? DEFAULT_CONFIDENCE_FALLBACK;
        const source = memory.source ?? 'llm_extract';
        const level = normalizeMemoryLevel(memory.level, memory.type);
        const evidenceStrength = normalizeEvidenceStrength(memory.evidenceStrength, confidence);
        const now = new Date().toISOString();

        const eventDateStr = memory.eventDate || '';

        const fileContent = `---
name: ${memory.name}
description: ${memory.description}
type: ${memory.type}
level: ${level}
evidenceStrength: ${evidenceStrength}
source: ${source}
confidence: ${confidence}
tags: ${tags}
eventDate: ${eventDateStr}
createdAt: ${now}
recallCount: 0
---

${memory.content}

---
*${isUpdate ? 'Updated' : 'Extracted'}: ${now}*`;

        // 秘密扫描：检测并脱敏敏感信息
        const secrets = scanForSecrets(fileContent);
        let safeContent = fileContent;
        if (secrets.length > 0) {
          const labels = secrets.map(s => s.label).join(', ');
          console.warn(
            `[LLMMemoryExtractor] Secret detected in memory "${memory.filename}": ${labels}. Redacting.`,
          );
          safeContent = redactSecrets(fileContent);
        }

        await fs.writeFile(filePath, safeContent, 'utf-8');
        writtenPaths.push(filePath);

        if (isUpdate) {
          console.log(`[LLMMemoryExtractor] Updated existing memory: ${path.basename(filePath)}`);
        }
      } catch (error) {
        console.error(`[LLMMemoryExtractor] Failed to save memory ${memory.filename}:`, error);
      }
    }

    // ── 写入完成后检查是否需要淘汰 ──
    if (writtenPaths.length > 0) {
      // 使扫描缓存失效（新文件已写入）
      scannerCache.invalidate(memoryDir);
      scannerCache.invalidate(userMemoryDir);
      evictIfNeeded(memoryDir).catch(err => {
        console.debug('[LLMMemoryExtractor] Eviction check failed:', err instanceof Error ? err.message : err);
      });
    }

    return { writtenPaths, contradictions };
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<LLMExtractionConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * 创建 LLM 记忆提取器实例。
 */
export function createLLMMemoryExtractor(
  config?: Partial<LLMExtractionConfig>,
): LLMMemoryExtractor {
  return new LLMMemoryExtractor(config);
}
