/**
 * 记忆文件 LRU 淘汰机制。
 *
 * 当记忆文件数接近上限时，自动淘汰低活跃度的记忆文件，
 * 避免触及 maxMemoryFiles 硬上限导致新记忆无法写入。
 *
 * 淘汰策略：加权评分（非纯 LRU），综合考虑：
 * - 最后活跃时间（越久没活跃，越该淘汰）
 * - 置信度（高置信度记忆受保护）
 * - 召回频率（经常被召回的记忆受保护）
 * - 记忆类型（user 受保护；feedback/reference 更易淘汰）
 *
 * 被淘汰的文件移动到 `memory-evicted/{memory-files|user-memory}/`（可恢复），不是直接删除。
 */

import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './atomic-write.js';
import path from 'node:path';
import type { MemoryHeader } from './types.js';
import { scanMemoryFiles } from './memory-scanner.js';
import { repairDeadLinksInMemoryIndex } from './memory-index-health.js';
import { removeIndexRows } from './memory-index-maintainer.js';
import { getScannerCache } from './memory-scanner-cache.js';
import {
  type EvictionConfig,
  DEFAULT_EVICTION_CONFIG,
  EVICTION_AGE_CAP_DAYS,
  EVICTION_CONFIDENCE_WEIGHT,
  EVICTION_RECALL_CAP,
  EVICTION_RECALL_WEIGHT,
  EVICTION_USER_TYPE_BONUS,
  EVICTION_CONFIDENCE_PROTECTION,
  EVICTION_SCAN_LIMIT,
  DEFAULT_CONFIDENCE_FALLBACK,
  evictionTypeEvictionBias,
} from './memory-config.js';

// 重新导出类型和默认值，保持向后兼容
export type { EvictionConfig } from './memory-config.js';
export { DEFAULT_EVICTION_CONFIG } from './memory-config.js';

// ─── 淘汰结果 ───

export interface EvictionResult {
  /** 是否执行了淘汰 */
  executed: boolean;
  /** 淘汰前的文件数 */
  fileCountBefore: number;
  /** 淘汰后的文件数 */
  fileCountAfter: number;
  /** 被淘汰的文件名列表 */
  evictedFiles: string[];
  /** 淘汰原因摘要 */
  summary: string;
}

// ─── 淘汰评分 ───

const DAY_MS = 86_400_000;

const LEVEL_PROTECTION: Record<string, number> = {
  hard_rule: 35,
  preference: 24,
  project_fact: 14,
  observation: 4,
  session_state: -18,
};

const EVIDENCE_PROTECTION: Record<string, number> = {
  explicit: 28,
  repeated: 20,
  inferred: 4,
  weak: -16,
};

const SOURCE_PROTECTION: Record<string, number> = {
  user_explicit: 30,
  manual: 22,
  dream: 10,
  llm_extract: 0,
};

export interface EvictionScoreBreakdown {
  score: number;
  freshnessPenalty: number;
  confidenceProtection: number;
  recallProtection: number;
  typeProtection: number;
  levelProtection: number;
  evidenceProtection: number;
  sourceProtection: number;
  typeEvictBias: number;
  activeDays: number;
}

/**
 * 计算记忆的淘汰评分。
 *
 * 分数越高越该被淘汰：
 * - freshnessPenalty: 越久没活跃/发生，分越高（0-100）
 * - confidenceProtection: 高置信度记忆受保护（0-30）
 * - recallProtection: 经常被召回的记忆受保护（0-20）
 * - type/level/evidence/source: 显式规则、偏好、强证据、人工/用户明确记忆受保护
 */
export function computeEvictionScore(mem: MemoryHeader): number {
  return computeEvictionScoreBreakdown(mem).score;
}

export function computeEvictionScoreBreakdown(mem: MemoryHeader, now = Date.now()): EvictionScoreBreakdown {
  const lastActiveMs = getFreshnessAnchorMs(mem);
  const activeDays = Math.max(0, (now - lastActiveMs) / DAY_MS);

  // 越久没活跃/发生，淘汰分越高（0-100）
  const freshnessPenalty = Math.min(activeDays, EVICTION_AGE_CAP_DAYS) / EVICTION_AGE_CAP_DAYS * 100;

  // 高置信度保护（0-30）
  const confidenceProtection = (mem.confidence || DEFAULT_CONFIDENCE_FALLBACK) * EVICTION_CONFIDENCE_WEIGHT;

  // 召回频率保护（0-20，上限 recallCount=20）
  const recallProtection = Math.min(mem.recallCount || 0, EVICTION_RECALL_CAP) / EVICTION_RECALL_CAP * EVICTION_RECALL_WEIGHT;

  // user 类型保护（0 或 15）；feedback / reference 等见 evictionTypeEvictionBias
  const typeProtection = mem.type === 'user' ? EVICTION_USER_TYPE_BONUS : 0;
  const levelProtection = LEVEL_PROTECTION[mem.level] ?? 0;
  const evidenceProtection = EVIDENCE_PROTECTION[mem.evidenceStrength] ?? 0;
  const sourceProtection = mem.source ? (SOURCE_PROTECTION[mem.source] ?? 0) : 0;
  const typeEvictBias = evictionTypeEvictionBias(mem.type);
  const score = freshnessPenalty
    - confidenceProtection
    - recallProtection
    - typeProtection
    - levelProtection
    - evidenceProtection
    - sourceProtection
    + typeEvictBias;

  return {
    score,
    freshnessPenalty,
    confidenceProtection,
    recallProtection,
    typeProtection,
    levelProtection,
    evidenceProtection,
    sourceProtection,
    typeEvictBias,
    activeDays,
  };
}

function getFreshnessAnchorMs(mem: MemoryHeader): number {
  return Math.max(
    mem.lastRecalledMs || 0,
    mem.eventDateMs || 0,
    mem.createdMs || 0,
    mem.mtimeMs || 0,
  );
}

// ─── 核心淘汰逻辑 ───

/**
 * 检查并执行记忆文件淘汰。
 *
 * 触发条件：当前文件数 > softLimit
 * 淘汰目标：减少到 evictionTarget
 *
 * 安全保护：
 * - 不淘汰 confidence >= 1.0 的记忆（用户明确声明）
 * - 不淘汰最近 protectionDays 天内创建或召回的记忆
 * - 不淘汰 MEMORY.md
 * - 被淘汰的文件移动到 evictedDir（可恢复）
 */
export async function evictIfNeeded(
  memoryDir: string,
  config: Partial<EvictionConfig> = {},
): Promise<EvictionResult> {
  const cfg = { ...DEFAULT_EVICTION_CONFIG, ...config };

  if (!cfg.enabled) {
    return { executed: false, fileCountBefore: 0, fileCountAfter: 0, evictedFiles: [], summary: 'Eviction disabled' };
  }

  // 扫描全部文件（不截断）
  const allMemories = await scanMemoryFiles(memoryDir, EVICTION_SCAN_LIMIT);
  const fileCountBefore = allMemories.length;

  if (fileCountBefore <= cfg.softLimit) {
    return { executed: false, fileCountBefore, fileCountAfter: fileCountBefore, evictedFiles: [], summary: 'Below soft limit' };
  }

  // 计算需要淘汰的数量
  const toEvictCount = fileCountBefore - cfg.evictionTarget;
  if (toEvictCount <= 0) {
    return { executed: false, fileCountBefore, fileCountAfter: fileCountBefore, evictedFiles: [], summary: 'Already at target' };
  }

  // 筛选可淘汰的候选（排除受保护的记忆）
  const now = Date.now();
  const protectionMs = cfg.protectionDays * 86_400_000;

  const candidates = allMemories.filter(mem => {
    // 不淘汰高置信度记忆（用户明确声明）
    if ((mem.confidence || DEFAULT_CONFIDENCE_FALLBACK) >= EVICTION_CONFIDENCE_PROTECTION) return false;

    // 不淘汰保护期内的记忆
    const lastActiveMs = getFreshnessAnchorMs(mem);
    if (now - lastActiveMs < protectionMs) return false;

    return true;
  });

  if (candidates.length === 0) {
    return {
      executed: false,
      fileCountBefore,
      fileCountAfter: fileCountBefore,
      evictedFiles: [],
      summary: 'No eligible candidates for eviction (all protected)',
    };
  }

  // 按淘汰评分降序排列（分数最高的最先淘汰）
  candidates.sort((a, b) => computeEvictionScore(b) - computeEvictionScore(a));

  // 取前 N 个淘汰
  const toEvict = candidates.slice(0, Math.min(toEvictCount, candidates.length));

  // 确保淘汰目录存在
  await fs.mkdir(cfg.evictedDir, { recursive: true });

  // 执行淘汰：移动文件到 evictedDir
  const evictedFiles: string[] = [];
  const evictedDetails: Array<{ filename: string; score: number; reason: string }> = [];
  for (const mem of toEvict) {
    const breakdown = computeEvictionScoreBreakdown(mem);
    try {
      const destPath = path.join(cfg.evictedDir, mem.filename);
      // 确保目标子目录存在（如果 filename 包含子路径）
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.rename(mem.filePath, destPath);
      evictedFiles.push(mem.filename);
      evictedDetails.push({ filename: mem.filename, score: breakdown.score, reason: formatEvictionReason(mem, breakdown) });
    } catch (err) {
      // 移动失败（跨设备等），回退到复制+删除
      try {
        const content = await fs.readFile(mem.filePath, 'utf-8');
        const destPath = path.join(cfg.evictedDir, mem.filename);
        await writeFileAtomic(destPath, content, 'utf-8');
        await fs.unlink(mem.filePath);
        evictedFiles.push(mem.filename);
        evictedDetails.push({ filename: mem.filename, score: breakdown.score, reason: formatEvictionReason(mem, breakdown) });
      } catch {
        console.debug(`[memory-eviction] Failed to evict ${mem.filename}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // 清理归档目录（超过 maxEvictedFiles 时删除最老的）
  await pruneEvictedDir(cfg.evictedDir, cfg.maxEvictedFiles);

  // 写入淘汰日志
  await appendEvictionLog(cfg.evictedDir, evictedDetails);

  const fileCountAfter = fileCountBefore - evictedFiles.length;
  const summary = evictedFiles.length > 0
    ? `Evicted ${evictedFiles.length} low-activity memories: ${evictedFiles.join(', ')}`
    : 'No files evicted';

  if (evictedFiles.length > 0) {
    console.log(`[memory-eviction] ${summary}`);
    try {
      await removeIndexRows(memoryDir, evictedFiles);
    } catch (err) {
      console.debug('[memory-eviction] removeIndexRows failed:', err instanceof Error ? err.message : err);
    }
    try {
      const repair = await repairDeadLinksInMemoryIndex(memoryDir);
      if (repair.wrote) {
        console.debug(`[memory-eviction] MEMORY.md stripped ${repair.removedLinks} dead link(s)`);
        getScannerCache().invalidate(memoryDir);
      }
    } catch (err) {
      console.debug('[memory-eviction] repair MEMORY.md links failed:', err instanceof Error ? err.message : err);
    }
  }

  return { executed: evictedFiles.length > 0, fileCountBefore, fileCountAfter, evictedFiles, summary };
}

function formatEvictionReason(mem: MemoryHeader, score: EvictionScoreBreakdown): string {
  const weakSignals: string[] = [];
  if (score.activeDays > 90) weakSignals.push(`inactive ${Math.round(score.activeDays)}d`);
  if ((mem.confidence || DEFAULT_CONFIDENCE_FALLBACK) < 0.5) weakSignals.push(`low confidence ${mem.confidence}`);
  if ((mem.recallCount || 0) === 0) weakSignals.push('never recalled');
  if (mem.evidenceStrength === 'weak') weakSignals.push('weak evidence');
  if (mem.level === 'session_state') weakSignals.push('session state');
  if (mem.type === 'reference' || mem.type === 'feedback') weakSignals.push(`${mem.type} bias`);
  return weakSignals.length > 0 ? weakSignals.join(', ') : 'lowest weighted retention score';
}

/**
 * 从淘汰归档中恢复记忆文件。
 */
export async function restoreEvicted(
  memoryDir: string,
  filename: string,
  evictedDir: string = DEFAULT_EVICTION_CONFIG.evictedDir,
): Promise<boolean> {
  try {
    const srcPath = path.join(evictedDir, filename);
    const destPath = path.join(memoryDir, filename);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.rename(srcPath, destPath);
    console.log(`[memory-eviction] Restored: ${filename}`);
    return true;
  } catch {
    try {
      // 回退到复制+删除
      const srcPath = path.join(evictedDir, filename);
      const content = await fs.readFile(srcPath, 'utf-8');
      const destPath = path.join(memoryDir, filename);
      await writeFileAtomic(destPath, content, 'utf-8');
      await fs.unlink(srcPath);
      console.log(`[memory-eviction] Restored (copy): ${filename}`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 列出已淘汰的文件。
 */
export async function listEvictedFiles(
  evictedDir: string = DEFAULT_EVICTION_CONFIG.evictedDir,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(evictedDir);
    return entries.filter(f => f.endsWith('.md') && f !== '_eviction_log.jsonl');
  } catch {
    return [];
  }
}

// ─── 内部工具 ───

/**
 * 清理归档目录，保留最新的 maxFiles 个文件。
 */
async function pruneEvictedDir(evictedDir: string, maxFiles: number): Promise<void> {
  try {
    const entries = await fs.readdir(evictedDir);
    const mdFiles = entries.filter(f => f.endsWith('.md'));

    if (mdFiles.length <= maxFiles) return;

    // 按 mtime 排序，删除最老的
    const withStats = await Promise.all(
      mdFiles.map(async f => {
        const filePath = path.join(evictedDir, f);
        const stat = await fs.stat(filePath);
        return { filename: f, filePath, mtimeMs: stat.mtimeMs };
      }),
    );

    withStats.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toDelete = withStats.slice(0, withStats.length - maxFiles);

    for (const f of toDelete) {
      await fs.unlink(f.filePath).catch(() => {});
    }
  } catch {
    // 目录不存在等，静默处理
  }
}

/**
 * 追加淘汰日志。
 */
async function appendEvictionLog(
  evictedDir: string,
  evictedDetails: Array<{ filename: string; score: number; reason: string }>,
): Promise<void> {
  if (evictedDetails.length === 0) return;
  try {
    const logPath = path.join(evictedDir, '_eviction_log.jsonl');
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      evictedFiles: evictedDetails.map(f => f.filename),
      evictedDetails,
      count: evictedDetails.length,
    }) + '\n';
    await fs.appendFile(logPath, entry, 'utf-8');
  } catch {
    // 日志写入失败不阻塞
  }
}
