/**
 * MCP Manager — 管理多个 MCP Server 连接。
 *
 * 职责：
 * 1. 从配置文件加载 MCP Server 配置
 * 2. 启动/停止 MCP Server 进程
 * 3. 将 MCP 工具转换为 ice-coder 的 RegisteredTool 格式
 * 4. 注册到 ToolRegistry，让 LLM 可以调用
 * 5. 提供运行时状态查询
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MCPClient } from './mcp-client.js';
import type {
  MCPConfig,
  MCPServerConfig,
  MCPServerInfo,
  MCPServerStatus,
  MCPToolDefinition,
} from './types.js';
import type { RegisteredTool, ToolResult } from '../tools/types.js';

/**
 * MCP Manager 配置。
 */
export interface MCPManagerOptions {
  /** 配置文件路径（默认 data/config.json） */
  configPath?: string;
}

/**
 * 单个 MCP Server 的运行时记录。
 */
interface ServerRecord {
  name: string;
  config: MCPServerConfig;
  client: MCPClient;
  status: MCPServerStatus;
  tools: MCPToolDefinition[];
  error?: string;
}

/**
 * MCP Manager — 管理所有 MCP Server 的生命周期和工具注册。
 */
export class MCPManager {
  private servers = new Map<string, ServerRecord>();
  private configPath: string;

  constructor(options?: MCPManagerOptions) {
    this.configPath = options?.configPath ?? path.resolve('data/config.json');
  }

  /**
   * 从配置文件加载 MCP Server 配置并启动所有已启用的服务器。
   */
  async initialize(): Promise<void> {
    const mcpConfig = await this.loadMCPConfig();

    if (!mcpConfig || Object.keys(mcpConfig).length === 0) {
      console.log('[mcp-manager] 未找到 MCP 服务器配置');
      return;
    }

    console.log(`[mcp-manager] 发现 ${Object.keys(mcpConfig).length} 个 MCP 服务器配置`);

    // 并行启动所有已启用的服务器
    const startPromises: Promise<void>[] = [];

    for (const [name, config] of Object.entries(mcpConfig)) {
      if (config.disabled) {
        console.log(`[mcp-manager] 跳过已禁用的服务器: ${name}`);
        continue;
      }
      startPromises.push(this.startServer(name, config));
    }

    await Promise.allSettled(startPromises);

    const readyCount = Array.from(this.servers.values()).filter((s) => s.status === 'ready').length;
    const totalTools = Array.from(this.servers.values()).reduce((sum, s) => sum + s.tools.length, 0);
    console.log(`[mcp-manager] 初始化完成: ${readyCount} 个服务器就绪, 共 ${totalTools} 个 MCP 工具`);
  }

  /**
   * 启动单个 MCP Server。
   */
  private async startServer(name: string, config: MCPServerConfig): Promise<void> {
    const client = new MCPClient(name, config);
    const record: ServerRecord = {
      name,
      config,
      client,
      status: 'starting',
      tools: [],
    };
    this.servers.set(name, record);

    try {
      await client.start();
      record.status = 'ready';

      // 获取工具列表
      const tools = await client.listTools();
      record.tools = tools;

      console.log(`[mcp-manager] 服务器 ${name} 就绪, ${tools.length} 个工具`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.status = 'error';
      record.error = message;
      console.error(`[mcp-manager] 服务器 ${name} 启动失败: ${message}`);
    }
  }

  /**
   * 从配置文件加载 MCP 配置。
   */
  private async loadMCPConfig(): Promise<Record<string, MCPServerConfig> | null> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const config = JSON.parse(data) as { mcpServers?: Record<string, MCPServerConfig> };
      return config.mcpServers ?? null;
    } catch (err) {
      console.error(`[mcp-manager] 加载配置失败: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * 将所有 MCP 工具转换为 ice-coder 的 RegisteredTool 格式。
   * 工具名称格式: mcp_{serverName}_{toolName}
   */
  getRegisteredTools(): RegisteredTool[] {
    const tools: RegisteredTool[] = [];

    for (const [serverName, record] of this.servers) {
      if (record.status !== 'ready') continue;

      for (const mcpTool of record.tools) {
        const fullName = `mcp_${serverName}_${mcpTool.name}`;

        tools.push({
          definition: {
            name: fullName,
            description: `[MCP:${serverName}] ${mcpTool.description || mcpTool.name}`,
            parameters: mcpTool.inputSchema || { type: 'object', properties: {}, required: [] },
          },
          handler: this.createToolHandler(serverName, mcpTool.name),
        });
      }
    }

    return tools;
  }

  /**
   * 创建 MCP 工具的处理器函数。
   */
  private createToolHandler(serverName: string, toolName: string): (args: Record<string, any>) => Promise<ToolResult> {
    return async (args: Record<string, any>): Promise<ToolResult> => {
      const record = this.servers.get(serverName);
      if (!record || record.status !== 'ready') {
        return {
          success: false,
          output: '',
          error: `MCP 服务器 ${serverName} 不可用 (状态: ${record?.status ?? 'unknown'})`,
        };
      }

      try {
        const result = await record.client.callTool(toolName, args);

        // 将 MCP 结果转换为 ice-coder 的 ToolResult
        const textParts = (result.content || [])
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!);

        const output = textParts.join('\n') || '(无文本输出)';

        return {
          success: !result.isError,
          output,
          error: result.isError ? output : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: '',
          error: `MCP 工具调用失败 [${serverName}/${toolName}]: ${message}`,
        };
      }
    };
  }

  /**
   * 获取所有 MCP Server 的运行时状态。
   */
  getServerInfos(): MCPServerInfo[] {
    return Array.from(this.servers.values()).map((record) => ({
      name: record.name,
      config: record.config,
      status: record.status,
      tools: record.tools,
      error: record.error,
    }));
  }

  /**
   * 获取所有可用的 MCP 工具数量。
   */
  get totalTools(): number {
    return Array.from(this.servers.values()).reduce((sum, s) => sum + s.tools.length, 0);
  }

  /**
   * 获取就绪的服务器数量。
   */
  get readyServers(): number {
    return Array.from(this.servers.values()).filter((s) => s.status === 'ready').length;
  }

  /**
   * 重启指定的 MCP Server。
   */
  async restartServer(name: string): Promise<void> {
    const record = this.servers.get(name);
    if (!record) {
      throw new Error(`MCP 服务器 ${name} 不存在`);
    }

    // 停止旧进程
    await record.client.stop();

    // 重新启动
    await this.startServer(name, record.config);
  }

  /**
   * 停止所有 MCP Server。
   */
  async shutdown(): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    for (const [name, record] of this.servers) {
      console.log(`[mcp-manager] 停止服务器: ${name}`);
      stopPromises.push(
        record.client.stop().catch((err) => {
          console.error(`[mcp-manager] 停止 ${name} 失败:`, err);
        }),
      );
    }

    await Promise.allSettled(stopPromises);
    this.servers.clear();
    console.log('[mcp-manager] 所有 MCP 服务器已停止');
  }
}
