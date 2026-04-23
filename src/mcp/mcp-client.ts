/**
 * MCP Client — 通过 stdio 与单个 MCP Server 通信。
 *
 * 实现 MCP 协议的客户端侧：
 * 1. 启动子进程（stdio 传输）
 * 2. JSON-RPC 2.0 消息收发
 * 3. initialize 握手
 * 4. tools/list 获取工具列表
 * 5. tools/call 调用工具
 *
 * 传输格式：
 * - 发送：JSON + 换行符（\n）
 * - 接收：自动检测 Content-Length 分帧 或 裸 JSON 行
 *   大多数 MCP Server 使用裸 JSON 行格式（每行一个 JSON-RPC 消息）
 *
 * 参考 MCP 规范：https://modelcontextprotocol.io/specification
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type {
  MCPServerConfig,
  MCPToolDefinition,
  MCPToolResult,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 60_000;

/** 初始化超时（毫秒） */
const INIT_TIMEOUT = 30_000;

/**
 * 单个 MCP Server 的客户端连接。
 */
export class MCPClient {
  private serverName: string;
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number | string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private buffer = '';
  private _ready = false;
  private tools: MCPToolDefinition[] = [];

  constructor(serverName: string, config: MCPServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  /**
   * 启动 MCP Server 进程并完成初始化握手。
   */
  async start(): Promise<void> {
    const { command, args = [], env = {} } = this.config;

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    // 监听 stdout（JSON-RPC 消息）
    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.handleData(chunk.toString());
    });

    // 监听 stderr（日志，不处理）
    this.process.stderr!.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.log(`[mcp:${this.serverName}:stderr] ${msg.substring(0, 200)}`);
      }
    });

    // 监听进程退出
    this.process.on('exit', (code, signal) => {
      console.log(`[mcp:${this.serverName}] 进程退出 code=${code} signal=${signal}`);
      this._ready = false;
      // 拒绝所有待处理请求
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server ${this.serverName} 进程退出`));
      }
      this.pendingRequests.clear();
    });

    this.process.on('error', (err) => {
      console.error(`[mcp:${this.serverName}] 进程错误:`, err.message);
    });

    // 执行 initialize 握手
    await this.initialize();
  }

  /**
   * MCP initialize 握手。
   */
  private async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'ice-coder',
        version: '1.0.0',
      },
    }, INIT_TIMEOUT);

    // 发送 initialized 通知
    this.sendNotification('notifications/initialized', {});

    this._ready = true;
    console.log(`[mcp:${this.serverName}] 初始化成功, 协议版本: ${result?.protocolVersion || 'unknown'}`);
  }

  /**
   * 获取服务器提供的工具列表。
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.sendRequest('tools/list', {});
    this.tools = result?.tools || [];
    console.log(`[mcp:${this.serverName}] 发现 ${this.tools.length} 个工具`);
    return this.tools;
  }

  /**
   * 调用 MCP 工具。
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<MCPToolResult> {
    const result = await this.sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });
    return result as MCPToolResult;
  }

  /**
   * 发送 JSON-RPC 请求并等待响应。
   *
   * 发送格式：裸 JSON + 换行符（大多数 MCP Server 使用此格式）。
   */
  private sendRequest(method: string, params: Record<string, any>, timeout = REQUEST_TIMEOUT): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        reject(new Error(`MCP server ${this.serverName} 未启动`));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP server ${this.serverName} 请求超时: ${method} (${timeout}ms)`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      // 裸 JSON + 换行符（MCP stdio 标准格式）
      const message = JSON.stringify(request) + '\n';

      this.process.stdin!.write(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error(`MCP server ${this.serverName} 写入失败: ${err.message}`));
        }
      });
    });
  }

  /**
   * 发送 JSON-RPC 通知（无需响应）。
   */
  private sendNotification(method: string, params: Record<string, any>): void {
    if (!this.process || !this.process.stdin) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const message = JSON.stringify(notification) + '\n';
    this.process.stdin!.write(message);
  }

  /**
   * 处理从 stdout 接收的数据。
   *
   * 支持两种格式：
   * 1. Content-Length 分帧（LSP 风格）
   * 2. 裸 JSON 行（每行一个 JSON 对象，大多数 MCP Server 使用此格式）
   */
  private handleData(data: string): void {
    this.buffer += data;
    this.processBuffer();
  }

  /**
   * 处理缓冲区中的消息。
   */
  private processBuffer(): void {
    while (this.buffer.length > 0) {
      // 跳过前导空白和换行
      const trimmedStart = this.buffer.search(/\S/);
      if (trimmedStart === -1) {
        this.buffer = '';
        return;
      }
      if (trimmedStart > 0) {
        this.buffer = this.buffer.substring(trimmedStart);
      }

      // 检测格式：Content-Length 头 或 裸 JSON
      if (this.buffer.startsWith('Content-Length:')) {
        // LSP 风格分帧
        if (!this.tryParseContentLength()) return;
      } else if (this.buffer.startsWith('{')) {
        // 裸 JSON 行
        if (!this.tryParseJsonLine()) return;
      } else {
        // 未知内容，跳到下一个 { 或 Content-Length
        const nextJson = this.buffer.indexOf('{', 1);
        const nextHeader = this.buffer.indexOf('Content-Length:', 1);

        let skipTo = -1;
        if (nextJson !== -1 && nextHeader !== -1) {
          skipTo = Math.min(nextJson, nextHeader);
        } else if (nextJson !== -1) {
          skipTo = nextJson;
        } else if (nextHeader !== -1) {
          skipTo = nextHeader;
        }

        if (skipTo === -1) {
          // 没有可识别的内容，清空缓冲区
          this.buffer = '';
          return;
        }
        this.buffer = this.buffer.substring(skipTo);
      }
    }
  }

  /**
   * 尝试解析 Content-Length 分帧的消息。
   * 返回 true 表示成功解析了一条消息，false 表示数据不完整需要等待。
   */
  private tryParseContentLength(): boolean {
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return false;

    const header = this.buffer.substring(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // 无效头，跳过这一行
      this.buffer = this.buffer.substring(headerEnd + 4);
      return true;
    }

    const contentLength = parseInt(match[1]);
    const bodyStart = headerEnd + 4;

    if (this.buffer.length < bodyStart + contentLength) {
      return false; // 消息体不完整
    }

    const body = this.buffer.substring(bodyStart, bodyStart + contentLength);
    this.buffer = this.buffer.substring(bodyStart + contentLength);
    this.handleMessage(body);
    return true;
  }

  /**
   * 尝试解析裸 JSON 行。
   * 使用括号匹配找到完整的 JSON 对象。
   * 返回 true 表示成功解析了一条消息，false 表示数据不完整需要等待。
   */
  private tryParseJsonLine(): boolean {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }

      if (ch === '"' && !escape) {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = this.buffer.substring(0, i + 1);
          this.buffer = this.buffer.substring(i + 1);
          this.handleMessage(jsonStr);
          return true;
        }
      }
    }

    // JSON 对象不完整，等待更多数据
    return false;
  }

  /**
   * 处理单条 JSON-RPC 消息。
   */
  private handleMessage(body: string): void {
    try {
      const msg = JSON.parse(body) as JsonRpcResponse;

      // 响应消息（有 id）
      if (msg.id !== undefined && msg.id !== null) {
        const pending = this.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.id);

          if (msg.error) {
            pending.reject(new Error(`MCP error [${msg.error.code}]: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
      // 通知消息（无 id）— 目前忽略
    } catch (err) {
      console.error(`[mcp:${this.serverName}] JSON 解析失败:`, body.substring(0, 200));
    }
  }

  /**
   * 停止 MCP Server 进程。
   */
  async stop(): Promise<void> {
    this._ready = false;

    if (this.process) {
      // 先尝试优雅关闭
      try {
        this.sendNotification('notifications/cancelled', {});
      } catch { /* ignore */ }

      this.process.kill('SIGTERM');

      // 等待进程退出，超时后强制杀死
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.process!.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      this.process = null;
    }

    // 清理待处理请求
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP client stopped'));
    }
    this.pendingRequests.clear();
  }

  get isReady(): boolean {
    return this._ready;
  }

  get name(): string {
    return this.serverName;
  }

  get cachedTools(): MCPToolDefinition[] {
    return this.tools;
  }
}
