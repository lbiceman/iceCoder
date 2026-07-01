/**
 * GET /api/mcp — MCP 服务器运行时状态（供配置页 / 调试）。
 */

import { Router, type Request, type Response } from 'express';
import type { MCPManager } from '../../mcp/mcp-manager.js';

export function createMcpStatusRouter(mcpManager: MCPManager): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      await mcpManager.whenReady();
      const servers = mcpManager.getServerInfos().map((s) => ({
        name: s.name,
        status: s.status,
        toolCount: s.tools.length,
        error: s.error ?? null,
        tools: s.tools.map((t) => `mcp_${s.name}_${t.name}`),
        disabled: s.config.disabled ?? false,
      }));
      res.json({
        success: true,
        readyServers: mcpManager.readyServers,
        totalTools: mcpManager.totalTools,
        configPath: process.env.ICE_MCP_CONFIG_PATH ?? null,
        servers,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
