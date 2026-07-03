/**
 * MCP 模块入口。
 */

export { MCPClient } from './mcp-client.js';
export { MCPManager } from './mcp-manager.js';
export type { MCPManagerOptions } from './mcp-manager.js';
export type {
  MCPServerConfig,
  MCPConfig,
  MCPToolDefinition,
  MCPToolResult,
  MCPServerInfo,
  MCPServerStatus,
} from './types.js';
export { startMcpBackgroundInit } from './start-mcp-background.js';
export type { McpBackgroundSettled } from './start-mcp-background.js';
export {
  reloadMcpConfiguration,
  syncMcpToolsOnRegistry,
  watchMcpConfigChanges,
  MCP_CONFIG_WATCH_INTERVAL_MS,
  MCP_CONFIG_RELOAD_DEBOUNCE_MS,
} from './reload-mcp-config.js';
export type { WatchMcpConfigOptions } from './reload-mcp-config.js';
export {
  setMcpServerDisabled,
  suppressMcpConfigWatch,
  isMcpConfigWatchSuppressed,
  MCP_CONFIG_PERSIST_SUPPRESS_MS,
} from './persist-mcp-config.js';
