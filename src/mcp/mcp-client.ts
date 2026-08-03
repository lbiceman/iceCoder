/**
 * MCP Client — 通过 stdio 与单个 MCP Server 通信。
 *
 * 实现 MCP 协议的客户端侧：
 * 1. 启动子进程（stdio 传输）
 * 2. JSON-RPC 2.0 消息收发
 * 3. 自动探测 MCP 2026-07-28 无状态协议，并兼容旧 initialize 握手
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
import { resolveMcpServerLaunch } from './resolve-mcp-command.js';
import type {
  MCPServerConfig,
  MCPDiscoverResult,
  MCPProtocolMode,
  MCPToolDefinition,
  MCPToolResult,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 60_000;
const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
const LEGACY_PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'ice-coder', version: '1.0.0' } as const;

/** 现代协议探测需快速失败，避免旧 Server 忽略未知请求时长时间阻塞启动。 */
const DISCOVER_TIMEOUT = (() => {
  const raw = process.env.ICE_MCP_DISCOVER_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 3_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 250 ? n : 3_000;
})();

/** 初始化超时（毫秒）；Puppeteer 等首次 npx 拉包可能较慢，可由 ICE_MCP_INIT_TIMEOUT_MS 覆盖 */
const INIT_TIMEOUT = (() => {
  const raw = process.env.ICE_MCP_INIT_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 120_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 15_000 ? n : 120_000;
})();

class MCPRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`MCP error [${code}]: ${message}`);
    this.name = 'MCPRequestError';
  }
}

/** 2026-07-28 规范定义的现代协议专用错误；收到任一项都不能回退 legacy。 */
function isRecognizedModernError(err: unknown): err is MCPRequestError {
  return err instanceof MCPRequestError
    && (err.code === -32020 || err.code === -32021 || err.code === -32022);
}

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
  private protocolMode: MCPProtocolMode = 'legacy';
  private negotiatedVersion = LEGACY_PROTOCOL_VERSION;

  constructor(serverName: string, config: MCPServerConfig) {
    this.serverName = serverName;
    this.config = config;
  }

  /** 启动 MCP Server 进程并完成现代协议探测或旧协议握手。 */
  async start(): Promise<void> {
    const plan = resolveMcpServerLaunch(this.config);

    if (plan.launchMode === 'bundled') {
      console.log(`[mcp:${this.serverName}] 使用安装包内 MCP 模块启动（免 npx）`);
    }

    this.process = spawn(plan.command, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: plan.env,
      cwd: plan.cwd,
      shell: process.platform === 'win32' && plan.launchMode === 'npx',
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

    await this.negotiateProtocol();
  }

  /**
   * 优先用 server/discover 探测现代协议；非现代错误或短超时按规范回退旧握手。
   * UnsupportedProtocolVersionError 是明确的现代响应，绝不能回退 initialize。
   */
  private async negotiateProtocol(): Promise<void> {
    const preferredVersion = MODERN_PROTOCOL_VERSIONS[0];
    let discoveryResult: MCPDiscoverResult;

    try {
      discoveryResult = await this.sendRequest(
        'server/discover',
        {},
        DISCOVER_TIMEOUT,
        preferredVersion,
      ) as MCPDiscoverResult;
    } catch (err) {
      if (err instanceof MCPRequestError && err.code === -32022) {
        const supported = this.readSupportedVersions(err.data);
        const selected = this.selectModernVersion(supported);
        if (!selected) {
          throw new Error(
            `MCP server ${this.serverName} 是现代协议服务器，但不支持客户端版本 ${MODERN_PROTOCOL_VERSIONS.join(', ')}`
            + (supported.length > 0 ? `；服务器支持: ${supported.join(', ')}` : ''),
          );
        }

        const result = await this.sendRequest(
          'server/discover',
          {},
          DISCOVER_TIMEOUT,
          selected,
        ) as MCPDiscoverResult;
        this.activateModernProtocol(result, selected);
        return;
      }

      if (isRecognizedModernError(err)) {
        throw new Error(
          `MCP server ${this.serverName} 返回现代协议错误，不能回退 legacy: ${err.message}`,
          { cause: err },
        );
      }

      console.log(
        `[mcp:${this.serverName}] 未检测到现代协议，回退 legacy initialize`
        + ` (${err instanceof Error ? err.message : String(err)})`,
      );
      await this.initializeLegacy();
      return;
    }

    // 能返回 server/discover 成功结果的服务器已经明确属于现代代际；
    // 结果结构或版本不兼容时应直接报错，不能误回退 initialize。
    this.activateModernProtocol(discoveryResult);
  }

  private activateModernProtocol(result: MCPDiscoverResult, requestedVersion?: string): void {
    this.assertModernResultType('server/discover', result, ['complete']);
    const supported = Array.isArray(result?.supportedVersions)
      ? result.supportedVersions.filter((version): version is string => typeof version === 'string')
      : [];
    const selected = this.selectModernVersion(supported)
      ?? (requestedVersion && supported.includes(requestedVersion) ? requestedVersion : undefined);

    if (!selected) {
      throw new Error(
        `MCP server ${this.serverName} 的 server/discover 未返回共同支持的现代协议版本`
        + (supported.length > 0 ? `（服务器支持: ${supported.join(', ')}）` : ''),
      );
    }

    this.protocolMode = 'modern';
    this.negotiatedVersion = selected;
    this._ready = true;
    console.log(`[mcp:${this.serverName}] 协议: modern (${selected})`);
  }

  private selectModernVersion(supported: string[]): string | undefined {
    return MODERN_PROTOCOL_VERSIONS.find((version) => supported.includes(version));
  }

  private readSupportedVersions(data: unknown): string[] {
    if (!data || typeof data !== 'object') return [];
    const supported = (data as { supported?: unknown }).supported;
    return Array.isArray(supported)
      ? supported.filter((version): version is string => typeof version === 'string')
      : [];
  }

  /** 旧版 MCP initialize 握手。 */
  private async initializeLegacy(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, INIT_TIMEOUT);

    // 发送 initialized 通知
    this.sendNotification('notifications/initialized', {});

    this.protocolMode = 'legacy';
    this.negotiatedVersion = result?.protocolVersion || LEGACY_PROTOCOL_VERSION;
    this._ready = true;
    console.log(`[mcp:${this.serverName}] 协议: legacy (${this.negotiatedVersion})`);
  }

  /**
   * 获取服务器提供的工具列表。
   */
  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.sendRequest('tools/list', {});
    if (this.protocolMode === 'modern') {
      this.assertModernResultType('tools/list', result, ['complete']);
    }
    this.tools = result?.tools || [];
    console.log(`[mcp:${this.serverName}] 发现 ${this.tools.length} 个工具`);
    return this.tools;
  }

  /**
   * 调用 MCP 工具。
   *
   * 部分 MCP Server（如 Puppeteer）会把工具执行失败当作 JSON-RPC error 返回，
   * 而非 result.isError；此处转为 MCPToolResult，避免 Manager 误判为服务器故障。
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<MCPToolResult> {
    try {
      const result = await this.sendRequest('tools/call', {
        name: toolName,
        arguments: args,
      });

      if (this.protocolMode === 'modern') {
        this.assertModernResultType('tools/call', result, ['complete', 'input_required']);
      }
      if (this.protocolMode === 'modern' && result?.resultType === 'input_required') {
        return {
          content: [{
            type: 'text',
            text: '该 MCP 工具要求 Multi Round-Trip Request (input_required)，当前 iceCoder 尚未支持 MRTR。',
          }],
          isError: true,
        };
      }
      return result as MCPToolResult;
    } catch (err) {
      // 协议版本失配属于连接级兼容故障，不能伪装成普通工具执行错误。
      if (err instanceof MCPRequestError && err.code === -32022) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('MCP error [')) {
        return {
          content: [{ type: 'text', text: message }],
          isError: true,
        };
      }
      throw err;
    }
  }

  private assertModernResultType(
    method: string,
    result: unknown,
    allowed: readonly string[],
  ): asserts result is Record<string, any> {
    const resultType = result && typeof result === 'object'
      ? (result as { resultType?: unknown }).resultType
      : undefined;
    if (typeof resultType !== 'string' || !allowed.includes(resultType)) {
      throw new Error(
        `MCP server ${this.serverName} 的 ${method} 返回无效 resultType: ${String(resultType)}`,
      );
    }
  }

  /**
   * 发送 JSON-RPC 请求并等待响应。
   *
   * 发送格式：裸 JSON + 换行符（大多数 MCP Server 使用此格式）。
   */
  private sendRequest(
    method: string,
    params: Record<string, any>,
    timeout = REQUEST_TIMEOUT,
    forceModernVersion?: string,
  ): Promise<any> {
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
        params: this.withRequestMetadata(params, forceModernVersion),
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

  /** 为现代协议请求合并必需元数据；调用方已有的非保留 _meta 字段会被保留。 */
  private withRequestMetadata(params: Record<string, any>, forceModernVersion?: string): Record<string, any> {
    const version = forceModernVersion
      ?? (this.protocolMode === 'modern' ? this.negotiatedVersion : undefined);
    if (!version) return params;

    const existingMeta = params._meta && typeof params._meta === 'object'
      ? params._meta as Record<string, any>
      : {};

    return {
      ...params,
      _meta: {
        ...existingMeta,
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    };
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

      // 响应消息（有 id）— 服务端可能以 number 或十进制 string 回显
      if (msg.id !== undefined && msg.id !== null) {
        const idNum = typeof msg.id === 'number'
          ? msg.id
          : typeof msg.id === 'string' && /^\d+$/.test(msg.id)
            ? Number.parseInt(msg.id, 10)
            : NaN;
        const pending = Number.isFinite(idNum) ? this.pendingRequests.get(idNum) : undefined;
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(idNum);

          if (msg.error) {
            pending.reject(new MCPRequestError(msg.error.code, msg.error.message, msg.error.data));
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
      const child = this.process;

      // stdio 规范以关闭 stdin/EOF 作为首选的可移植优雅退出信号。
      // notifications/cancelled 只能引用仍在执行的 requestId，不能用空参数代替 shutdown。
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          resolve();
        };
        const termTimer = setTimeout(() => {
          if (!settled) {
            child.kill('SIGTERM');
          }
        }, 500);
        const killTimer = setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
            finish();
          }
        }, 5000);

        child.once('exit', finish);

        if (typeof child.exitCode === 'number' || child.signalCode != null) {
          finish();
          return;
        }

        try {
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.end();
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          child.kill('SIGTERM');
        }
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
