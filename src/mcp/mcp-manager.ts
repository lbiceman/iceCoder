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
import { MCPClient } from './mcp-client.js';
import type {
  MCPServerConfig,
  MCPServerInfo,
  MCPServerStatus,
  MCPToolDefinition,
} from './types.js';
import type { RegisteredTool, ToolResult } from '../tools/types.js';
import { resolveMcpConfigPath } from '../cli/paths.js';
import { formatMcpToolResult } from './mcp-result-formatter.js';
import { setMcpServerDisabled } from './persist-mcp-config.js';

/**
 * MCP Manager 配置。
 */
export interface MCPManagerOptions {
  /**
   * MCP 专用 JSON 路径（默认可通过 ICE_MCP_CONFIG_PATH 或 `.iceCoder/mcp.json` 解析）。
   */
  mcpConfigPath?: string;
}

/**
 * 单个 MCP Server 的运行时记录。
 */
interface ServerRecord {
  name: string;
  config: MCPServerConfig;
  /** 未启动的项（如 config.disabled）为 null */
  client: MCPClient | null;
  status: MCPServerStatus;
  tools: MCPToolDefinition[];
  error?: string;
}

/**
 * MCP Manager — 管理所有 MCP Server 的生命周期和工具注册。
 */
export class MCPManager {
  private servers = new Map<string, ServerRecord>();
  private readonly mcpConfigPath: string;
  private initPromise: Promise<void> | null = null;
  private reloadPromise: Promise<void> | null = null;

  constructor(options?: MCPManagerOptions) {
    this.mcpConfigPath = options?.mcpConfigPath ?? resolveMcpConfigPath();
  }

  /**
   * 等待 MCP 后台初始化完成（幂等；聊天/run 在注册工具前应 await，避免只拿到部分 MCP 工具）。
   */
  whenReady(): Promise<void> {
    return this.initialize();
  }

  /**
   * 从配置文件加载 MCP Server 配置并启动所有已启用的服务器。
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const mcpConfig = await this.loadMCPConfig();

    if (!mcpConfig || Object.keys(mcpConfig).length === 0) {
      console.warn(
        `[mcp-manager] 未找到可用的 MCP 配置：请在 ${this.mcpConfigPath} 中设置 mcpServers（可参考仓库内 .iceCoder/mcp.example.json），或将需启用的条目的 disabled 设为 false。也可用环境变量 ICE_MCP_CONFIG_PATH 指定路径。`,
      );
      return;
    }

    console.log(`[mcp-manager] 发现 ${Object.keys(mcpConfig).length} 个 MCP 服务器配置项`);

    // 并行启动所有已启用的服务器（禁用的仅登记状态，便于 iceCoder mcp 展示）
    const startPromises: Promise<void>[] = [];

    for (const [name, config] of Object.entries(mcpConfig)) {
      if (config.disabled) {
        this.servers.set(name, {
          name,
          config,
          client: null,
          status: 'disabled',
          tools: [],
        });
        console.log(`[mcp-manager] 已注册（未启动）禁用的服务器: ${name}`);
        continue;
      }
      startPromises.push(this.startServer(name, config));
    }

    await Promise.allSettled(startPromises);

    const readyCount = Array.from(this.servers.values()).filter((s) => s.status === 'ready').length;
    const totalTools = Array.from(this.servers.values()).reduce((sum, s) => sum + s.tools.length, 0);
    console.log(`[mcp-manager] 初始化完成: ${readyCount} 个服务器就绪, 共 ${totalTools} 个 MCP 工具`);
    if (readyCount === 0 && this.servers.size > 0) {
      console.log(
        '[mcp-manager] 当前没有可注册的 MCP 工具：若配置中均为 disabled，请将需要的服务器改为 "disabled": false；若启动失败请检查本机 npx/uvx 是否可用（Windows 上需已安装 Node 且 PATH 中有 npx.cmd）。',
      );
    }
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
      // 防止僵尸进程：spawn 可能已成功但 initialize()/listTools() 失败，
      // 此时子进程仍在运行，必须显式 stop() 回收（stop 对未 spawn 的情况是安全空操作）。
      try {
        await client.stop();
      } catch (stopErr) {
        console.error(
          `[mcp-manager] 服务器 ${name} 启动失败后清理子进程出错: ${stopErr instanceof Error ? stopErr.message : stopErr}`,
        );
      }
    }
  }

  /**
   * 从配置文件加载 MCP 配置。
   */
  private async loadMCPConfig(): Promise<Record<string, MCPServerConfig> | null> {
    try {
      const data = await fs.readFile(this.mcpConfigPath, 'utf-8');
      const config = JSON.parse(data) as { mcpServers?: Record<string, MCPServerConfig> };
      return config.mcpServers ?? null;
    } catch (err) {
      console.error(
        `[mcp-manager] 加载 MCP 配置失败 (${this.mcpConfigPath}): ${err instanceof Error ? err.message : err}`,
      );
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
      // 进程仍存活但曾被工具级 JSON-RPC 错误误标为 error 时自动恢复
      if (record.status === 'error' && record.client?.isReady) {
        record.status = 'ready';
        record.error = undefined;
      }
      if (record.status !== 'ready') continue;

      for (const mcpTool of record.tools) {
        const fullName = `mcp_${serverName}_${mcpTool.name}`;
        const baseDescription = mcpTool.description || mcpTool.name;
        const screenshotNote = /screenshot/i.test(mcpTool.name)
          ? ' Screenshots are returned as in-memory image data (not workspace files); after capture, use the saved path from the tool result with image_read — do not guess paths like {name}.png in the project root.'
          : '';

        tools.push({
          definition: {
            name: fullName,
            description: `[MCP:${serverName}] ${baseDescription}${screenshotNote}`,
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
  private async ensureServerReady(serverName: string): Promise<ServerRecord | null> {
    let record = this.servers.get(serverName);
    if (record?.status === 'ready' && record.client) return record;
    if (record?.status === 'disabled') return record;

    console.warn(
      `[mcp-manager] 服务器 ${serverName} 当前不可用 (状态: ${record?.status ?? 'unknown'})，尝试重启…`,
    );
    try {
      await this.restartServer(serverName);
    } catch (err) {
      console.error(
        `[mcp-manager] 重启 ${serverName} 失败:`,
        err instanceof Error ? err.message : err,
      );
    }
    return this.servers.get(serverName) ?? null;
  }

  private createToolHandler(serverName: string, toolName: string): (args: Record<string, any>) => Promise<ToolResult> {
    return async (args: Record<string, any>): Promise<ToolResult> => {
      const record = await this.ensureServerReady(serverName);
      if (!record || record.status !== 'ready' || !record.client) {
        const detail = record?.error ? `: ${record.error}` : '';
        return {
          success: false,
          output: '',
          error: `MCP 服务器 ${serverName} 不可用 (状态: ${record?.status ?? 'unknown'}${detail})。请检查 ~/.iceCoder/mcp.json 或在终端运行 iceCoder mcp 查看详情。`,
        };
      }

      try {
        const result = await record.client.callTool(toolName, args);
        const formatted = await formatMcpToolResult(result);

        return {
          success: !result.isError,
          output: formatted.output,
          error: result.isError ? formatted.output : undefined,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 仅传输/进程级故障才降级 server 状态；工具级 JSON-RPC 错误已在 callTool 转为 isError
        record.status = 'error';
        record.error = message;
        return {
          success: false,
          output: '',
          error: `MCP 工具调用失败 [${serverName}/${toolName}]: ${message}`,
        };
      }
    };
  }

  /**
   * MCP 配置文件路径（只读）。
   */
  getConfigPath(): string {
    return this.mcpConfigPath;
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
   * 手动停止指定的 MCP Server，并将 disabled: true 写回 mcp.json。
   */
  async stopServer(name: string): Promise<void> {
    const record = this.servers.get(name);
    if (!record) {
      throw new Error(`MCP 服务器 ${name} 不存在`);
    }
    if (record.status === 'disabled') {
      return;
    }

    if (record.client) {
      await record.client.stop();
      record.client = null;
    }

    await setMcpServerDisabled(this.mcpConfigPath, name, true);
    record.config.disabled = true;
    record.status = 'disabled';
    record.tools = [];
    record.error = undefined;
    console.log(`[mcp-manager] 服务器 ${name} 已停止（disabled: true 已写入配置）`);
  }

  /**
   * 启动已停止/禁用的 MCP Server，并将 disabled: false 写回 mcp.json。
   */
  async startServerByName(name: string): Promise<void> {
    const record = this.servers.get(name);
    if (!record) {
      throw new Error(`MCP 服务器 ${name} 不存在`);
    }

    await setMcpServerDisabled(this.mcpConfigPath, name, false);
    record.config.disabled = false;

    if (record.client) {
      await record.client.stop();
      record.client = null;
    }

    await this.startServer(name, record.config);
  }

  /**
   * 重启指定的 MCP Server（运行中；不修改 disabled 配置）。
   */
  async restartServer(name: string): Promise<void> {
    const record = this.servers.get(name);
    if (!record) {
      throw new Error(`MCP 服务器 ${name} 不存在`);
    }
    if (record.config.disabled || record.status === 'disabled') {
      throw new Error(`MCP 服务器 ${name} 已停止，请使用启动`);
    }

    // 停止旧进程
    if (record.client) {
      await record.client.stop();
      record.client = null;
    }

    // 重新启动
    await this.startServer(name, record.config);
  }

  /**
   * 重新加载 MCP 配置：停止现有进程、重读 mcp.json、再启动。
   * 并发调用会合并为同一次 reload。
   */
  async reload(): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise;
    this.reloadPromise = this.doReload();
    try {
      await this.reloadPromise;
    } finally {
      this.reloadPromise = null;
    }
  }

  private async doReload(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise.catch(() => {});
    }

    const work = (async () => {
      console.log(`[mcp-manager] 重新加载 MCP 配置 (${this.mcpConfigPath})…`);
      await this.stopAllServers();
      this.servers.clear();
      await this.doInitialize();
    })();

    this.initPromise = work;
    await work;
  }

  /**
   * 停止所有 MCP Server。
   */
  async shutdown(): Promise<void> {
    await this.stopAllServers();
    this.servers.clear();
    this.initPromise = null;
    console.log('[mcp-manager] 所有 MCP 服务器已停止');
  }

  private async stopAllServers(): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    for (const [name, record] of this.servers) {
      if (!record.client) continue;
      console.log(`[mcp-manager] 停止服务器: ${name}`);
      stopPromises.push(
        record.client.stop().catch((err) => {
          console.error(`[mcp-manager] 停止 ${name} 失败:`, err);
        }),
      );
    }

    await Promise.allSettled(stopPromises);
  }
}
