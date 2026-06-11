/**
 * LLM 驱动的记忆自动提取。
 *
 * 维度细则见仓库 `docs/记忆系统调整.md`（运行时读入并注入提示词，避免代码内重复长文）。
 *
 * 支持 prompt cache 优化：接收主对话的消息历史前缀，
 * 只在末尾追加提取指令，共享 prompt cache 降低成本。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LLMAdapterInterface, UnifiedMessage } from '../../llm/types.js';
import { formatMemoryManifest } from './memory-scanner.js';
import { getScannerCache } from './memory-scanner-cache.js';
import type { MemoryHeader } from './types.js';
import { validatePath, PathTraversalError } from './memory-security.js';
import { parseLLMJsonArray } from './json-parser.js';
import { scanForSecrets, redactSecrets } from './memory-secret-scanner.js';
import {
  DEFAULT_DREAM_CONFIG,
  DEFAULT_LLM_EXTRACTION_CONFIG,
  USER_LEVEL_CONFIDENCE_THRESHOLD,
  DEFAULT_CONFIDENCE_FALLBACK,
  MIN_EXTRACTION_CONFIDENCE,
  INFERRED_PREFERENCE_MIN_CONFIDENCE,
  resolveUserMemoryEvictedDir,
} from './memory-config.js';
import { evictIfNeeded } from './memory-eviction.js';
import { upsertIndexRow } from './memory-index-maintainer.js';
import { checkExtractDedupSync } from './memory-dedup.js';

/** 消息内容截断字符数 */
const EXTRACTION_MESSAGE_TRUNCATE = 2000;
/** Tags Jaccard 阈值（去重） */
const TAGS_JACCARD_DEDUP_THRESHOLD = 0.6;

/** 提取维度全文来源（相对 `process.cwd()`） */
const MEMORY_DIMENSION_DOC_RELATIVE = 'docs/记忆系统调整.md';
/** 防止异常大文件撑爆上下文 */
const MEMORY_DIMENSION_DOC_MAX_CHARS = 12_000;

/** 文档缺失时的极简维度摘要（npm 包等无 docs 场景） */
const FALLBACK_DIMENSION_BLURB = `User: stack, role, comms, rhythm, naming/code style, tests, git, docs, security, output, cost.
Project: goals, arch, deps, dirs, build/deploy, tests, review, services, env names, commands (user-stated or non-obvious intent only).
Feedback: corrections, confirmations, workflow, priority, interrupt/resume.
Map memoryCategory: habit|hobby|recurring_mistake|stable_preference|explicit_rule|project_convention.`;

/**
 * 允许写入长期记忆的「类别」——与 habits / hobbies / 常犯错误 / 稳定偏好 对齐。
 * 其它类别一律丢弃（宁可少记，不可垃圾进库）。
 */
export const ALLOWED_MEMORY_CATEGORIES = new Set([
  'habit',
  'hobby',
  'recurring_mistake',
  'stable_preference',
  'explicit_rule',
  /** 仓库级、且难以从代码一眼读出的约定（少用） */
  'project_convention',
]);

/** 典型垃圾文件名片段（历史重复/元对话），与 white-list 无关，直接拒绝落盘 */
const REJECT_FILENAME_SUBSTRINGS = [
  'model_identity',
  'identity_inquiry',
  'identity_query',
  'identity_question',
  'current_model_identity',
  'user_model_identity',
  'who_are_you',
  'knowledge_cutoff',
  'current-state',
  'current_state',
];

/** 安装进度快照文件名（含日期且像状态/进度快照） */
const REJECT_PROGRESS_SNAPSHOT_FILENAME_RE =
  /(?:current[-_]?state|snapshot|progress|install[-_]?log).*\d{4}[-_]\d{2}[-_]\d{2}|\d{4}[-_]\d{2}[-_]\d{2}.*(?:current[-_]?state|snapshot|progress)/i;

const INSTALL_PROGRESS_CONTENT_RE = /(?:安装到第|step\s*\d+\s*\/\s*\d+|正在下载|download(?:ing)?\s+\d+%|解压中|extracting)/i;

const COMMAND_LIST_PROJECT_RE = /^(?:[-*]\s*(?:npm|pnpm|yarn|npx|docker|mysql|curl|wget|apt|brew)\b[^\n]*\n?){3,}/im;

/**
 * `type` 与 memoryCategory 须一致，避免 LLM 乱标产生垃圾条目。
 * - project ↔ project_convention
 * - project_convention 仅允许 project（或极罕 reference 指针，保守为仅 project）
 */
function isTypeCategoryCoherent(type: string, memoryCategory: string): boolean {
  if (memoryCategory === 'project_convention') {
    return type === 'project';
  }
  if (type === 'project') {
    return memoryCategory === 'project_convention';
  }
  return true;
}

export function isAllowedMemoryCategory(cat: unknown): boolean {
  if (typeof cat !== 'string') return false;
  return ALLOWED_MEMORY_CATEGORIES.has(cat.trim().toLowerCase());
}

function shouldRejectFilenameForExtraction(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (REJECT_FILENAME_SUBSTRINGS.some(s => lower.includes(s.toLowerCase()))) {
    return true;
  }
  if (REJECT_PROGRESS_SNAPSHOT_FILENAME_RE.test(filename)) {
    return true;
  }
  return false;
}

export interface ExtractedMemoryCandidate {
  memoryCategory: string;
  filename: string;
  type: string;
  name: string;
  description: string;
  content: string;
  confidence?: number;
}

/**
 * 写盘前二次拒绝（REQ-E5）：进度快照、纯命令列表型 project、低置信推断偏好。
 */
export function shouldRejectExtractedMemory(memory: ExtractedMemoryCandidate): string | null {
  if (shouldRejectFilenameForExtraction(memory.filename)) {
    return 'filename_pattern';
  }
  const body = `${memory.content}\n${memory.description}`;
  if (INSTALL_PROGRESS_CONTENT_RE.test(body)) {
    return 'install_progress_snapshot';
  }
  if (memory.type === 'project' && COMMAND_LIST_PROJECT_RE.test(memory.content.trim())) {
    return 'command_list_project';
  }
  const conf = parseMemoryConfidence(memory.confidence);
  if (
    memory.type === 'user'
    && conf !== null
    && conf < INFERRED_PREFERENCE_MIN_CONFIDENCE
    && conf < USER_LEVEL_CONFIDENCE_THRESHOLD
  ) {
    return 'inferred_preference_low_confidence';
  }
  return null;
}

function parseMemoryConfidence(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw));
}

export function meetsExtractionConfidenceThreshold(confidence: unknown): boolean {
  const parsed = parseMemoryConfidence(confidence);
  return parsed !== null && parsed >= MIN_EXTRACTION_CONFIDENCE;
}

/**
 * 读取 `docs/记忆系统调整.md` 注入提取提示；失败或无文件时用极短 fallback。
 */
async function loadMemoryDimensionDocBlock(): Promise<string> {
  const rel = process.env.ICE_MEMORY_DIMENSION_DOC?.trim() || MEMORY_DIMENSION_DOC_RELATIVE;
  const abs = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
  try {
    let raw = (await fs.readFile(abs, 'utf-8')).trim();
    if (!raw) {
      return `\n## Dimension taxonomy (empty file — fallback)\n${FALLBACK_DIMENSION_BLURB}\n`;
    }
    if (raw.length > MEMORY_DIMENSION_DOC_MAX_CHARS) {
      raw = raw.slice(0, MEMORY_DIMENSION_DOC_MAX_CHARS)
        + `\n\n…[truncated at ${MEMORY_DIMENSION_DOC_MAX_CHARS} chars]\n`;
    }
    return `\n## Dimension taxonomy — \`${rel}\` (\`${abs}\`)\n\n${raw}\n`;
  } catch {
    return `\n## Dimension taxonomy (file missing — fallback)\n\n${FALLBACK_DIMENSION_BLURB}\n`;
  }
}

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
 * 精简指令：维度表从 `docs/记忆系统调整.md` 运行时拼接，见 `loadMemoryDimensionDocBlock`。
 */
const EXTRACTION_CORE_PROMPT = `Memory extraction subagent. Extract only **durable** facts for **future** sessions; **if unsure, return []**.

Long-term memory whitelist (ONLY these three):
1. **User habits** (\`type: user\`) — preferences stated explicitly or repeated across sessions (comms, code, Git, tests). Mentioning mysql/react once is NOT a habit.
2. **Reusable troubleshooting patterns** (\`type: feedback\`) — user corrections/confirmations as workflows ("when X, expect Y"). NOT this session's error stack or install step N.
3. **Project overview** (\`type: project\`, ONE \`*-overview.md\` per project) — goals, architecture, user intent not in README. NOT directory trees, package.json scripts, or install instances (paths/versions/progress).

**Strictly map** to the dimension taxonomy in the next section.

- \`memoryCategory\` (required): \`habit\` | \`hobby\` | \`recurring_mistake\` | \`stable_preference\` | \`explicit_rule\` | \`project_convention\`
- \`type: project\` MUST use \`memoryCategory: project_convention\`.
- Session task progress, install logs, command transcripts → **omit** (session-notes handles those).

**Never**: model identity; one-off task blow-by-blow; ops/install/deploy progress; pure chit-chat; keyword-triggered guesses (docker/mysql/vite mentioned ≠ preference).

**Reusability**: only facts useful across **≥3 future sessions**.

**Confidence**: ≥0.75 = explicit or repeated; 0.6–0.74 = strong inference only; **<0.6 → omit**. Inferred user preferences need ≥0.75 or use \`type: feedback\`.

**contradicts**: existing filename only when user **explicitly** says prior memory is wrong.

**Output**: JSON array only. Each item: memoryCategory, filename, type, name, description, content (<800 chars), tags[], confidence, source \`llm_extract\`, eventDate, contradicts, level, evidenceStrength. Merge same topic into one file.

If nothing qualifies: []
`;

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
      console.debug('[LLMMemoryExtractor] scan memoryDir failed:', err instanceof Error ? err.message : err);
    }

    const dimensionBlock = await loadMemoryDimensionDocBlock();
    const userPayload = this.buildExtractionUserPayload(dimensionBlock, recentMessages, existingManifest);

    // 构建消息列表（支持 prompt cache 优化）
    let messages: UnifiedMessage[];
    let usedPromptCache = false;

    if (this.config.enablePromptCache && conversationPrefix && conversationPrefix.length > 0) {
      messages = [
        ...conversationPrefix,
        { role: 'user', content: `${EXTRACTION_CORE_PROMPT}\n\n${userPayload}` },
      ];
      usedPromptCache = true;
    } else {
      messages = [
        { role: 'system', content: EXTRACTION_CORE_PROMPT },
        { role: 'user', content: userPayload },
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
   * 拼接维度文档 + 去重说明 + 近期对话（不含 EXTRACTION_CORE_PROMPT，避免与 system 重复）。
   */
  private buildExtractionUserPayload(
    dimensionBlock: string,
    recentMessages: UnifiedMessage[],
    existingManifest: string,
  ): string {
    const conversationText = recentMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const content = typeof m.content === 'string' ? m.content : '';
        return `${m.role}: ${content.substring(0, EXTRACTION_MESSAGE_TRUNCATE)}`;
      })
      .join('\n\n');

    return `${dimensionBlock}
## Dedup
- **Manifest** below: UPDATE same topic / filename; do not duplicate.
- **tags**: \`dimension:*\` + semantic tags (\`lang:ts\`等); **memoryCategory** + **confidence** + **source** \`llm_extract\` + **level** + **evidenceStrength**.

## Recent conversation

${conversationText}${existingManifest}

Return JSON array only. Required per object: memoryCategory, filename, type, name, description, content, tags[], confidence, source, eventDate, level, evidenceStrength, contradicts (optional).`;
  }

  /**
   * 解析 LLM 的提取响应。
   */
  private parseExtractionResponse(content: string): Array<{
    memoryCategory: string;
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

    const base = parsed.filter((m: any) => {
      if (!m.filename || !m.type || !m.name || !m.content) return false;
      if (typeof m.description !== 'string' || !m.description.trim()) return false;
      return ['user', 'feedback', 'project', 'reference'].includes(m.type);
    });

    const gated = base.filter((m: any) => {
      if (!isAllowedMemoryCategory(m.memoryCategory)) return false;
      const cat = String(m.memoryCategory).trim().toLowerCase();
      if (!isTypeCategoryCoherent(String(m.type), cat)) return false;
      if (shouldRejectFilenameForExtraction(String(m.filename))) return false;
      if (!meetsExtractionConfidenceThreshold(m.confidence)) return false;
      const rejectReason = shouldRejectExtractedMemory({
        memoryCategory: cat,
        filename: String(m.filename),
        type: String(m.type),
        name: String(m.name),
        description: String(m.description),
        content: String(m.content),
        confidence: m.confidence,
      });
      if (rejectReason) {
        console.debug(`[LLMMemoryExtractor] Rejected ${m.filename}: ${rejectReason}`);
        return false;
      }
      return true;
    });

    return gated
      .map((m: any) => ({
        ...m,
        memoryCategory: String(m.memoryCategory).trim().toLowerCase(),
      }))
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
      memoryCategory: string;
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

        if (!safeFilename.trim() || shouldRejectFilenameForExtraction(safeFilename)) {
          console.debug(`[LLMMemoryExtractor] Rejected filename after sanitize: ${memory.filename} → ${safeFilename}`);
          continue;
        }

        // user 类型 → 用户级目录（跨项目共享）
        const memConfidence = memory.confidence ?? DEFAULT_CONFIDENCE_FALLBACK;
        const isExplicitUser = memory.type === 'user' && memConfidence >= USER_LEVEL_CONFIDENCE_THRESHOLD;
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

        // v4: tags 重叠度硬去重 + Phase 2.1 描述相似度去重
        if (!isUpdate) {
          // 2.1: 描述相似度去重（merge 模式：相似则合并到已有文件）
          const dedupDecision = checkExtractDedupSync(
            existingByDir.get(targetDir) || [],
            { filename: safeFilename, name: memory.name, description: memory.description, type: memory.type, tags: memory.tags },
            0.85,
            'merge',
          );
          if (dedupDecision.wouldMergeInfo) {
            console.log(`[LLMMemoryExtractor] ${dedupDecision.wouldMergeInfo}`);
          }
          if (dedupDecision.shouldUpdate && dedupDecision.existingFile) {
            filePath = dedupDecision.existingFile.filePath;
            isUpdate = true;
          }
        }

        // v4: tags 重叠度硬去重（fallback 优先级低）
        if (!isUpdate && memory.tags && memory.tags.length > 0) {
          const existing = existingByDir.get(targetDir) || [];
          const duplicate = findDuplicateByTags(memory.tags, memory.type, existing);
          if (duplicate) {
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
memoryCategory: ${memory.memoryCategory}
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

        // Phase 1: 写后维护 MEMORY.md 索引
        const indexDir = isExplicitUser ? userMemoryDir : memoryDir;
        await upsertIndexRow(indexDir, {
          filename: path.basename(filePath),
          description: memory.description || memory.name,
          type: memory.type as any,
        }).catch(err => {
          console.debug('[LLMMemoryExtractor] upsertIndexRow failed:', err instanceof Error ? err.message : err);
        });

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
      evictIfNeeded(memoryDir, {
        softLimit: DEFAULT_DREAM_CONFIG.postDreamMemoryCap,
        evictionTarget: DEFAULT_DREAM_CONFIG.postDreamMemoryCap,
      }).catch(err => {
        console.debug('[LLMMemoryExtractor] Eviction check failed:', err instanceof Error ? err.message : err);
      });
      evictIfNeeded(userMemoryDir, {
        evictedDir: resolveUserMemoryEvictedDir(),
        softLimit: DEFAULT_DREAM_CONFIG.userMemoryPostDreamCap,
        evictionTarget: DEFAULT_DREAM_CONFIG.userMemoryPostDreamCap,
      }).catch(err => {
        console.debug('[LLMMemoryExtractor] User memory eviction failed:', err instanceof Error ? err.message : err);
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
