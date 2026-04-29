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
  /** 是否启用 Dream 前备份 */
  enableBackup: boolean;
  /** 备份目录 */
  backupDir: string;
  /** 保留的最大备份数 */
  maxBackups: number;
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
    const parsed = parseLLMJsonObject<any>(response.content);

    // ── Dream 前备份 ──
    if (parsed && this.config.enableBackup) {
      await this.backupBeforeDream(memoryDir, parsed).catch(err => {
        console.warn('[MemoryDream] Backup failed (continuing without backup):', err instanceof Error ? err.message : err);
      });
    }

    const result = await this.executeDreamActions(memoryDir, response.content, parsed);

    return {
      executed: true,
      ...result,
      duration: Date.now() - startTime,
    };
  }

  /**
   * 读取记忆文件内容（按重要性排序）。
   *
   * v5 改进：
   * - 从 50 文件 × 2000 字符 → 80 文件 × 1200 字符（总 token 预算不变，覆盖面 +60%）
   * - 按 evictionScore 升序排列（分数越低越重要），确保高价值记忆优先被整合
   */
  private async readMemoryContents(
    memoryDir: string,
    memories: Array<{ filename: string; filePath: string; mtimeMs: number; confidence: number; recallCount: number; lastRecalledMs: number; type?: string }>,
  ): Promise<string> {
    const DREAM_READ_LIMIT = 80;
    const DREAM_TRUNCATE_CHARS = 1200;

    // 按重要性排序：evictionScore 越低越重要（不该被淘汰 = 应该优先整合）
    const sorted = [...memories].sort((a, b) => {
      const scoreA = this.computeDreamPriority(a);
      const scoreB = this.computeDreamPriority(b);
      return scoreA - scoreB; // 升序：重要的在前
    });

    const parts: string[] = [];

    for (const mem of sorted.slice(0, DREAM_READ_LIMIT)) {
      try {
        const content = await fs.readFile(mem.filePath, 'utf-8');
        const truncated = content.length > DREAM_TRUNCATE_CHARS
          ? content.substring(0, DREAM_TRUNCATE_CHARS) + '\n...[truncated]'
          : content;
        parts.push(`### ${mem.filename}\n\n${truncated}`);
      } catch (err) {
        console.debug(`[MemoryDream] Failed to read ${mem.filename}:`, err instanceof Error ? err.message : err);
      }
    }

    if (memories.length > DREAM_READ_LIMIT) {
      parts.push(`\n> Note: ${memories.length - DREAM_READ_LIMIT} additional memory files were not included (sorted by importance, least important omitted).`);
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * 计算 Dream 读取优先级（越低越重要）。
   * 复用 evictionScore 的逻辑：高置信度、高召回频率、user 类型 → 低分 → 优先读取。
   */
  private computeDreamPriority(mem: { mtimeMs: number; confidence: number; recallCount: number; lastRecalledMs: number; type?: string }): number {
    const lastActiveMs = Math.max(mem.lastRecalledMs || 0, mem.mtimeMs);
    const daysSinceActive = Math.max(0, (Date.now() - lastActiveMs) / 86_400_000);
    const agePenalty = Math.min(daysSinceActive, 365) / 365 * 100;
    const confidenceBonus = (mem.confidence || 0.5) * 30;
    const recallBonus = Math.min(mem.recallCount || 0, 20) / 20 * 20;
    const typeBonus = mem.type === 'user' ? 15 : 0;
    return agePenalty - confidenceBonus - recallBonus - typeBonus;
  }

  /**
   * 解析并执行 Dream 操作。
   */
  private async executeDreamActions(
    memoryDir: string,
    responseContent: string,
    preParsed?: any,
  ): Promise<{ summary: string; filesModified: number; filesDeleted: number }> {
    // 使用预解析的结果或重新解析
    const parsed = preParsed ?? parseLLMJsonObject<any>(responseContent);
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
    const deletedFilenames: string[] = [];
    if (Array.isArray(parsed.file_deletes)) {
      for (const filename of parsed.file_deletes) {
        if (!filename || filename === 'MEMORY.md') continue;
        try {
          const filePath = validatePath(filename, memoryDir);
          await fs.unlink(filePath);
          filesDeleted++;
          deletedFilenames.push(filename);
        } catch (e) {
          if (e instanceof PathTraversalError) {
            console.error(`[MemoryDream] Path security violation: ${e.message}`);
          }
          // 文件不存在等错误静默处理
        }
      }
    }

    // 清理悬空关联：移除其他文件中指向已删除文件的 relatedTo 条目
    if (deletedFilenames.length > 0) {
      await this.cleanDanglingRelations(memoryDir, deletedFilenames);
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

  // ─── 悬空关联清理 ───

  /**
   * 清理悬空关联：扫描记忆目录中所有文件，
   * 移除 frontmatter relatedTo 中指向已删除文件的条目。
   */
  private async cleanDanglingRelations(memoryDir: string, deletedFilenames: string[]): Promise<void> {
    if (deletedFilenames.length === 0) return;
    const deletedSet = new Set(deletedFilenames);

    try {
      const entries = await fs.readdir(memoryDir);
      const mdFiles = entries.filter(f => f.endsWith('.md') && f !== 'MEMORY.md');

      for (const filename of mdFiles) {
        const filePath = path.join(memoryDir, filename);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          if (!content.includes('relatedTo:')) continue;

          // 解析 relatedTo 行
          const match = content.match(/^relatedTo:\s*(.+)$/m);
          if (!match) continue;

          const currentRelated = match[1].split(',').map(s => s.trim()).filter(Boolean);
          const cleaned = currentRelated.filter(r => !deletedSet.has(r));

          if (cleaned.length === currentRelated.length) continue; // 无变化

          const newRelatedLine = `relatedTo: ${cleaned.join(', ')}`;
          const updated = content.replace(/^relatedTo:\s*.+$/m, newRelatedLine);
          await fs.writeFile(filePath, updated, 'utf-8');
        } catch {
          // 单个文件处理失败不阻塞
        }
      }
    } catch {
      // 目录读取失败，静默处理
    }
  }

  // ─── Dream 备份 ───

  /**
   * 在 Dream 执行写入/删除操作之前，备份所有将被影响的文件。
   * 滚动保留 maxBackups 份备份。
   */
  async backupBeforeDream(memoryDir: string, parsed: any): Promise<string | null> {
    if (!this.config.enableBackup) return null;

    const backupDir = this.config.backupDir;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `backup-${timestamp}`);

    // 收集需要备份的文件
    const filesToBackup = new Set<string>();

    // file_writes 中将被覆盖的文件
    if (Array.isArray(parsed.file_writes)) {
      for (const fw of parsed.file_writes) {
        if (fw.filename) filesToBackup.add(fw.filename);
      }
    }

    // file_deletes 中将被删除的文件
    if (Array.isArray(parsed.file_deletes)) {
      for (const filename of parsed.file_deletes) {
        if (filename) filesToBackup.add(filename);
      }
    }

    // new_index 存在时备份 MEMORY.md
    if (parsed.new_index) {
      filesToBackup.add('MEMORY.md');
    }

    if (filesToBackup.size === 0) return null;

    // 创建备份目录
    await fs.mkdir(backupPath, { recursive: true });

    // 复制文件
    const backedUp: Array<{ filename: string; reason: string }> = [];
    for (const filename of filesToBackup) {
      const srcPath = path.join(memoryDir, filename);
      try {
        const content = await fs.readFile(srcPath, 'utf-8');
        const destPath = path.join(backupPath, filename);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, content, 'utf-8');

        const reason = Array.isArray(parsed.file_deletes) && parsed.file_deletes.includes(filename)
          ? 'will_be_deleted'
          : filename === 'MEMORY.md'
            ? 'index_update'
            : 'will_be_overwritten';
        backedUp.push({ filename, reason });
      } catch {
        // 文件不存在（新建而非覆盖），跳过
      }
    }

    if (backedUp.length === 0) {
      // 没有实际备份任何文件，清理空目录
      await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    // 写入 manifest
    const manifest = {
      timestamp: new Date().toISOString(),
      backedUpFiles: backedUp,
      dreamSummary: parsed.summary || '',
      dreamActions: parsed.actions || [],
    };
    await fs.writeFile(
      path.join(backupPath, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    // 清理旧备份
    await this.pruneOldBackups();

    console.log(`[MemoryDream] Backup created: ${path.basename(backupPath)} (${backedUp.length} files)`);
    return backupPath;
  }

  /**
   * 清理旧备份，保留最新的 maxBackups 份。
   */
  private async pruneOldBackups(): Promise<void> {
    try {
      const backupDir = this.config.backupDir;
      const entries = await fs.readdir(backupDir, { withFileTypes: true });
      const backupDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('backup-'))
        .map(e => e.name)
        .sort(); // ISO 时间戳排序 = 时间顺序

      if (backupDirs.length <= this.config.maxBackups) return;

      const toDelete = backupDirs.slice(0, backupDirs.length - this.config.maxBackups);
      for (const dir of toDelete) {
        await fs.rm(path.join(this.config.backupDir, dir), { recursive: true, force: true });
      }
    } catch {
      // 目录不存在等，静默处理
    }
  }

  /**
   * 从备份恢复记忆文件。
   *
   * @param memoryDir - 记忆目录
   * @param backupName - 备份目录名（如 "backup-2026-04-29T08-30-00"），不指定则用最新
   * @returns 恢复的文件数
   */
  async restoreFromBackup(memoryDir: string, backupName?: string): Promise<number> {
    const backupDir = this.config.backupDir;

    let targetBackup: string;
    if (backupName) {
      targetBackup = path.join(backupDir, backupName);
    } else {
      // 找最新的备份
      const entries = await fs.readdir(backupDir, { withFileTypes: true });
      const backupDirs = entries
        .filter(e => e.isDirectory() && e.name.startsWith('backup-'))
        .map(e => e.name)
        .sort();
      if (backupDirs.length === 0) {
        console.log('[MemoryDream] No backups found');
        return 0;
      }
      targetBackup = path.join(backupDir, backupDirs[backupDirs.length - 1]);
    }

    // 读取 manifest
    let manifest: any;
    try {
      const raw = await fs.readFile(path.join(targetBackup, 'manifest.json'), 'utf-8');
      manifest = JSON.parse(raw);
    } catch {
      console.error('[MemoryDream] Failed to read backup manifest');
      return 0;
    }

    // 恢复文件
    let restored = 0;
    for (const entry of manifest.backedUpFiles || []) {
      try {
        const srcPath = path.join(targetBackup, entry.filename);
        const destPath = path.join(memoryDir, entry.filename);
        const content = await fs.readFile(srcPath, 'utf-8');
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, content, 'utf-8');
        restored++;
      } catch {
        console.debug(`[MemoryDream] Failed to restore ${entry.filename}`);
      }
    }

    console.log(`[MemoryDream] Restored ${restored} files from ${path.basename(targetBackup)}`);
    return restored;
  }

  /**
   * 列出可用的备份。
   */
  async listBackups(): Promise<Array<{ name: string; timestamp: string; fileCount: number }>> {
    try {
      const entries = await fs.readdir(this.config.backupDir, { withFileTypes: true });
      const backups: Array<{ name: string; timestamp: string; fileCount: number }> = [];

      for (const e of entries) {
        if (!e.isDirectory() || !e.name.startsWith('backup-')) continue;
        try {
          const manifestPath = path.join(this.config.backupDir, e.name, 'manifest.json');
          const raw = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(raw);
          backups.push({
            name: e.name,
            timestamp: manifest.timestamp || '',
            fileCount: manifest.backedUpFiles?.length || 0,
          });
        } catch {
          backups.push({ name: e.name, timestamp: '', fileCount: 0 });
        }
      }

      return backups.sort((a, b) => b.name.localeCompare(a.name));
    } catch {
      return [];
    }
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
