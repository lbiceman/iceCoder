/**
 * 记忆系统遥测 API 路由。
 *
 * GET /api/memory/telemetry — 返回遥测报告（进程内统计 + JSONL 日志汇总）。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getMemoryTelemetry } from '../../memory/file-memory/memory-telemetry.js';
import { scanMemoryFiles } from '../../memory/file-memory/memory-scanner.js';
import { memoryAgeDays } from '../../memory/file-memory/memory-age.js';

const DEFAULT_MEMORY_DIR = process.env.ICE_MEMORY_DIR || 'data/memory-files';
const DEFAULT_TELEMETRY_LOG = 'data/memory/telemetry.jsonl';

// ─── JSONL 日志解析 ───

interface TelemetryLogEntry {
  type: string;
  timestamp: string;
  [key: string]: any;
}

/**
 * 读取 JSONL 日志文件，返回最近 N 天的事件。
 */
async function readTelemetryLog(logPath: string, days: number): Promise<TelemetryLogEntry[]> {
  try {
    const content = await fs.readFile(logPath, 'utf-8');
    const cutoff = Date.now() - days * 86_400_000;
    const entries: TelemetryLogEntry[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TelemetryLogEntry;
        if (new Date(entry.timestamp).getTime() >= cutoff) {
          entries.push(entry);
        }
      } catch {
        // 跳过损坏的行
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * 从 JSONL 日志条目中汇总统计。
 */
function aggregateLogEntries(entries: TelemetryLogEntry[]) {
  let recallCount = 0;
  let recallLLMCount = 0;
  let recallTotalMs = 0;
  let recallTotalSelected = 0;

  let extractCount = 0;
  let extractCacheHits = 0;
  let extractTotalMs = 0;
  let extractTotalMemories = 0;

  let dreamCount = 0;
  let dreamTotalModified = 0;
  let dreamTotalDeleted = 0;
  let dreamTotalMs = 0;

  for (const e of entries) {
    switch (e.type) {
      case 'memory_recall':
        recallCount++;
        if (e.usedLLM) recallLLMCount++;
        recallTotalMs += e.durationMs || 0;
        recallTotalSelected += e.selectedCount || 0;
        break;
      case 'memory_extract':
        extractCount++;
        if (e.usedPromptCache) extractCacheHits++;
        extractTotalMs += e.durationMs || 0;
        extractTotalMemories += e.extractedCount || 0;
        break;
      case 'memory_dream':
        if (e.executed) {
          dreamCount++;
          dreamTotalModified += e.filesModified || 0;
          dreamTotalDeleted += e.filesDeleted || 0;
          dreamTotalMs += e.durationMs || 0;
        }
        break;
    }
  }

  return {
    recall: {
      count: recallCount,
      llmRate: recallCount > 0 ? Math.round(recallLLMCount / recallCount * 100) : 0,
      avgMs: recallCount > 0 ? Math.round(recallTotalMs / recallCount) : 0,
      totalSelected: recallTotalSelected,
    },
    extract: {
      count: extractCount,
      cacheHitRate: extractCount > 0 ? Math.round(extractCacheHits / extractCount * 100) : 0,
      avgMs: extractCount > 0 ? Math.round(extractTotalMs / extractCount) : 0,
      totalMemories: extractTotalMemories,
    },
    dream: {
      count: dreamCount,
      totalModified: dreamTotalModified,
      totalDeleted: dreamTotalDeleted,
      avgMs: dreamCount > 0 ? Math.round(dreamTotalMs / dreamCount) : 0,
    },
  };
}

/**
 * 扫描记忆目录，生成库统计。
 */
async function getMemoryStoreStats(memoryDir: string) {
  try {
    const memories = await scanMemoryFiles(memoryDir);
    if (memories.length === 0) {
      return { totalFiles: 0, byType: {}, avgAgeDays: 0, maxAgeDays: 0 };
    }

    const byType: Record<string, number> = {};
    let totalAge = 0;
    let maxAge = 0;

    for (const m of memories) {
      const t = m.type || 'unknown';
      byType[t] = (byType[t] || 0) + 1;
      const age = memoryAgeDays(m.mtimeMs);
      totalAge += age;
      if (age > maxAge) maxAge = age;
    }

    return {
      totalFiles: memories.length,
      byType,
      avgAgeDays: Math.round(totalAge / memories.length * 10) / 10,
      maxAgeDays: maxAge,
    };
  } catch {
    return { totalFiles: 0, byType: {}, avgAgeDays: 0, maxAgeDays: 0 };
  }
}

/**
 * 生成人类可读的遥测报告文本。
 */
function formatReport(
  log: ReturnType<typeof aggregateLogEntries>,
  store: Awaited<ReturnType<typeof getMemoryStoreStats>>,
  processSummary: Record<string, number>,
  days: number,
): string {
  const lines: string[] = [];

  lines.push(`📊 **记忆系统遥测报告**（最近 ${days} 天）`);
  lines.push('');

  // 召回
  if (log.recall.count > 0 || processSummary.totalRecalls > 0) {
    const count = log.recall.count || processSummary.totalRecalls;
    const llmRate = log.recall.count > 0 ? log.recall.llmRate : processSummary.llmRecallRate;
    const avgMs = log.recall.count > 0 ? log.recall.avgMs : processSummary.avgRecallMs;
    const selected = log.recall.totalSelected || processSummary.totalMemoriesSelected;
    lines.push(`**召回** ${count} 次 | LLM ${llmRate}% / 关键词 ${100 - llmRate}% | 平均 ${avgMs}ms | 共选中 ${selected} 条`);
  } else {
    lines.push('**召回** 暂无数据');
  }

  // 提取
  if (log.extract.count > 0 || processSummary.totalExtracts > 0) {
    const count = log.extract.count || processSummary.totalExtracts;
    const cacheRate = log.extract.count > 0 ? log.extract.cacheHitRate : processSummary.cacheHitRate;
    const avgMs = log.extract.count > 0 ? log.extract.avgMs : processSummary.avgExtractMs;
    const total = log.extract.totalMemories || processSummary.totalMemoriesExtracted;
    lines.push(`**提取** ${count} 次 | prompt cache 命中 ${cacheRate}% | 平均 ${avgMs}ms | 共提取 ${total} 条`);
  } else {
    lines.push('**提取** 暂无数据');
  }

  // Dream
  if (log.dream.count > 0 || processSummary.totalDreams > 0) {
    const count = log.dream.count || processSummary.totalDreams;
    const modified = log.dream.totalModified;
    const deleted = log.dream.totalDeleted;
    const avgMs = log.dream.avgMs;
    lines.push(`**整合** ${count} 次 | 修改 ${modified} 文件 / 删除 ${deleted} 文件 | 平均 ${avgMs}ms`);
  } else {
    lines.push('**整合** 暂无数据');
  }

  // 记忆库
  lines.push('');
  if (store.totalFiles > 0) {
    const typeStr = Object.entries(store.byType)
      .map(([t, n]) => `${t}:${n}`)
      .join(' ');
    lines.push(`**记忆库** ${store.totalFiles} 个文件 | ${typeStr} | 平均 ${store.avgAgeDays} 天 | 最老 ${store.maxAgeDays} 天`);
  } else {
    lines.push('**记忆库** 空（尚未创建记忆文件）');
  }

  return lines.join('\n');
}

/**
 * 创建记忆遥测 API 路由。
 */
export function createMemoryTelemetryRouter(): Router {
  const router = Router();

  /**
   * GET /api/memory/telemetry — 返回遥测报告
   * 查询参数：days（默认 7）、format（text | json，默认 text）
   */
  router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days as string) || 7, 1), 90);
      const format = (req.query.format as string) || 'text';

      // 1. 读取 JSONL 日志
      const logEntries = await readTelemetryLog(DEFAULT_TELEMETRY_LOG, days);
      const logStats = aggregateLogEntries(logEntries);

      // 2. 扫描记忆目录
      const storeStats = await getMemoryStoreStats(DEFAULT_MEMORY_DIR);

      // 3. 获取进程内累计统计
      const processSummary = getMemoryTelemetry().getSummary();

      if (format === 'json') {
        res.json({
          success: true,
          days,
          log: logStats,
          store: storeStats,
          process: processSummary,
        });
      } else {
        const report = formatReport(logStats, storeStats, processSummary, days);
        res.json({ success: true, report });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: `遥测报告生成失败: ${message}` });
    }
  });

  return router;
}
