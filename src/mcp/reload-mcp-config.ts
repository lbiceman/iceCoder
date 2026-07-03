/**
 * MCP 配置热重载：重读 mcp.json、同步 ToolRegistry、可选 WebSocket 广播。
 */

import type { MCPManager } from './mcp-manager.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { McpBackgroundSettled } from './start-mcp-background.js';
import { registerMcpToolsOnRegistry } from './start-mcp-background.js';
import { isMcpConfigWatchSuppressed } from './persist-mcp-config.js';

/** watchFile 轮询间隔 */
export const MCP_CONFIG_WATCH_INTERVAL_MS = 10_000;

/**
 * 防抖延迟：MCP 重载需重启子进程，应长于 LLM 配置的 500ms，
 * 避免编辑器保存时的连写/临时文件触发多次 reload。
 */
export const MCP_CONFIG_RELOAD_DEBOUNCE_MS = 1000;

const MCP_TOOL_PREFIX = 'mcp_';

/**
 * 从 registry 移除旧 MCP 工具并注册当前 MCPManager 中的工具。
 */
export function syncMcpToolsOnRegistry(registry: ToolRegistry, mcpManager: MCPManager): number {
  const removed = registry.unregisterByPrefix(MCP_TOOL_PREFIX);
  const added = registerMcpToolsOnRegistry(registry, mcpManager);
  if (removed > 0 || added > 0) {
    console.log(`[mcp-reload] 工具同步: 移除 ${removed} 个, 注册 ${added} 个 MCP 工具`);
  }
  return added;
}

/**
 * 完整热重载：reload MCP 进程 + 同步 registry。
 */
export async function reloadMcpConfiguration(
  mcpManager: MCPManager,
  registry: ToolRegistry,
): Promise<McpBackgroundSettled> {
  try {
    await mcpManager.reload();
    const count = syncMcpToolsOnRegistry(registry, mcpManager);
    return {
      ok: true,
      toolCount: mcpManager.totalTools,
      readyServers: mcpManager.readyServers,
      registeredCount: count,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[mcp-reload] MCP 配置热重载失败:', message);
    return {
      ok: false,
      toolCount: mcpManager.totalTools,
      readyServers: mcpManager.readyServers,
      errorMessage: message,
    };
  }
}

export interface WatchMcpConfigOptions {
  mcpConfigPath: string;
  mcpManager: MCPManager;
  registry: ToolRegistry;
  onReloaded?: (result: McpBackgroundSettled) => void;
}

/**
 * 监视 mcp.json 变化并 debounce 热重载。
 * 返回 cleanup 函数（unwatch）。
 */
export function watchMcpConfigChanges(options: WatchMcpConfigOptions): () => void {
  const { mcpConfigPath, mcpManager, registry, onReloaded } = options;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadInFlight = false;
  let pendingReload = false;

  const scheduleReload = (): void => {
    if (isMcpConfigWatchSuppressed()) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runReload();
    }, MCP_CONFIG_RELOAD_DEBOUNCE_MS);
  };

  const runReload = async (): Promise<void> => {
    if (reloadInFlight) {
      pendingReload = true;
      return;
    }
    reloadInFlight = true;
    try {
      do {
        pendingReload = false;
        const result = await reloadMcpConfiguration(mcpManager, registry);
        onReloaded?.(result);
      } while (pendingReload);
    } finally {
      reloadInFlight = false;
    }
  };

  import('node:fs').then((nodeFs) => {
    nodeFs.watchFile(mcpConfigPath, { interval: MCP_CONFIG_WATCH_INTERVAL_MS }, scheduleReload);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    import('node:fs').then((nodeFs) => {
      nodeFs.unwatchFile(mcpConfigPath);
    });
  };
}
