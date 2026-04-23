/**
 * MCP (Model Context Protocol) 类型定义。
 * 定义 MCP 服务器配置、JSON-RPC 消息格式、工具定义等。
 */

/**
 * MCP 服务器配置（与 Kiro/Claude 的 mcp.json 格式兼容）。
 */
export interface MCPServerConfig {
  /** 启动命令（如 npx, uvx, node） */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 是否禁用 */
  disabled?: boolean;
  /** 自动批准的工具列表（不需要确认） */
  autoApprove?: string[];
}

/**
 * MCP 配置文件格式。
 */
export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * JSON-RPC 2.0 请求。
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, any>;
}

/**
 * JSON-RPC 2.0 响应。
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * JSON-RPC 2.0 通知（无 id）。
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, any>;
}

/**
 * MCP 工具定义（服务器返回的格式）。
 */
export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
}

/**
 * MCP 工具调用结果。
 */
export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * MCP 服务器运行时状态。
 */
export type MCPServerStatus = 'starting' | 'ready' | 'error' | 'stopped';

/**
 * MCP 服务器运行时信息。
 */
export interface MCPServerInfo {
  name: string;
  config: MCPServerConfig;
  status: MCPServerStatus;
  tools: MCPToolDefinition[];
  error?: string;
}
