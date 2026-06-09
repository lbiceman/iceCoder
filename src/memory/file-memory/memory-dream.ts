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
import {
  DEFAULT_DREAM_CONFIG,
  type DreamConfig,
  resolveUserMemoryDir,
  resolveUserMemoryEvictedDir,
} from './memory-config.js';
import { getRuntimeMemoryAuxPath } from '../../cli/paths.js';
import { computeEvictionScore, evictIfNeeded, type EvictionResult } from './memory-eviction.js';
import { getScannerCache } from './memory-scanner-cache.js';
import type { MemoryHeader } from './types.js';
import {
  ConsolidationLock,
  tryEnterConsolidation,
  exitConsolidation,
} from './memory-concurrency.js';
import { getDreamConfig } from './memory-remote-config.js';
import { getExpiredMemories, getStaleMemories } from './memory-age.js';
import {
  auditMemoryIndexHealth,
  rebuildMemoryIndexFromMemories,
  repairDeadLinksInMemoryIndex,
  type MemoryIndexHealthReport,
} from './memory-index-health.js';
import { removeIndexRows, rebuildIndexIfDrifted } from './memory-index-maintainer.js';
import { isProtectedFromAutoDelete, findMergeCandidates, performRuleMerge } from './memory-dedup.js';

/** Dream 读取文件数上限 */
const DREAM_READ_LIMIT = 80;
/** Dream 每个文件截断字符数 */
const DREAM_TRUNCATE_CHARS = 1200;
/** Dream 新增文件触发阈值 */
const DREAM_NEW_FILES_TRIGGER = 10;
/** Dream 过期记忆触发阈值 */
const DREAM_EXPIRED_TRIGGER = 3;
/** 索引孤儿文件数达到此值且磁盘文件足够多时触发 stale_index */
const INDEX_ORPHAN_TRIGGER = 15;
/** 磁盘文件数达到此值才启用孤儿触发 */
const INDEX_ORPHAN_MIN_ON_DISK = 20;
/** 自动晋升用户级记忆：最低置信度 */
const USER_PROMOTE_MIN_CONFIDENCE = 0.7;
/** 自动晋升用户级记忆：最低召回次数（与置信度二选一达标） */
const USER_PROMOTE_MIN_RECALL = 3;
/** Dream 状态文件路径 */
const DREAM_STATE_FILE_PATH = getRuntimeMemoryAuxPath('dream-state.json');
/** 因 stale_index 跑完 Dream 后，在此时间内不再仅因死链再次触发（避免 LLM 未修好索引时连打） */
const STALE_INDEX_DREAM_COOLDOWN_MS = 12 * 60 * 1000;

/**
 * Dream 触发原因（用于遥测与门控）。
 */
export type DreamTrigger = 'expired' | 'session_and_files' | 'new_files' | 'stale_index' | 'index_drift' | 'over_cap';

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
  /** 淘汰归档的文件数（Dream 完成后按上限移入 evicted/） */
  filesEvicted?: number;
  /** 耗时（毫秒） */
  duration: number;
  /** 跳过原因（executed=false 时记录） */
  skipReason?: string;
}

/**
 * Dream 整合提示词。
 */
function buildDreamPrompt(memoryDir: string, maxIndexLines: number, memoryFileCap: number): string {
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
- Auto-promote (runtime, no LLM): only type:user files named user-*.md or user_*.md without project: tags
- You must promote via JSON: project-scoped names (javastudy-user-*, user-merge-web-*, any project: tag) → file_writes with promote_to_user:true only when truly cross-project
- If a candidate's pattern is confirmed by 3+ other memories or feedback → promote it: add it to "file_writes" with "promote_to_user": true
- If a candidate contradicts other evidence → add it to "file_deletes"
- If a candidate is too early to judge → leave it alone

## Phase 4 — Prune Index (MANDATORY when drift detected)
Update MEMORY.md to stay under ${maxIndexLines} lines:
- Remove pointers to deleted/merged memories
- Shorten verbose entries (move detail to topic files)
- Add pointers to important memories missing from the index
- Use table rows: \`| filename.md | one-line summary |\`

**If the Index Health section shows orphans > 10 OR dead refs > 0, you MUST return a complete \`new_index\` string.** Do not return null for new_index in that case.

After this pass, the runtime may move excess topic memory files (over ~${memoryFileCap} \`.md\` entries, excluding MEMORY.md) to an \`evicted/\` archive using age, low confidence, and low recall — prioritize merging duplicates and removing stale content in your JSON actions; do not delete files solely to hit a number.

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

If the index is healthy (no dead refs, orphans <= 10) and content needs no merge/delete, you may return: {"actions": [], "new_index": null, "file_writes": [], "file_deletes": [], "summary": "Memories are already well-organized."}

Return ONLY valid JSON.`;
}

/**
 * 两阶段 LLM：Index pass prompt（仅输出 new_index）。
 */
function buildIndexPassPrompt(_memoryDir: string, currentIndex: string, indexHealthBlock: string): string {
  return `# Memory Index Rebuild (Index Pass)

You are doing a lightweight index-only pass. Do NOT produce file_writes or file_deletes.

## Index Health
${indexHealthBlock}

## Current MEMORY.md
${currentIndex || '(empty)'}

## Instructions
Rebuild a clean MEMORY.md from the index health report. Remove dead references. Keep only valid entries.
Use table rows: \`| filename.md | one-line summary |\`

Return ONLY: { "new_index": "<full MEMORY.md content>" }`;
}

/**
 * 两阶段 LLM：Content pass prompt（基于已建好的 new_index，做语义合并）。
 */
function buildContentPassPrompt(memoryDir: string, memoryContents: string, expiryInfo: string, newIndex: string | null): string {
  return `# Memory Content Consolidation (Content Pass)

Memory directory: \`${memoryDir}\`

## Key rule
You MUST NOT modify the index unless absolutely necessary (it was already rebuilt). Focus on content merges, updates, and file_writes/file_deletes.

## Existing Index (reference only — do not include in output)
${newIndex || '(not yet rebuilt)'}

## Memory files
${memoryContents}${expiryInfo}

## Instructions
1. Merge duplicate/near-duplicate memories into one file (use file_writes + file_deletes)
2. Update outdated information (file_writes)
3. Delete obsolete memories (file_deletes)
4. Analyze user behavior patterns for new user memories

## Output format
{
  "actions": [{ "type": "merge", "files": ["fileA.md", "fileB.md"], "newFile": "merged.md" }],
  "file_writes": [{ "filename": "...", "content": "...", "promote_to_user": false }],
  "file_deletes": ["old-file.md"],
  "summary": "..."
}`;
}

/**
 * MemoryDream 记忆整合器。
 */
export class MemoryDream {
  private config: DreamConfig;
  private sessionCount: number = 0;
  private lastDreamTime: number = 0;
  /** 最近一次因 MEMORY.md 死链（stale_index）成功跑完 Dream 的时间戳（用于防抖） */
  private staleIndexDreamCompletedAt: number = 0;
  /** 最近一次因索引问题尝试 Dream 失败或 no-op 的时间戳（退避用） */
  private lastIndexDreamAttemptAt: number = 0;
  /** 索引类 Dream 连续失败/空跑次数（指数退避基数） */
  private indexDreamBackoffCount: number = 0;
  /** 状态持久化文件路径 */
  private stateFilePath: string;
  /** 整合锁 */
  private lock: ConsolidationLock | null = null;
  /** 串行化 dream-state 写盘，避免 recordSession 与 Dream 竞态覆盖 */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(config?: Partial<DreamConfig>) {
    this.config = { ...DEFAULT_DREAM_CONFIG, ...config };
    this.stateFilePath = DREAM_STATE_FILE_PATH;
  }

  /**
   * 记录一次会话完成。自动持久化到文件。
   * 写盘前合并磁盘上的 Dream 时间戳，避免其他实例（如手动 Dream）写入的 lastDreamTime 被覆盖。
   */
  async recordSession(): Promise<void> {
    await this.mergePersistedTimestamps();
    this.sessionCount++;
    await this.enqueuePersistState();
  }

  /**
   * 检查是否应该触发整合。
   * 使用远程配置覆盖本地默认值。
   * 触发条件（任一满足即触发）：
   * 1. 时间间隔 + 会话数都达标
   * 2. 自上次 dream 以来新增了 10+ 个记忆文件
   * 3. 存在过期记忆需要清理
   */
  /**
   * 是否应运行 Dream（仅布尔，兼容旧调用方）。
   */
  async shouldDream(memoryDir: string): Promise<boolean> {
    return (await this.evaluateDreamGate(memoryDir)).shouldRun;
  }

  /**
   * Dream 门控 v2：返回是否运行、触发原因、skipReason。
   *
   * 分流量：
   * - expired / over_cap → 直接 LLM
   * - index_drift（纯孤儿、无死链）→ 规则层 rebuild，不调 LLM
   * - stale_index（有死链）→ 先 repair；仍不健康才 LLM（有条件）
   * - session_and_files / new_files → LLM
   * - 退避：索引类门控连续失败/空跑时指数退避 1–30min
   */
  async evaluateDreamGate(memoryDir: string): Promise<{
    shouldRun: boolean;
    trigger: DreamTrigger | null;
    skipReason?: string;
  }> {
    const remoteCfg = getDreamConfig();
    if (!remoteCfg.enabled) return { shouldRun: false, trigger: null, skipReason: 'disabled' };

    await this.restoreState();

    if (!this.lock) {
      this.lock = new ConsolidationLock(memoryDir);
    }

    let memories;
    try {
      memories = await scanMemoryFiles(memoryDir, 500);
    } catch (err) {
      console.debug('[MemoryDream] scanMemoryFiles failed:', err instanceof Error ? err.message : err);
      return { shouldRun: false, trigger: null, skipReason: 'scan_failed' };
    }

    const expired = getExpiredMemories(memories);
    if (expired.length >= DREAM_EXPIRED_TRIGGER) {
      console.log(`[MemoryDream] ${expired.length} expired memories detected, triggering dream`);
      return { shouldRun: true, trigger: 'expired' };
    }

    if (this.config.enforceMemoryCapAfterDream && memories.length > this.config.postDreamMemoryCap) {
      console.log(`[MemoryDream] ${memories.length} memories exceed cap ${this.config.postDreamMemoryCap}, triggering dream before eviction`);
      return { shouldRun: true, trigger: 'over_cap' };
    }

    const indexHealth = await auditMemoryIndexHealth(
      memoryDir,
      memories.map(m => m.filename),
    );

    // Phase 1.7: 按比例判定孤儿飘移（替代固定阈值）
    const orphanRatio = indexHealth.onDisk > 0
      ? indexHealth.orphans / indexHealth.onDisk
      : 0;
    const orphanAbsoluteEnough = indexHealth.orphans >= this.config.indexOrphanMinCount
      && orphanRatio >= this.config.indexOrphanRatioThreshold;
    const indexDrift = orphanAbsoluteEnough && indexHealth.dead === 0;
    const staleIndex = indexHealth.dead >= this.config.staleIndexDeadLinksThreshold || orphanAbsoluteEnough;

    // Phase 1.4: index_drift（纯孤儿、无死链）→ 规则层重建，零 LLM
    if (indexDrift) {
      console.log(
        `[MemoryDream] index_drift: ${indexHealth.orphans} orphans (${Math.round(orphanRatio * 100)}%), 0 dead → rule rebuild, no LLM`,
      );
      try {
        const rebuild = await rebuildIndexIfDrifted(memoryDir, { maxEntries: this.config.maxIndexLines });
        console.log(`[MemoryDream] index_drift rebuilt: ${rebuild.entryCount} entries`);
      } catch (e) {
        console.debug('[MemoryDream] index_drift rebuild failed:', e instanceof Error ? e.message : e);
      }
      this.indexDreamBackoffCount = 0;
      return { shouldRun: false, trigger: null, skipReason: 'index_drift_rule_rebuild' };
    }

    // Phase 1.5: stale_index（有死链）→ 先修复，仍不健康才 LLM
    if (staleIndex) {
      const sinceStaleDream = Date.now() - this.staleIndexDreamCompletedAt;
      const inCooldown = this.staleIndexDreamCompletedAt > 0
        && sinceStaleDream >= 0
        && sinceStaleDream < STALE_INDEX_DREAM_COOLDOWN_MS;

      if (inCooldown) {
        console.debug(
          `[MemoryDream] index unhealthy (dead=${indexHealth.dead}, orphans=${indexHealth.orphans}) but stale_index cooldown active`,
        );
        return { shouldRun: false, trigger: null, skipReason: 'stale_index_cooldown' };
      }

      // Phase 1.6: 退避检查
      const backoffResult = this.checkIndexDreamBackoff();
      if (!backoffResult.ok) {
        console.debug(`[MemoryDream] ${backoffResult.reason}`);
        return { shouldRun: false, trigger: null, skipReason: backoffResult.reason };
      }

      // 先规则修复
      let repairFixed = false;
      try {
        const repair = await repairDeadLinksInMemoryIndex(memoryDir);
        if (repair.removedLinks > 0) {
          console.log(`[MemoryDream] stale_index rule repair: removed ${repair.removedLinks} dead link(s)`);
        }
        // 修复后若死链已清零 → 仅孤儿问题走 rebuild
        const recheck = await auditMemoryIndexHealth(memoryDir, memories.map(m => m.filename));
        if (recheck.dead === 0 && recheck.orphans > 0) {
          const rebuild = await rebuildIndexIfDrifted(memoryDir, { maxEntries: this.config.maxIndexLines });
          console.log(`[MemoryDream] stale_index: repair + rebuild → ${rebuild.entryCount} entries`);
          if (rebuild.wrote && recheck.dead === 0 && recheck.orphans - rebuild.entryCount <= 10) {
            repairFixed = true;
          }
        } else if (recheck.dead === 0 && recheck.orphans === 0) {
          repairFixed = true;
        }
      } catch (e) {
        console.debug('[MemoryDream] stale_index rule repair failed:', e instanceof Error ? e.message : e);
      }

      if (repairFixed) {
        this.indexDreamBackoffCount = 0;
        return { shouldRun: false, trigger: null, skipReason: 'stale_index_rule_repaired' };
      }

      console.log(`[MemoryDream] stale_index: rule repair insufficient (dead=${indexHealth.dead}), triggering LLM dream`);
      this.lastIndexDreamAttemptAt = Date.now();
      return { shouldRun: true, trigger: 'stale_index' };
    }

    const lastConsolidatedAt = await this.lock.readLastConsolidatedAt();
    const hoursSince = (Date.now() - lastConsolidatedAt) / 3_600_000;
    const minHours = remoteCfg.minHours || 4;
    if (hoursSince < minHours) return { shouldRun: false, trigger: null, skipReason: 'time_interval' };

    const minSessions = remoteCfg.minSessions || this.config.sessionInterval;
    if (this.sessionCount >= minSessions && memories.length >= this.config.fileCountThreshold) {
      return { shouldRun: true, trigger: 'session_and_files' };
    }

    const newFilesSinceDream = memories.filter(m => m.createdMs > lastConsolidatedAt).length;
    if (newFilesSinceDream >= DREAM_NEW_FILES_TRIGGER) {
      console.log(`[MemoryDream] ${newFilesSinceDream} new files since last dream, triggering`);
      return { shouldRun: true, trigger: 'new_files' };
    }

    return { shouldRun: false, trigger: null, skipReason: 'no_trigger' };
  }

  /**
   * Phase 1.6: 检查索引类 Dream 是否处于指数退避中。
   * 前 N 次连续失败/空跑后，退避间隔 = min(backoffBaseMs * 2^(N-1), backoffMaxMs)
   */
  private checkIndexDreamBackoff(): { ok: boolean; reason: string } {
    if (this.indexDreamBackoffCount < 1) return { ok: true, reason: '' };
    const sinceLastAttempt = Date.now() - this.lastIndexDreamAttemptAt;
    const backoffMs = Math.min(
      this.config.indexBackoffBaseMs * Math.pow(2, this.indexDreamBackoffCount - 1),
      this.config.indexBackoffMaxMs,
    );
    if (sinceLastAttempt < backoffMs) {
      return {
        ok: false,
        reason: `index_backoff: attempt ${this.indexDreamBackoffCount}, wait ${Math.round((backoffMs - sinceLastAttempt) / 1000)}s more`,
      };
    }
    return { ok: true, reason: '' };
  }

  /**
   * 项目记忆超过上限时仅淘汰（不跑 Dream LLM）。
   */
  async evictProjectMemoryIfOverCap(memoryDir: string): Promise<EvictionResult> {
    if (!this.config.enforceMemoryCapAfterDream) {
      let n = 0;
      try {
        n = (await scanMemoryFiles(memoryDir, 500)).length;
      } catch { /* empty */ }
      return { executed: false, fileCountBefore: n, fileCountAfter: n, evictedFiles: [], summary: 'project cap eviction disabled' };
    }
    const memories = await scanMemoryFiles(memoryDir, 500);
    const cap = this.config.postDreamMemoryCap;
    if (memories.length <= cap) {
      return {
        executed: false,
        fileCountBefore: memories.length,
        fileCountAfter: memories.length,
        evictedFiles: [],
        summary: 'below cap',
      };
    }
    const out = await evictIfNeeded(memoryDir, {
      ...(this.config.afterDreamEviction ?? {}),
      softLimit: cap,
      evictionTarget: cap,
    });
    if (out.executed) getScannerCache().invalidate(memoryDir);
    return out;
  }

  /**
   * 用户级记忆超过上限时仅淘汰。
   */
  async evictUserMemoryIfOverCap(): Promise<EvictionResult> {
    const userDir = resolveUserMemoryDir();
    if (!this.config.enforceUserMemoryCapAfterDream) {
      let n = 0;
      try {
        n = (await scanMemoryFiles(userDir, 500)).length;
      } catch { /* empty */ }
      return { executed: false, fileCountBefore: n, fileCountAfter: n, evictedFiles: [], summary: 'user cap eviction disabled' };
    }
    let memories;
    try {
      memories = await scanMemoryFiles(userDir, 500);
    } catch {
      return { executed: false, fileCountBefore: 0, fileCountAfter: 0, evictedFiles: [], summary: 'user dir unreadable' };
    }
    const cap = this.config.userMemoryPostDreamCap;
    if (memories.length <= cap) {
      return {
        executed: false,
        fileCountBefore: memories.length,
        fileCountAfter: memories.length,
        evictedFiles: [],
        summary: 'below cap',
      };
    }
    const out = await evictIfNeeded(userDir, {
      ...(this.config.afterUserDreamEviction ?? {}),
      softLimit: cap,
      evictionTarget: cap,
      evictedDir: this.config.afterUserDreamEviction?.evictedDir ?? resolveUserMemoryEvictedDir(),
    });
    if (out.executed) getScannerCache().invalidate(userDir);
    return out;
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

    if (!tryEnterConsolidation(memoryDir)) {
      return {
        executed: false,
        summary: 'Consolidation already in progress.',
        filesModified: 0,
        filesDeleted: 0,
        duration: Date.now() - startTime,
        skipReason: 'mutex',
      };
    }

    try {
      return await this.dreamWithLock(memoryDir, llmAdapter, conversationPrefix, startTime);
    } finally {
      exitConsolidation(memoryDir);
    }
  }

  private async dreamWithLock(
    memoryDir: string,
    llmAdapter: LLMAdapterInterface,
    conversationPrefix: UnifiedMessage[] | undefined,
    startTime: number,
  ): Promise<DreamResult> {
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
        skipReason: 'lock_acquire_failed',
      };
    }

    if (priorMtime === null) {
      return {
        executed: false,
        summary: 'Consolidation lock held by another process.',
        filesModified: 0,
        filesDeleted: 0,
        duration: Date.now() - startTime,
        skipReason: 'lock_held',
      };
    }

    try {
      const result = await this.executeDream(memoryDir, llmAdapter, conversationPrefix, startTime);

      // 成功：锁的 mtime 已自动更新为 now（写入 PID 时）
      this.lastDreamTime = Date.now();
      this.sessionCount = 0;
      await this.enqueuePersistState();

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

    const indexHealth = await auditMemoryIndexHealth(
      memoryDir,
      memories.map(m => m.filename),
    );
    const indexHealthBlock = formatIndexHealthForDream(indexHealth);

    // 构建消息辅助
    const buildMessages = (prefix: UnifiedMessage[] | undefined, content: string): UnifiedMessage[] => {
      if (prefix && prefix.length > 0) return [...prefix, { role: 'user', content }];
      return [
        { role: 'system', content: 'You are a memory consolidation agent. Follow the instructions precisely and return only valid JSON.' },
        { role: 'user', content },
      ];
    };

    // 构建 LLM 请求
    const dreamPrompt = buildDreamPrompt(memoryDir, this.config.maxIndexLines, this.config.postDreamMemoryCap);
    const userContent = `${dreamPrompt}\n\n## Index Health\n\n${indexHealthBlock}\n\n## Current MEMORY.md\n\n${currentIndex || '(empty)'}\n\n## Memory files\n\n${memoryContents}${expiryInfo}`;
    const messages = buildMessages(conversationPrefix, userContent);

    // 2.2: 两阶段 LLM（ICE_DREAM_TWO_PHASE=true 时启用 index pass + content pass）
    const twoPhase = this.config.twoPhase && process.env.ICE_DREAM_TWO_PHASE === 'true';
    let parsed: any;
    let responseContent: string;

    if (twoPhase) {
      // Phase A: Index pass — 仅输出 new_index
      const indexPrompt = buildIndexPassPrompt(memoryDir, currentIndex, indexHealthBlock);
      const indexMessages = buildMessages(conversationPrefix, indexPrompt);
      const indexResponse = await llmAdapter.chat(indexMessages, {
        maxTokens: 2048,
        temperature: 0,
      });
      const indexParsed = parseLLMJsonObject<any>(indexResponse.content);
      const newIndex = indexParsed?.new_index || null;

      // Phase B: Content pass — 基于已产生的索引做 file_writes/deletes
      const contentPrompt = buildContentPassPrompt(memoryDir, memoryContents, expiryInfo, newIndex);
      const contentMessages = buildMessages(conversationPrefix, contentPrompt);
      const contentResponse = await llmAdapter.chat(contentMessages, {
        maxTokens: this.config.maxOutputTokens,
        temperature: 0,
      });
      const contentParsed = parseLLMJsonObject<any>(contentResponse.content);
      responseContent = contentResponse.content;

      parsed = { ...contentParsed, new_index: newIndex || contentParsed?.new_index };
    } else {
      const response = await llmAdapter.chat(messages, {
        maxTokens: this.config.maxOutputTokens,
        temperature: 0,
      });
      responseContent = response.content;
      parsed = parseLLMJsonObject<any>(response.content);
    }

    // ── Dream 前备份 ──
    if (parsed && this.config.enableBackup) {
      await this.backupBeforeDream(memoryDir, parsed).catch(err => {
        console.warn('[MemoryDream] Backup failed (continuing without backup):', err instanceof Error ? err.message : err);
      });
    }

    const wroteFullIndex = !!(parsed?.new_index && typeof parsed.new_index === 'string');
    let result = await this.executeDreamActions(memoryDir, responseContent, parsed);

    const promoted = await this.autoPromoteUserCandidates(memoryDir, memories);
    if (promoted > 0) {
      result = {
        ...result,
        filesModified: result.filesModified + promoted,
        summary: `${result.summary} Promoted ${promoted} user memory(ies) to user-level.`,
      };
    }

    // 3.12: 规则重复合并（Dream 后扫相似对，shadow/merge 模式）
    if (process.env.ICE_RULE_MERGE !== 'off') {
      const mergeMode = (process.env.ICE_RULE_MERGE || 'shadow') as 'shadow' | 'merge';
      const candidates = await findMergeCandidates(
        memoryDir,
        0.88, // ruleMergeSimilarityThreshold
      );
      for (const c of candidates) {
        const mr = await performRuleMerge(c, mergeMode);
        if (mr.performed) {
          result.filesModified++;
          result.filesDeleted++;
          getScannerCache().invalidate(memoryDir);
        }
      }
      if (candidates.length > 0 && mergeMode === 'shadow') {
        console.log(`[MemoryDream] rule_merge shadow: ${candidates.length} candidate pairs found`);
      }
    }

    if (!wroteFullIndex && (indexHealth.dead > 0 || indexHealth.orphans > 10)) {
      try {
        const repair = await repairDeadLinksInMemoryIndex(memoryDir);
        if (repair.wrote) {
          result.filesModified++;
          getScannerCache().invalidate(memoryDir);
        }
        const freshMemories = await scanMemoryFiles(memoryDir, 500);
        const rebuilt = await rebuildMemoryIndexFromMemories(memoryDir, freshMemories);
        if (rebuilt.wrote) {
          console.log(`[MemoryDream] Rebuilt MEMORY.md with ${rebuilt.entryCount} entries (LLM omitted new_index)`);
          result.filesModified++;
          getScannerCache().invalidate(memoryDir);
        }
      } catch (e) {
        console.debug('[MemoryDream] index rebuild failed:', e instanceof Error ? e.message : e);
      }
    }

    let filesEvicted = 0;
    if (this.config.enforceMemoryCapAfterDream) {
      const cap = this.config.postDreamMemoryCap;
      const evictOutcome = await evictIfNeeded(memoryDir, {
        ...(this.config.afterDreamEviction ?? {}),
        softLimit: cap,
        evictionTarget: cap,
      });
      filesEvicted += evictOutcome.evictedFiles.length;
      if (evictOutcome.executed) {
        getScannerCache().invalidate(memoryDir);
      }
    }
    if (this.config.enforceUserMemoryCapAfterDream) {
      const userDir = resolveUserMemoryDir();
      const uCap = this.config.userMemoryPostDreamCap;
      const userEvict = await evictIfNeeded(userDir, {
        ...(this.config.afterUserDreamEviction ?? {}),
        softLimit: uCap,
        evictionTarget: uCap,
        evictedDir: this.config.afterUserDreamEviction?.evictedDir ?? resolveUserMemoryEvictedDir(),
      });
      filesEvicted += userEvict.evictedFiles.length;
      if (userEvict.executed) {
        getScannerCache().invalidate(userDir);
      }
    }

    return {
      executed: true,
      ...result,
      filesEvicted,
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
    memories: MemoryHeader[],
  ): Promise<string> {
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
  private computeDreamPriority(mem: MemoryHeader): number {
    return computeEvictionScore(mem);
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

    // 2.3: actions[] 映射器（ICE_DREAM_ACTIONS_EXEC=true 时执行）
    if (process.env.ICE_DREAM_ACTIONS_EXEC === 'true' && Array.isArray(parsed.actions)) {
      for (const action of parsed.actions) {
        if (action.type === 'merge' && Array.isArray(action.filenames) && action.filenames.length >= 2) {
          const [keepFile, ...removeFiles] = action.filenames;
          try {
            const keepPath = validatePath(keepFile, memoryDir);
            let keepContent = await fs.readFile(keepPath, 'utf-8');
            for (const rmFile of removeFiles) {
              try {
                const rmPath = validatePath(rmFile, memoryDir);
                const rmContent = await fs.readFile(rmPath, 'utf-8');
                const rmHeaderEnd = rmContent.indexOf('\n\n');
                const rmBody = rmHeaderEnd > 0 ? rmContent.slice(rmHeaderEnd + 2).trim() : rmContent;
                if (rmBody && !keepContent.includes(rmBody)) {
                  const now = new Date().toISOString();
                  keepContent += `\n\n## Merged from ${rmFile} (${now})\n\n${rmBody}`;
                }
                await fs.unlink(rmPath);
                filesDeleted++;
                console.log(`[MemoryDream] action merge: deleted "${rmFile}" into "${keepFile}"`);
              } catch { /* 源文件不存在，跳过 */ }
            }
            if (!keepContent.match(/^merged-from:/m)) {
              keepContent = keepContent.replace(
                /^(confidence:\s*\S+)\s*$/m,
                `$1\nmerged-from: [${JSON.stringify(removeFiles)}]\nmerged-at: ${new Date().toISOString()}`,
              );
            }
            await fs.writeFile(keepPath, keepContent, 'utf-8');
            filesModified++;
          } catch (e) {
            console.error(`[MemoryDream] action merge failed for ${keepFile}:`, e);
          }
        }
      }
    }

    // 写入文件（2.7: 如果已有同名文件，添加 merged-from）
    const userMemoryDir = path.resolve(process.env.ICE_USER_MEMORY_DIR ?? 'data/user-memory');
    if (Array.isArray(parsed.file_writes)) {
      for (const fw of parsed.file_writes) {
        if (!fw.filename || !fw.content) continue;
        try {
          // promote_to_user: Dream 确认的用户记忆 → 写入用户级目录
          const writeDir = fw.promote_to_user ? userMemoryDir : memoryDir;
          await fs.mkdir(writeDir, { recursive: true });
          const filePath = validatePath(fw.filename, writeDir);
          // 2.7: 若已有同名文件，注入 merged-from 元数据
          let writeContent = fw.content;
          try {
            const oldContent = await fs.readFile(filePath, 'utf-8');
            const mergedAt = new Date().toISOString();
            if (!writeContent.match(/^merged-from:\s*\[/m)) {
              writeContent = writeContent.replace(
                /^(confidence:\s*\S+)\s*$/m,
                `$1\nmerged-from: ["${fw.filename}"]\nmerged-at: ${mergedAt}`,
              );
            }
          } catch { /* 文件不存在，正常 */ }
          await fs.writeFile(filePath, writeContent, 'utf-8');
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

    // 删除文件（2.6 安全闸：禁止自动删除 feedback / 高置信 / 高召回）
    const deletedFilenames: string[] = [];
    if (Array.isArray(parsed.file_deletes)) {
      // 预扫描被删文件以实施安全闸
      const allMemories = await scanMemoryFiles(memoryDir, 500);
      const memMap = new Map(allMemories.map(m => [m.filename, m]));
      for (const filename of parsed.file_deletes) {
        if (!filename || filename === 'MEMORY.md') continue;
        const header = memMap.get(filename);
        if (header && isProtectedFromAutoDelete(header)) {
          console.log(`[MemoryDream] Safety gate: blocked auto-delete of "${filename}" (protected: type=${header.type}, confidence=${header.confidence}, recallCount=${header.recallCount})`);
          continue;
        }
        try {
          const filePath = validatePath(filename, memoryDir);
          await fs.unlink(filePath);
          filesDeleted++;
          deletedFilenames.push(filename);
        } catch (e) {
          if (e instanceof PathTraversalError) {
            console.error(`[MemoryDream] Path security violation: ${e.message}`);
          }
        }
      }
    }

    const wroteFullIndex = !!(parsed.new_index && typeof parsed.new_index === 'string');
    if (deletedFilenames.length > 0 && !wroteFullIndex) {
      // Phase 1: 用 removeIndexRows 维护索引，而非仅修死链
      removeIndexRows(memoryDir, deletedFilenames).catch(e => {
        console.debug('[MemoryDream] removeIndexRows failed:', e instanceof Error ? e.message : e);
      });
    }

    // 更新索引
    if (wroteFullIndex) {
      try {
        const indexPath = path.join(memoryDir, 'MEMORY.md');
        await fs.writeFile(indexPath, parsed.new_index as string, 'utf-8');
        filesModified++;
        getScannerCache().invalidate(memoryDir);
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
   * 将项目级全局 user 候选记忆晋升到用户级目录（无需 LLM）。
   * 项目专属偏好（如 javastudy-user-*、带 project: 标签）不自动晋升，留给 LLM promote_to_user。
   */
  private async autoPromoteUserCandidates(memoryDir: string, memories: MemoryHeader[]): Promise<number> {
    const userMemoryDir = resolveUserMemoryDir();
    await fs.mkdir(userMemoryDir, { recursive: true });
    let promoted = 0;

    for (const mem of memories) {
      if (!shouldAutoPromoteToUserLevel(mem)) continue;

      const confident = (mem.confidence ?? 0) >= USER_PROMOTE_MIN_CONFIDENCE;
      const recalled = (mem.recallCount ?? 0) >= USER_PROMOTE_MIN_RECALL;
      if (!confident && !recalled) continue;

      try {
        const content = await fs.readFile(mem.filePath, 'utf-8');
        const destPath = validatePath(mem.filename, userMemoryDir);
        await fs.writeFile(destPath, content, 'utf-8');
        await fs.unlink(mem.filePath);
        promoted++;
        console.log(`[MemoryDream] Auto-promoted to user-level: ${mem.filename}`);
      } catch (e) {
        if (!(e instanceof PathTraversalError)) {
          console.debug(`[MemoryDream] Auto-promote skipped ${mem.filename}:`, e instanceof Error ? e.message : e);
        }
      }
    }

    if (promoted > 0) {
      getScannerCache().invalidate(memoryDir);
      getScannerCache().invalidate(userMemoryDir);
    }
    return promoted;
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
   * 在因 stale_index 成功执行 Dream 后调用，启动防抖窗口，减少重复检查/长跑。
   */
  notifyStaleIndexDreamCompleted(): void {
    this.staleIndexDreamCompletedAt = Date.now();
    void this.enqueuePersistState().catch(() => {});
  }

  /**
   * 更新配置。
   */
  updateConfig(config: Partial<DreamConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ─── 状态持久化 ───

  /** 串行化写盘，后写覆盖先写，避免竞态 */
  private enqueuePersistState(): Promise<void> {
    this.persistChain = this.persistChain
      .then(() => this.persistState())
      .catch((err) => {
        console.debug('[MemoryDream] persistState failed:', err instanceof Error ? err.message : err);
      });
    return this.persistChain;
  }

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
        staleIndexDreamCompletedAt: this.staleIndexDreamCompletedAt,
        lastIndexDreamAttemptAt: this.lastIndexDreamAttemptAt,
        indexDreamBackoffCount: this.indexDreamBackoffCount,
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(this.stateFilePath, JSON.stringify(state), 'utf-8');
    } catch (err) {
      console.debug('[MemoryDream] persistState failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * 合并磁盘上由其他实例写入的 Dream 状态。
   * 若磁盘 lastDreamTime 更新（如手动 Dream 刚完成），同步 sessionCount 归零后再递增。
   */
  private async mergePersistedTimestamps(): Promise<void> {
    const priorLastDream = this.lastDreamTime;
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const state = JSON.parse(content);
      const diskLastDream = typeof state.lastDreamTime === 'number' ? state.lastDreamTime : 0;
      if (diskLastDream > priorLastDream) {
        if (typeof state.sessionCount === 'number') {
          this.sessionCount = state.sessionCount;
        }
      }
      if (diskLastDream > 0) {
        this.lastDreamTime = Math.max(this.lastDreamTime, diskLastDream);
      }
      if (typeof state.staleIndexDreamCompletedAt === 'number' && state.staleIndexDreamCompletedAt > 0) {
        this.staleIndexDreamCompletedAt = Math.max(
          this.staleIndexDreamCompletedAt,
          state.staleIndexDreamCompletedAt,
        );
      }
    } catch {
      // 文件不存在或解析失败
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
      if (typeof state.staleIndexDreamCompletedAt === 'number' && state.staleIndexDreamCompletedAt > 0) {
        this.staleIndexDreamCompletedAt = Math.max(
          this.staleIndexDreamCompletedAt,
          state.staleIndexDreamCompletedAt,
        );
      }
      if (typeof state.lastIndexDreamAttemptAt === 'number') {
        this.lastIndexDreamAttemptAt = Math.max(
          this.lastIndexDreamAttemptAt,
          state.lastIndexDreamAttemptAt,
        );
      }
      if (typeof state.indexDreamBackoffCount === 'number') {
        this.indexDreamBackoffCount = Math.max(
          this.indexDreamBackoffCount,
          state.indexDreamBackoffCount,
        );
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

/** 全局用户级文件名：必须以 user- 或 user_ 开头（排除 javastudy-user-* 等项目前缀命名） */
const GLOBAL_USER_FILENAME_RE = /^user[-_]/i;

/**
 * 是否应自动晋升到用户级目录（跨项目共享的通用偏好）。
 * 项目 scoped 记忆需由 Dream LLM 显式 promote_to_user。
 */
export function shouldAutoPromoteToUserLevel(mem: MemoryHeader): boolean {
  if (mem.type !== 'user') return false;
  if (!GLOBAL_USER_FILENAME_RE.test(mem.filename)) return false;
  if (mem.tags?.some(t => t.startsWith('project:'))) return false;
  return true;
}

function formatIndexHealthForDream(health: MemoryIndexHealthReport): string {
  const lines = [
    `- on_disk: ${health.onDisk}`,
    `- indexed: ${health.indexed}`,
    `- dead_refs: ${health.dead}`,
    `- orphans (on disk, not in index): ${health.orphans}`,
  ];
  if (health.deadFiles.length) {
    lines.push(`- dead_files: ${health.deadFiles.join(', ')}`);
  }
  if (health.orphanFiles.length) {
    lines.push(`- orphan_sample: ${health.orphanFiles.join(', ')}`);
  }
  return lines.join('\n');
}
