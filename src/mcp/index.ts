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
