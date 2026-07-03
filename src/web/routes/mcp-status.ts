/**
 * GET /api/mcp — MCP 服务器运行时状态（供配置页 / 调试）。
 * GET /api/mcp/servers/:name/config — 单个 MCP 服务器完整配置（来自 mcp.json）。
 * PUT /api/mcp/servers/:name/config — 保存单个 MCP 服务器配置并重载。
 * POST /api/mcp/servers — 新增 MCP 服务器并重载。
 * DELETE /api/mcp/servers/:name — 删除 MCP 服务器并重载。
 * POST /api/mcp/reload — 手动触发热重载（重读 mcp.json）。
 * POST /api/mcp/servers/:name/stop — 手动停止单个 MCP Server。
 * POST /api/mcp/servers/:name/start — 启动单个 MCP Server（等同 restart）。
 * POST /api/mcp/servers/:name/restart — 重启单个 MCP Server。
 */

import { Router, type Request, type Response } from 'express';
import type { MCPManager } from '../../mcp/mcp-manager.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { reloadMcpConfiguration, syncMcpToolsOnRegistry } from '../../mcp/reload-mcp-config.js';
import {
  addMcpServerConfig,
  getMcpServerConfig,
  removeMcpServerConfig,
  updateMcpServerConfig,
  validateMcpServerConfig,
} from '../../mcp/persist-mcp-config.js';

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
  const configPath = () => process.env.ICE_MCP_CONFIG_PATH ?? mcpManager.getConfigPath();

  function mapMcpServers() {
    return mcpManager.getServerInfos().map((s) => ({
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
  }

  async function reloadAfterConfigWrite(res: Response): Promise<void> {
    if (!registry) {
      res.status(501).json({ success: false, error: 'MCP reload is not configured for this server instance' });
      return;
    }
    try {
      const result = await reloadMcpConfiguration(mcpManager, registry);
      onReloaded?.(result);
      await mcpManager.whenReady();
      res.json({
        success: result.ok,
        readyServers: result.readyServers,
        totalTools: result.toolCount,
        registeredCount: result.registeredCount ?? 0,
        error: result.errorMessage ?? null,
        servers: mapMcpServers(),
        configPath: configPath(),
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
    await reloadAfterConfigWrite(res);
  });

  router.get('/servers/:name/config', async (req: Request, res: Response): Promise<void> => {
    const name = String(req.params.name);
    try {
      const serverConfig = await getMcpServerConfig(configPath(), name);
      res.json({ success: true, name, config: serverConfig, configPath: configPath() });
    } catch (err) {
      res.status(404).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.put('/servers/:name/config', async (req: Request, res: Response): Promise<void> => {
    const name = String(req.params.name);
    try {
      const serverConfig = validateMcpServerConfig(req.body?.config ?? req.body);
      await updateMcpServerConfig(configPath(), name, serverConfig);
      await reloadAfterConfigWrite(res);
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post('/servers', async (req: Request, res: Response): Promise<void> => {
    const name = String(req.body?.name ?? '').trim();
    try {
      const serverConfig = validateMcpServerConfig(req.body?.config ?? {});
      await addMcpServerConfig(configPath(), name, serverConfig);
      await reloadAfterConfigWrite(res);
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.delete('/servers/:name', async (req: Request, res: Response): Promise<void> => {
    const name = String(req.params.name);
    try {
      await removeMcpServerConfig(configPath(), name);
      await reloadAfterConfigWrite(res);
    } catch (err) {
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      await mcpManager.whenReady();
      const servers = mapMcpServers();
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
