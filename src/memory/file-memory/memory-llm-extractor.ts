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
import type { MemoryHeader } from './types.js';
import { validatePath, PathTraversalError } from './memory-security.js';
import { parseLLMJsonArray } from './json-parser.js';
import { scanForSecrets, redactSecrets } from './memory-secret-scanner.js';
import { DEFAULT_LLM_EXTRACTION_CONFIG } from './memory-config.js';

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
}

/**
 * 提取 Agent 的系统提示词。
 */
const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction subagent. Analyze the conversation and extract information worth remembering for future conversations.

## Memory types
- user: User's role, goals, preferences, knowledge, habits, preferred programming languages, frameworks, work style
- feedback: Guidance on how to work — corrections AND confirmations
- project: Ongoing work context not derivable from code/git
- reference: Pointers to external systems/resources

## User habit detection
Pay special attention to implicit user habits revealed by the conversation:
- If the user consistently writes or asks about a specific language (TypeScript, Python, etc.), record it as a user preference
- If the user prefers certain tools, frameworks, or patterns, record it
- If the user has a communication style preference (language, verbosity, formality), record it
- If the user corrects you in a way that reveals a preference, record it as both feedback AND user habit
- Update existing user memories if new information supplements them (e.g., user now also uses Go in addition to TypeScript)

## What NOT to save
- Code patterns, architecture, file paths — derivable from reading the project
- Git history, recent changes — git log/blame are authoritative
- Debugging solutions — the fix is in the code
- Tool call details, system prompts, ephemeral task state

## Output format
Return a JSON array of memories to save. Each memory object has:
- "filename": string (e.g., "user_role.md", "feedback_testing.md", "user_preferred_languages.md")
- "type": "user" | "feedback" | "project" | "reference"
- "name": string (short name)
- "description": string (one-line description for future relevance matching)
- "content": string (the memory content)

If nothing is worth saving, return an empty array: []
Return ONLY valid JSON, no other text.`;

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

    if (jaccard >= 0.6 && jaccard > bestOverlap) {
      bestOverlap = jaccard;
      bestMatch = mem;
    }
  }

  return bestMatch;
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
      const existing = await scanMemoryFiles(memoryDir, 200);
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
      const writtenPaths = await this.saveMemories(memories, memoryDir);

      return {
        writtenPaths,
        duration: Date.now() - startTime,
        usedPromptCache,
        cacheActuallyHit,
      };
    } catch (error) {
      console.error('[LLMMemoryExtractor] Extraction failed:', error);
      return {
        writtenPaths: [],
        duration: Date.now() - startTime,
        usedPromptCache,
        cacheActuallyHit: false,
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
        return `${m.role}: ${content.substring(0, 2000)}`;
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

## Recent conversation to analyze

${conversationText}${existingManifest}

Extract memories worth saving from the conversation above. Return JSON array only.
Each object must have: filename, type, name, description, content, tags (string[]), confidence (number 0-1), source ("llm_extract")`;
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
   * 包含结构化去重：如果同名文件已存在，更新而非覆盖。
   * 多级路由：user 类型记忆写入用户级目录（跨项目共享）。
   */
  /**
   * 将提取的记忆保存到文件。
   * 包含结构化去重：如果同名文件已存在，更新而非覆盖。
   * 多级路由：user 类型记忆写入用户级目录（跨项目共享）。
   * v4 新增：tags 重叠度硬去重 — 同类型 + tags 重叠 ≥70% 时合并到已有文件。
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
    }>,
    memoryDir: string,
  ): Promise<string[]> {
    const writtenPaths: string[] = [];
    const userMemoryDir = path.resolve(process.env.ICE_USER_MEMORY_DIR ?? 'data/user-memory');

    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(userMemoryDir, { recursive: true });

    // v4: 预扫描已有记忆，用于 tags 重叠度去重
    const targetDirs = [memoryDir, userMemoryDir];
    const existingByDir = new Map<string, Awaited<ReturnType<typeof scanMemoryFiles>>>();
    for (const dir of targetDirs) {
      try {
        existingByDir.set(dir, await scanMemoryFiles(dir, 200));
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
        // user 类型记忆写入用户级目录（跨项目共享），其他写入项目级目录
        const targetDir = memory.type === 'user' ? userMemoryDir : memoryDir;
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

        const tags = memory.tags && memory.tags.length > 0 ? memory.tags.join(', ') : '';
        const confidence = memory.confidence ?? 0.5;
        const source = memory.source ?? 'llm_extract';
        const now = new Date().toISOString();

        const fileContent = `---
name: ${memory.name}
description: ${memory.description}
type: ${memory.type}
source: ${source}
confidence: ${confidence}
tags: ${tags}
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

    return writtenPaths;
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
