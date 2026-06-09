/**
 * 记忆手动整合 API。
 *
 * POST /api/memory/dream — 触发 autoDream（忽略门控，强制执行 LLM 整合）
 */

import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import type { LLMAdapterInterface } from '../../llm/types.js';
import { createMemoryDream } from '../../memory/file-memory/memory-dream.js';
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
   * POST / — 手动触发 Dream 整合
   */
  router.post('/', async (_req: Request, res: Response): Promise<void> => {
    if (!llmAdapter) {
      res.status(503).json({ success: false, error: 'LLM 未配置，无法执行记忆整合' });
      return;
    }

    const memoryDir = path.resolve(DEFAULT_MEMORY_DIR);
    const startMs = Date.now();
    let fileCountBefore = 0;

    try {
      fileCountBefore = (await scanMemoryFiles(memoryDir, 500)).length;
    } catch {
      // 扫描失败不阻塞整合
    }

    try {
      const dream = createMemoryDream();
      const gate = await dream.evaluateDreamGate(memoryDir);
      const result = await dream.forceDream(memoryDir, llmAdapter);

      if (
        result.executed
        && (gate.trigger === 'stale_index' || gate.trigger === 'index_drift')
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
