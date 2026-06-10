/**
 * 记忆手动整合 API。
 *
 * GET  /api/memory/dream  — 索引健康报告 + 上次整合原因
 * POST /api/memory/dream  — 先规则修索引，再触发 LLM 整合（?ruleOnly=true 仅规则修复）
 */

import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import type { LLMAdapterInterface } from '../../llm/types.js';
import { createMemoryDream } from '../../memory/file-memory/memory-dream.js';
import { auditMemoryIndexHealth } from '../../memory/file-memory/memory-index-health.js';
import { rebuildIndexIfDrifted } from '../../memory/file-memory/memory-index-maintainer.js';
import { getScannerCache } from '../../memory/file-memory/memory-scanner-cache.js';
import { scanMemoryFiles } from '../../memory/file-memory/memory-scanner.js';
import { getMemoryTelemetry } from '../../memory/file-memory/memory-telemetry.js';
import {
  getDreamJobStatus,
  isDreamJobRunning,
  scheduleManualDreamLlm,
} from '../../memory/file-memory/memory-dream-runner.js';
import '../../cli/paths.js';

const DEFAULT_MEMORY_DIR = process.env.ICE_MEMORY_DIR!;

/** 手动整合：规则修索引后、LLM 前按上限归档（项目 + 用户） */
async function evictBeforeManualDream(
  dream: ReturnType<typeof createMemoryDream>,
  memoryDir: string,
): Promise<number> {
  let evicted = 0;
  try {
    const proj = await dream.evictProjectMemoryIfOverCap(memoryDir);
    evicted += proj.evictedFiles.length;
    const user = await dream.evictUserMemoryIfOverCap();
    evicted += user.evictedFiles.length;
    if (evicted > 0) {
      await rebuildIndexIfDrifted(memoryDir).catch(() => {});
      getScannerCache().invalidate(memoryDir);
    }
  } catch (err) {
    console.error('[memory-dream] Pre-dream eviction failed:', err);
  }
  return evicted;
}

/**
 * 创建记忆手动整合 API 路由。
 */
export function createMemoryDreamRouter(llmAdapter?: LLMAdapterInterface): Router {
  const router = Router();

  /**
   * GET / — 索引健康报告（2.4：先看健康，再决定是否发 LLM）
   */
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const memoryDir = path.resolve(DEFAULT_MEMORY_DIR);
      const health = await auditMemoryIndexHealth(memoryDir);
      const dream = createMemoryDream();
      const gate = await dream.evaluateDreamGate(memoryDir);

      res.json({
        success: true,
        health: {
          dead: health.dead,
          orphans: health.orphans,
          indexed: health.indexed,
          onDisk: health.onDisk,
          deadFiles: health.deadFiles,
          orphanFiles: health.orphanFiles,
        },
        gate: {
          shouldRun: gate.shouldRun,
          trigger: gate.trigger,
          skipReason: gate.skipReason,
          indexDriftHealed: gate.skipReason === 'rule_fixed',
        },
        job: getDreamJobStatus(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST / — 手动触发 Dream 整合（先规则修索引，默认继续 LLM 整合）
   * Query: ?ruleOnly=true 仅规则修复，跳过 LLM
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const memoryDir = path.resolve(DEFAULT_MEMORY_DIR);
    const startMs = Date.now();
    let fileCountBefore = 0;

    try {
      fileCountBefore = (await scanMemoryFiles(memoryDir, 500)).length;
    } catch {
      // 扫描失败不阻塞整合
    }

    // Step 1: 规则层索引修复（始终执行）
    let ruleResult: { wrote: boolean; entryCount: number } | null = null;
    try {
      ruleResult = await rebuildIndexIfDrifted(memoryDir);
      if (ruleResult.wrote) {
        // 规则修复遥测记入 dream（带 skipReason: 'rule_fixed'）
        await getMemoryTelemetry().logDream({
          executed: false,
          fileCountBefore,
          filesModified: 0,
          filesDeleted: 0,
          durationMs: Date.now() - startMs,
          trigger: 'manual',
          skipReason: 'rule_fixed',
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[memory-dream] Rule repair failed:', err);
    }

    const ruleOnly = req.query.ruleOnly === 'true';
    const dream = createMemoryDream();
    const preEvicted = await evictBeforeManualDream(dream, memoryDir);

    // Step 2: 默认 LLM 整合；?ruleOnly=true 时仅规则修复
    if (ruleOnly) {
      getScannerCache().invalidate(memoryDir);

      await getMemoryTelemetry().logDream({
        executed: false,
        fileCountBefore,
        filesModified: 0,
        filesDeleted: 0,
        filesEvicted: preEvicted,
        durationMs: Date.now() - startMs,
        trigger: 'manual',
        skipReason: 'rule_only',
      }).catch(() => {});

      const evictNote = preEvicted > 0 ? `已归档 ${preEvicted} 条。` : '';
      res.json({
        success: true,
        executed: false,
        ruleOnly: true,
        ruleFixed: ruleResult?.wrote ?? false,
        ruleEntryCount: ruleResult?.entryCount ?? 0,
        summary: ruleResult?.wrote
          ? `索引已修复 ${ruleResult.entryCount} 条。${evictNote}（仅规则修复，未调用 LLM）`
          : `索引无需修复。${evictNote}（仅规则修复，未调用 LLM）`,
        filesModified: 0,
        filesDeleted: 0,
        filesEvicted: preEvicted,
        durationMs: Date.now() - startMs,
        fileCountBefore,
      });
      return;
    }

    // LLM 整合（后台异步，不阻塞 HTTP）
    if (!llmAdapter) {
      res.status(503).json({ success: false, error: 'LLM 未配置，无法执行深度整合' });
      return;
    }

    if (isDreamJobRunning()) {
      res.status(409).json({
        success: false,
        error: '已有记忆整合任务在后台运行，请稍后再试',
        job: getDreamJobStatus(),
      });
      return;
    }

    const accepted = scheduleManualDreamLlm({
      memoryDir,
      llmAdapter,
      fileCountBefore,
      preEvicted,
    });

    if (!accepted) {
      res.status(409).json({
        success: false,
        error: '无法启动后台整合任务',
        job: getDreamJobStatus(),
      });
      return;
    }

    const evictNote = preEvicted > 0 ? `已归档 ${preEvicted} 条。` : '';
    const indexNote = ruleResult?.wrote
      ? `索引已修复 ${ruleResult.entryCount} 条。`
      : '索引无需修复。';

    res.status(202).json({
      success: true,
      background: true,
      accepted: true,
      executed: null,
      ruleOnly: false,
      ruleFixed: ruleResult?.wrote ?? false,
      ruleEntryCount: ruleResult?.entryCount ?? 0,
      summary: `${indexNote}${evictNote} LLM 深度整合已在后台开始，不影响对话；请稍后刷新本页查看结果。`,
      filesModified: 0,
      filesDeleted: 0,
      filesEvicted: preEvicted,
      filesEvictedBeforeLlm: preEvicted,
      durationMs: Date.now() - startMs,
      fileCountBefore,
      job: getDreamJobStatus(),
    });
  });

  return router;
}
