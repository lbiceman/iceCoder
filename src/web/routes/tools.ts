/**
 * 工具 API 路由。
 * 提供工具列表查询和单个工具直接调用的 HTTP 接口。
 */

import { Router, type Request, type Response } from 'express';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { ToolExecutor } from '../../tools/tool-executor.js';

export interface ToolsRouterOptions {
  registry: ToolRegistry;
  executor: ToolExecutor;
}

/**
 * 创建工具 API 路由。
 */
export function createToolsRouter(options: ToolsRouterOptions): Router {
  const { registry, executor } = options;
  const router = Router();

  /**
   * GET /api/tools - 列出所有可用工具
   */
  router.get('/', (_req: Request, res: Response): void => {
    const tools = registry.getAll().map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      parameters: t.definition.parameters,
    }));

    res.json({ success: true, tools, count: tools.length });
  });

  /**
   * POST /api/tools/execute - 直接调用指定工具
   */
  router.post('/execute', async (req: Request, res: Response): Promise<void> => {
    try {
      const { name, arguments: args } = req.body as {
        name: string;
        arguments?: Record<string, any>;
      };

      if (!name) {
        res.status(400).json({ error: '需要提供工具名称 (name)' });
        return;
      }

      if (!registry.has(name)) {
        res.status(404).json({ error: `工具不存在: ${name}` });
        return;
      }

      const result = await executor.executeTool({
        id: `manual-${Date.now()}`,
        name,
        arguments: args || {},
      });

      res.json({
        success: result.success,
        output: result.output,
        error: result.error,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: `工具执行失败: ${message}` });
    }
  });

  return router;
}
