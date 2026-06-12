/**
 * 后台初始化 MCP：不阻塞 HTTP 监听；完成后将工具注册进 ToolRegistry。
 */

import type { MCPManager } from './mcp-manager.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

export interface McpBackgroundSettled {
  ok: boolean;
  toolCount: number;
  readyServers: number;
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
      const tools = mcpManager.getRegisteredTools();
      for (const tool of tools) {
        registry.register(tool);
      }
      if (tools.length > 0) {
        console.log(`已注册 ${tools.length} 个 MCP 工具到工具系统`);
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
