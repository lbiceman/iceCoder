/**
 * 记忆手动整合 API。
 *
 * GET  /api/memory/dream  — 索引健康报告 + 上次整合原因
 * POST /api/memory/dream  — 先规则修索引，可选触发 LLM 深度整合（?deep=true）
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
import '../../cli/paths.js';

const DEFAULT_MEMORY_DIR = process.env.ICE_MEMORY_DIR!;

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
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST / — 手动触发 Dream 整合（2.4：先规则修索引，可选深度 LLM）
   * Query: ?deep=true 启用 LLM 深度整合（默认只做规则修复）
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

    const deep = req.query.deep === 'true';

    // Step 2: 可选 LLM 深度整合
    if (!deep) {
      // 仅规则修复模式
      getScannerCache().invalidate(memoryDir);

      await getMemoryTelemetry().logDream({
        executed: false,
        fileCountBefore,
        filesModified: 0,
        filesDeleted: 0,
        durationMs: Date.now() - startMs,
        trigger: 'manual',
        skipReason: 'rule_only',
      }).catch(() => {});

      res.json({
        success: true,
        executed: false,
        deep: false,
        ruleFixed: ruleResult?.wrote ?? false,
        ruleEntryCount: ruleResult?.entryCount ?? 0,
        summary: ruleResult?.wrote
          ? `索引已修复 ${ruleResult.entryCount} 条。未触发 LLM 深度整合（加 ?deep=true 可启用）。`
          : '索引无需修复。未触发 LLM 深度整合（加 ?deep=true 可启用）。',
        filesModified: 0,
        filesDeleted: 0,
        filesEvicted: 0,
        durationMs: Date.now() - startMs,
        fileCountBefore,
      });
      return;
    }

    // LLM 深度整合模式
    if (!llmAdapter) {
      res.status(503).json({ success: false, error: 'LLM 未配置，无法执行深度整合' });
      return;
    }

    try {
      const dream = createMemoryDream();
      const gate = await dream.evaluateDreamGate(memoryDir);
      const result = await dream.forceDream(memoryDir, llmAdapter);

      if (
        result.executed
        && gate.trigger === 'stale_index'
      ) {
        dream.notifyStaleIndexDreamCompleted();
      }

      getScannerCache().invalidate(memoryDir);

      await getMemoryTelemetry().logDream({
        executed: result.executed,
        fileCountBefore,
        filesModified: result.filesModified,
        filesDeleted: result.filesDeleted,
        filesEvicted: result.filesEvicted,
        durationMs: result.duration,
        trigger: 'manual',
      }).catch(() => {});

      res.json({
        success: true,
        executed: result.executed,
        deep: true,
        ruleFixed: ruleResult?.wrote ?? false,
        ruleEntryCount: ruleResult?.entryCount ?? 0,
        summary: result.summary,
        filesModified: result.filesModified,
        filesDeleted: result.filesDeleted,
        filesEvicted: result.filesEvicted ?? 0,
        durationMs: result.duration,
        fileCountBefore,
      });
    } catch (error) {
      console.error('[memory-dream] Manual dream failed:', error);
      await getMemoryTelemetry().logDream({
        executed: false,
        fileCountBefore,
        filesModified: 0,
        filesDeleted: 0,
        durationMs: Date.now() - startMs,
        trigger: 'manual',
      }).catch(() => {});

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
