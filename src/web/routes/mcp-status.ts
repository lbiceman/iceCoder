/**
 * GET /api/mcp — MCP 服务器运行时状态（供配置页 / 调试）。
 * POST /api/mcp/reload — 手动触发热重载（重读 mcp.json）。
 * POST /api/mcp/servers/:name/stop — 手动停止单个 MCP Server。
 * POST /api/mcp/servers/:name/start — 启动单个 MCP Server（等同 restart）。
 * POST /api/mcp/servers/:name/restart — 重启单个 MCP Server。
 */

import { Router, type Request, type Response } from 'express';
import type { MCPManager } from '../../mcp/mcp-manager.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { reloadMcpConfiguration, syncMcpToolsOnRegistry } from '../../mcp/reload-mcp-config.js';

export interface McpStatusRouterOptions {
  mcpManager: MCPManager;
  registry: ToolRegistry;
  onReloaded?: (result: import('../../mcp/start-mcp-background.js').McpBackgroundSettled) => void;
}

export function createMcpStatusRouter(options: McpStatusRouterOptions): Router;
export function createMcpStatusRouter(mcpManager: MCPManager): Router;
export function createMcpStatusRouter(
  optionsOrManager: McpStatusRouterOptions | MCPManager,
): Router {
  const mcpManager = 'mcpManager' in optionsOrManager ? optionsOrManager.mcpManager : optionsOrManager;
  const registry = 'registry' in optionsOrManager ? optionsOrManager.registry : undefined;
  const onReloaded = 'onReloaded' in optionsOrManager ? optionsOrManager.onReloaded : undefined;

  const router = Router();

  async function syncToolsAndRespond(
    res: Response,
    action: () => Promise<void>,
  ): Promise<void> {
    if (!registry) {
      res.status(501).json({ success: false, error: 'MCP server control is not configured for this server instance' });
      return;
    }
    try {
      await action();
      const registeredCount = syncMcpToolsOnRegistry(registry, mcpManager);
      res.json({
        success: true,
        readyServers: mcpManager.readyServers,
        totalTools: mcpManager.totalTools,
        registeredCount,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  router.post('/servers/:name/stop', (req: Request, res: Response): void => {
    const name = String(req.params.name);
    void syncToolsAndRespond(res, () => mcpManager.stopServer(name));
  });

  router.post('/servers/:name/start', (req: Request, res: Response): void => {
    const name = String(req.params.name);
    void syncToolsAndRespond(res, () => mcpManager.startServerByName(name));
  });

  router.post('/servers/:name/restart', (req: Request, res: Response): void => {
    const name = String(req.params.name);
    void syncToolsAndRespond(res, () => mcpManager.restartServer(name));
  });

  router.post('/reload', async (_req: Request, res: Response): Promise<void> => {
    if (!registry) {
      res.status(501).json({ success: false, error: 'MCP reload is not configured for this server instance' });
      return;
    }
    try {
      const result = await reloadMcpConfiguration(mcpManager, registry);
      onReloaded?.(result);
      res.json({
        success: result.ok,
        readyServers: result.readyServers,
        totalTools: result.toolCount,
        registeredCount: result.registeredCount ?? 0,
        error: result.errorMessage ?? null,
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      await mcpManager.whenReady();
      const servers = mcpManager.getServerInfos().map((s) => ({
        name: s.name,
        status: s.status,
        toolCount: s.tools.length,
        error: s.error ?? null,
        tools: s.tools.map((t) => `mcp_${s.name}_${t.name}`),
        toolsDetail: s.tools.map((t) => ({
          name: t.name,
          description: t.description ?? '',
        })),
        disabled: s.config.disabled ?? false,
        config: {
          command: s.config.command,
          args: s.config.args ?? [],
          disabled: s.config.disabled ?? false,
          cwd: s.config.cwd ?? null,
        },
      }));
      res.json({
        success: true,
        readyServers: mcpManager.readyServers,
        totalTools: mcpManager.totalTools,
        configPath: process.env.ICE_MCP_CONFIG_PATH ?? mcpManager.getConfigPath(),
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
