/**
 * 后台初始化 MCP：不阻塞 HTTP 监听；完成后将工具注册进 ToolRegistry。
 */

import type { MCPManager } from './mcp-manager.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

/** 将 MCPManager 中已就绪的工具注册到指定 ToolRegistry（可重复调用）。 */
export function registerMcpToolsOnRegistry(registry: ToolRegistry, mcpManager: MCPManager): number {
  const tools = mcpManager.getRegisteredTools();
  for (const tool of tools) {
    registry.register(tool);
  }
  return tools.length;
}

export interface McpBackgroundSettled {
  ok: boolean;
  toolCount: number;
  readyServers: number;
  /** 本次写入 registry 的 MCP 工具数（热重载时由 reload 模块填充） */
  registeredCount?: number;
  errorMessage?: string;
}

/**
 * 异步启动 MCP；完成后可选回调（例如 WebSocket 广播）。
 */
export function startMcpBackgroundInit(
  mcpManager: MCPManager,
  registry: ToolRegistry,
  onSettled?: (result: McpBackgroundSettled) => void,
): void {
  void (async () => {
    try {
      await mcpManager.initialize();
      const count = registerMcpToolsOnRegistry(registry, mcpManager);
      if (count > 0) {
        console.log(`已注册 ${count} 个 MCP 工具到工具系统`);
      }
      onSettled?.({
        ok: true,
        toolCount: mcpManager.totalTools,
        readyServers: mcpManager.readyServers,
      });
    } catch (err) {
      console.error('MCP 初始化失败（不影响核心功能）:', err);
      const message = err instanceof Error ? err.message : String(err);
      onSettled?.({
        ok: false,
        toolCount: 0,
        readyServers: 0,
        errorMessage: message,
      });
    }
  })();
}
