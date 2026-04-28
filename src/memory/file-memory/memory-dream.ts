/**
 * autoDream 记忆整合。
 *
 * 定期运行的"做梦"过程，类似人类睡眠时的记忆整合：
 * 1. Orient — 了解现有记忆
 * 2. Gather — 收集新信号
 * 3. Consolidate — 合并更新（去重、修正过时信息）
 * 4. Prune — 修剪索引（保持 MEMORY.md 在上限内）
 *
 * 触发条件：
 * - 会话数达到阈值（默认每 5 次会话）
 * - 记忆文件数超过阈值（默认 30 个）
 * - 手动触发
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LLMAdapterInterface, UnifiedMessage } from '../../llm/types.js';
import { scanMemoryFiles, formatMemoryManifest } from './memory-scanner.js';
import { validatePath, PathTraversalError } from './memory-security.js';
import { parseLLMJsonObject } from './json-parser.js';
import { DEFAULT_DREAM_CONFIG } from './memory-config.js';
import { ConsolidationLock } from './memory-concurrency.js';
import { getDreamConfig } from './memory-remote-config.js';
import { getExpiredMemories, getStaleMemories } from './memory-age.js';

/**
 * Dream 配置。
 */
export interface DreamConfig {
  /** 触发整合的最小会话间隔 */
  sessionInterval: number;
  /** 触发整合的记忆文件数阈值 */
  fileCountThreshold: number;
  /** MEMORY.md 最大行数 */
  maxIndexLines: number;
  /** MEMORY.md 最大字节数 */
  maxIndexBytes: number;
  /** LLM 最大输出 token */
  maxOutputTokens: number;
}

/**
 * Dream 结果。
 */
export interface DreamResult {
  /** 是否执行了整合 */
  executed: boolean;
  /** 整合摘要 */
  summary: string;
  /** 修改的文件数 */
  filesModified: number;
  /** 删除的文件数 */
  filesDeleted: number;
  /** 耗时（毫秒） */
  duration: number;
}

/**
 * Dream 整合提示词。
 */
function buildDreamPrompt(memoryDir: string, maxIndexLines: number): string {
  return `# Memory Consolidation (Dream)

You are performing a memory consolidation pass. Review and organize the memory files, AND analyze user behavior patterns to extract user habits.

Memory directory: \`${memoryDir}\`

## Phase 1 — Orient
Review the existing memory files and their content.

## Phase 2 — Consolidate
For each issue found:
- Merge duplicate or near-duplicate memories into one file
- Update memories with outdated information
- Convert relative dates to absolute dates
- Fix contradictions (if two memories disagree, keep the newer one)

## Phase 3 — User Habit Analysis (NEW)
Analyze ALL memory files (especially project and feedback types) to detect user behavior patterns:
- **Programming languages**: Which languages does the user work with most? (e.g., TypeScript, Python, Java)
- **Frameworks & tools**: What frameworks, libraries, build tools does the user prefer?
- **Coding style**: Any patterns in how they write code, name things, structure projects?
- **Work habits**: Do they prefer detailed explanations or concise answers? Do they test first? Do they use specific workflows?
- **Communication style**: What language do they communicate in? Do they prefer formal or casual tone?

If you detect clear patterns that are NOT already captured in existing "user" type memories, create new user memories for them.
If existing user memories need updating (e.g., user now also works with a new language), update them.
Only record patterns with strong evidence (appearing in 3+ memories or conversations). Do not guess.

## Phase 3b — Promote User Candidates
The extractor writes LLM-inferred user memories (confidence < 1) to the PROJECT directory as candidates.
Review these candidate user memories:
- If a candidate's pattern is confirmed by 3+ other memories or feedback → promote it: add it to "file_writes" with "promote_to_user": true
- If a candidate contradicts other evidence → add it to "file_deletes"
- If a candidate is too early to judge → leave it alone

## Phase 4 — Prune Index
Update MEMORY.md to stay under ${maxIndexLines} lines:
- Remove pointers to deleted/merged memories
- Shorten verbose entries (move detail to topic files)
- Add pointers to important memories missing from the index

## Output format
Return a JSON object with:
- "actions": array of actions taken, each with:
  - "type": "merge" | "update" | "delete" | "create" | "index_update" | "user_habit"
  - "files": array of affected filenames
  - "reason": why this action was taken
- "new_index": the complete new MEMORY.md content (string)
- "file_writes": array of files to write, each with:
  - "filename": string (for user habits, use "user_" prefix, e.g., "user_programming_languages.md", "user_work_style.md")
  - "content": string (full file content including frontmatter with type: user)
  - "promote_to_user": boolean (optional, true = write to user-level directory instead of project-level)
- "file_deletes": array of filenames to delete
- "summary": one-paragraph summary of what changed

If nothing needs changing, return: {"actions": [], "new_index": null, "file_writes": [], "file_deletes": [], "summary": "Memories are already well-organized."}

Return ONLY valid JSON.`;
}

/**
 * MemoryDream 记忆整合器。
 */
export class MemoryDream {
  private config: DreamConfig;
  private sessionCount: number = 0;
  private lastDreamTime: number = 0;
  /** 状态持久化文件路径 */
  private stateFilePath: string;
  /** 整合锁 */
  private lock: ConsolidationLock | null = null;

  constructor(config?: Partial<DreamConfig>) {
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
    this.stateFilePath = 'data/memory/dream-state.json';
  }

  /**
   * 记录一次会话完成。自动持久化到文件。
   */
  recordSession(): void {
    this.sessionCount++;
    this.persistState().catch((err) => {
      console.debug('[MemoryDream] persistState after recordSession failed:', err instanceof Error ? err.message : err);
    });
  }

  /**
   * 检查是否应该触发整合。
   * 使用远程配置覆盖本地默认值。
   * 触发条件（任一满足即触发）：
   * 1. 时间间隔 + 会话数都达标
   * 2. 自上次 dream 以来新增了 10+ 个记忆文件
   * 3. 存在过期记忆需要清理
   */
  async shouldDream(memoryDir: string): Promise<boolean> {
    // 从远程配置获取最新阈值
    const remoteCfg = getDreamConfig();
    if (!remoteCfg.enabled) return false;

    // 从文件恢复状态（进程重启后不丢失）
    await this.restoreState();

    // 初始化锁
    if (!this.lock) {
      this.lock = new ConsolidationLock(memoryDir);
    }

    // 扫描记忆文件
    let memories;
    try {
      memories = await scanMemoryFiles(memoryDir, 500);
    } catch (err) {
      console.debug('[MemoryDream] scanMemoryFiles failed:', err instanceof Error ? err.message : err);
      return false;
    }

    // 条件 3：存在过期记忆需要清理（不受时间门控限制）
    const expired = getExpiredMemories(memories);
    if (expired.length >= 3) {
      console.log(`[MemoryDream] ${expired.length} expired memories detected, triggering dream`);
      return true;
    }

    // 时间门控：使用锁文件的 mtime 作为 lastConsolidatedAt
    const lastConsolidatedAt = await this.lock.readLastConsolidatedAt();
    const hoursSince = (Date.now() - lastConsolidatedAt) / 3_600_000;
    const minHours = remoteCfg.minHours || 4; // 降低默认值：24h → 4h
    if (hoursSince < minHours) return false;

    // 条件 1：会话间隔 + 文件数阈值
    const minSessions = remoteCfg.minSessions || this.config.sessionInterval;
    if (this.sessionCount >= minSessions && memories.length >= this.config.fileCountThreshold) {
      return true;
    }

    // 条件 2：自上次 dream 以来新增了较多文件（基于文件创建时间）
    const newFilesSinceDream = memories.filter(m => m.createdMs > lastConsolidatedAt).length;
    if (newFilesSinceDream >= 10) {
      console.log(`[MemoryDream] ${newFilesSinceDream} new files since last dream, triggering`);
      return true;
    }

    return false;
  }

  /**
   * 执行记忆整合（带锁保护）。
   */
  async dream(
    memoryDir: string,
    llmAdapter: LLMAdapterInterface,
    conversationPrefix?: UnifiedMessage[],
  ): Promise<DreamResult> {
    const startTime = Date.now();

    // 初始化锁
    if (!this.lock) {
      this.lock = new ConsolidationLock(memoryDir);
    }

    // 尝试获取锁
    let priorMtime: number | null;
    try {
      priorMtime = await this.lock.tryAcquire();
    } catch (e) {
      console.debug(`[MemoryDream] lock acquire failed: ${e instanceof Error ? e.message : e}`);
      return {
        executed: false,
        summary: 'Failed to acquire consolidation lock.',
        filesModified: 0,
        filesDeleted: 0,
        duration: Date.now() - startTime,
      };
    }

    if (priorMtime === null) {
      return {
        executed: false,
        summary: 'Consolidation lock held by another process.',
        filesModified: 0,
        filesDeleted: 0,
        duration: Date.now() - startTime,
      };
    }

    try {
      const result = await this.executeDream(memoryDir, llmAdapter, conversationPrefix, startTime);

      // 成功：锁的 mtime 已自动更新为 now（写入 PID 时）
      this.lastDreamTime = Date.now();
      this.sessionCount = 0;
      await this.persistState();

      return result;
    } catch (error) {
      // 失败：回滚锁
      await this.lock.rollback(priorMtime);
      console.error('[MemoryDream] Dream failed, lock rolled back:', error);
      return {
        executed: false,
        summary: `Dream failed: ${error instanceof Error ? error.message : String(error)}`,
        filesModified: 0,
        filesDeleted: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 实际执行整合逻辑（锁已获取）。
   */
  private async executeDream(
    memoryDir: string,
    llmAdapter: LLMAdapterInterface,
    conversationPrefix: UnifiedMessage[] | undefined,
    startTime: number,
  ): Promise<DreamResult> {
    // 扫描现有记忆
    const memories = await scanMemoryFiles(memoryDir, 500);
    if (memories.length === 0) {
      return {
        executed: false,
        summary: 'No memories to consolidate.',
        filesModified: 0,
        filesDeleted: 0,
        duration: Date.now() - startTime,
      };
    }

    // 读取所有记忆文件内容
    const memoryContents = await this.readMemoryContents(memoryDir, memories);

    // 分析过期和陈旧记忆
    const expired = getExpiredMemories(memories);
    const stale = getStaleMemories(memories);
    const expiryInfo = expired.length > 0 || stale.length > 0
      ? `\n\n## Expired/Stale memories\n\nExpired (should be deleted or archived):\n${expired.map(m => `- ${m.filename} (last active: ${new Date(Math.max(m.lastRecalledMs || 0, m.mtimeMs)).toISOString()}, confidence: ${m.confidence})`).join('\n') || '(none)'}\n\nStale (consider updating or removing):\n${stale.map(m => `- ${m.filename} (last active: ${new Date(Math.max(m.lastRecalledMs || 0, m.mtimeMs)).toISOString()}, recallCount: ${m.recallCount})`).join('\n') || '(none)'}`
      : '';

    // 读取当前 MEMORY.md
    let currentIndex = '';
    try {
      currentIndex = await fs.readFile(path.join(memoryDir, 'MEMORY.md'), 'utf-8');
    } catch {
      // 索引不存在（正常情况，首次运行）
    }

    // 构建 LLM 请求
    const dreamPrompt = buildDreamPrompt(memoryDir, this.config.maxIndexLines);
    const userContent = `${dreamPrompt}\n\n## Current MEMORY.md\n\n${currentIndex || '(empty)'}\n\n## Memory files\n\n${memoryContents}${expiryInfo}`;

    // 构建消息（支持 prompt cache）
    let messages: UnifiedMessage[];
    if (conversationPrefix && conversationPrefix.length > 0) {
      messages = [
        ...conversationPrefix,
        { role: 'user', content: userContent },
      ];
    } else {
      messages = [
        { role: 'system', content: 'You are a memory consolidation agent. Follow the instructions precisely and return only valid JSON.' },
        { role: 'user', content: userContent },
      ];
    }

    const response = await llmAdapter.chat(messages, {
      maxTokens: this.config.maxOutputTokens,
      temperature: 0,
    });

    // 解析响应并执行操作
    const result = await this.executeDreamActions(memoryDir, response.content);

    return {
      executed: true,
      ...result,
      duration: Date.now() - startTime,
    };
  }

  /**
   * 读取所有记忆文件内容。
   */
  private async readMemoryContents(
    memoryDir: string,
    memories: Array<{ filename: string; filePath: string }>,
  ): Promise<string> {
    const parts: string[] = [];

    for (const mem of memories.slice(0, 50)) { // 限制读取数量
      try {
        const content = await fs.readFile(mem.filePath, 'utf-8');
        // 截断过长的文件
        const truncated = content.length > 2000
          ? content.substring(0, 2000) + '\n...[truncated]'
          : content;
        parts.push(`### ${mem.filename}\n\n${truncated}`);
      } catch (err) {
        console.debug(`[MemoryDream] Failed to read ${mem.filename}:`, err instanceof Error ? err.message : err);
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * 解析并执行 Dream 操作。
   */
  private async executeDreamActions(
    memoryDir: string,
    responseContent: string,
  ): Promise<{ summary: string; filesModified: number; filesDeleted: number }> {
    // 使用健壮的 JSON 解析器
    const parsed = parseLLMJsonObject<any>(responseContent);
    if (!parsed) {
      return { summary: 'Failed to parse dream response.', filesModified: 0, filesDeleted: 0 };
    }

    let filesModified = 0;
    let filesDeleted = 0;

    // 写入文件
    const userMemoryDir = path.resolve(process.env.ICE_USER_MEMORY_DIR ?? 'data/user-memory');
    if (Array.isArray(parsed.file_writes)) {
      for (const fw of parsed.file_writes) {
        if (!fw.filename || !fw.content) continue;
        try {
          // promote_to_user: Dream 确认的用户记忆 → 写入用户级目录
          const writeDir = fw.promote_to_user ? userMemoryDir : memoryDir;
          await fs.mkdir(writeDir, { recursive: true });
          const filePath = validatePath(fw.filename, writeDir);
          await fs.writeFile(filePath, fw.content, 'utf-8');
          filesModified++;

          if (fw.promote_to_user) {
            console.log(`[MemoryDream] Promoted to user-level: ${fw.filename}`);
            // 删除项目级的候选文件（如果存在）
            try {
              const projPath = validatePath(fw.filename, memoryDir);
              await fs.unlink(projPath);
              filesDeleted++;
            } catch { /* 项目级不存在，正常 */ }
          }
        } catch (e) {
          if (e instanceof PathTraversalError) {
            console.error(`[MemoryDream] Path security violation: ${e.message}`);
          } else {
            console.error(`[MemoryDream] Failed to write ${fw.filename}:`, e);
          }
        }
      }
    }

    // 删除文件
    if (Array.isArray(parsed.file_deletes)) {
      for (const filename of parsed.file_deletes) {
        if (!filename || filename === 'MEMORY.md') continue;
        try {
          const filePath = validatePath(filename, memoryDir);
          await fs.unlink(filePath);
          filesDeleted++;
        } catch (e) {
          if (e instanceof PathTraversalError) {
            console.error(`[MemoryDream] Path security violation: ${e.message}`);
          }
          // 文件不存在等错误静默处理
        }
      }
    }

    // 更新索引
    if (parsed.new_index && typeof parsed.new_index === 'string') {
      try {
        const indexPath = path.join(memoryDir, 'MEMORY.md');
        await fs.writeFile(indexPath, parsed.new_index, 'utf-8');
        filesModified++;
      } catch (error) {
        console.error('[MemoryDream] Failed to update MEMORY.md:', error);
      }
    }

    return {
      summary: parsed.summary || 'Dream completed.',
      filesModified,
      filesDeleted,
    };
  }

  /**
   * 强制触发整合（忽略条件检查）。
   */
  async forceDream(
    memoryDir: string,
    llmAdapter: LLMAdapterInterface,
    conversationPrefix?: UnifiedMessage[],
  ): Promise<DreamResult> {
    return this.dream(memoryDir, llmAdapter, conversationPrefix);
  }

  /**
   * 获取当前状态。
   */
  getState(): { sessionCount: number; lastDreamTime: number } {
    return {
      sessionCount: this.sessionCount,
      lastDreamTime: this.lastDreamTime,
    };
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<DreamConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ─── 状态持久化 ───

  /**
   * 将 dream 状态持久化到文件（进程重启后恢复）。
   */
  private async persistState(): Promise<void> {
    try {
      const dir = path.dirname(this.stateFilePath);
      await fs.mkdir(dir, { recursive: true });
      const state = {
        sessionCount: this.sessionCount,
        lastDreamTime: this.lastDreamTime,
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(this.stateFilePath, JSON.stringify(state), 'utf-8');
    } catch (err) {
      console.debug('[MemoryDream] persistState failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * 从文件恢复 dream 状态。
   */
  private async restoreState(): Promise<void> {
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const state = JSON.parse(content);
      if (typeof state.sessionCount === 'number') {
        this.sessionCount = Math.max(this.sessionCount, state.sessionCount);
      }
      if (typeof state.lastDreamTime === 'number') {
        this.lastDreamTime = Math.max(this.lastDreamTime, state.lastDreamTime);
      }
    } catch {
      // 文件不存在或解析失败，使用内存中的值（正常情况）
    }
  }
}

/**
 * 创建 MemoryDream 实例。
 */
export function createMemoryDream(config?: Partial<DreamConfig>): MemoryDream {
  return new MemoryDream(config);
}
