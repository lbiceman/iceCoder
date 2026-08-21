/**
 * MCP Streamable HTTP 传输（规范 2025-03-26 / 2025-06-18）。
 *
 * POST JSON-RPC 到单一端点；响应可以是 application/json 或 text/event-stream。
 * initialize 成功后若返回 Mcp-Session-Id，后续请求必须带回。
 */

import type { JsonRpcRequest, JsonRpcResponse } from './types.js';
import { normalizeMcpHeaders } from './mcp-transport.js';

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

export interface StreamableHttpSessionOptions {
  url: URL;
  headers?: Record<string, string>;
  serverName: string;
}

function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

/**
 * 从 SSE 缓冲中切出完整事件并解析 data 里的 JSON-RPC。
 * rest 是尚未以空行结束的尾部。
 */
export function consumeSseJsonRpc(buffer: string): { messages: JsonRpcResponse[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  const messages: JsonRpcResponse[] = [];

  for (const part of parts) {
    const dataLines: string[] = [];
    for (const rawLine of part.split(/\r?\n/)) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcResponse;
      if (parsed && typeof parsed === 'object') messages.push(parsed);
    } catch {
      /* 忽略无法解析的 SSE data */
    }
  }

  return { messages, rest };
}

function idsMatch(left: unknown, right: number | string): boolean {
  if (left === undefined || left === null) return false;
  return String(left) === String(right);
}

function pickResponseById(messages: JsonRpcResponse[], requestId: number | string): JsonRpcResponse {
  const found = messages.find((msg) => idsMatch(msg.id, requestId));
  if (!found) {
    throw new Error(`响应中未找到 id=${requestId} 的 JSON-RPC 消息`);
  }
  return found;
}

function asJsonRpcResponse(parsed: unknown, requestId: number | string): JsonRpcResponse {
  if (Array.isArray(parsed)) {
    return pickResponseById(parsed as JsonRpcResponse[], requestId);
  }
  if (parsed && typeof parsed === 'object') {
    const msg = parsed as JsonRpcResponse;
    if (msg.id === undefined || msg.id === null || idsMatch(msg.id, requestId)) {
      return msg;
    }
  }
  throw new Error(`JSON 响应不是 id=${requestId} 的 JSON-RPC 消息`);
}

async function readSseJsonRpcResponse(
  response: Response,
  requestId: number | string,
): Promise<JsonRpcResponse> {
  if (!response.body) {
    const text = await response.text();
    const { messages } = consumeSseJsonRpc(`${text}\n\n`);
    return pickResponseById(messages, requestId);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      if (done) buffer += decoder.decode();

      const { messages, rest } = consumeSseJsonRpc(done ? `${buffer}\n\n` : buffer);
      buffer = done ? '' : rest;

      for (const msg of messages) {
        if (idsMatch(msg.id, requestId)) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return msg;
        }
      }

      if (done) break;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  throw new Error(`SSE 流结束，未收到 id=${requestId} 的 JSON-RPC 响应`);
}

/**
 * 单个远程 MCP 端点上的 Streamable HTTP 会话。
 */
export class StreamableHttpSession {
  private readonly url: URL;
  private readonly extraHeaders: Record<string, string>;
  private readonly serverName: string;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private closed = false;

  constructor(options: StreamableHttpSessionOptions) {
    this.url = options.url;
    this.extraHeaders = normalizeMcpHeaders(options.headers);
    this.serverName = options.serverName;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  getProtocolVersion(): string | undefined {
    return this.protocolVersion;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    for (const [key, value] of Object.entries(this.extraHeaders)) {
      if (value) headers[key] = value;
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    return headers;
  }

  private captureSessionId(response: Response): void {
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId?.trim()) this.sessionId = sessionId.trim();
  }

  private async post(
    message: object,
    timeoutMs: number,
  ): Promise<Response> {
    if (this.closed) {
      throw new Error(`MCP server ${this.serverName} HTTP 会话已关闭`);
    }
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`MCP server ${this.serverName} HTTP 请求超时 (${timeoutMs}ms)`);
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`MCP server ${this.serverName} HTTP 连接失败: ${detail}`);
    }
  }

  async request(
    message: JsonRpcRequest,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  ): Promise<JsonRpcResponse> {
    const response = await this.post(message, timeoutMs);
    this.captureSessionId(response);

    const contentType = mediaType(response.headers.get('content-type'));

    if (response.status === 202) {
      throw new Error(`MCP server ${this.serverName} 对请求 ${message.method} 返回了 202，未给出 JSON-RPC 结果`);
    }

    if (contentType === 'text/event-stream') {
      const rpc = await readSseJsonRpcResponse(response, message.id);
      if (!response.ok && !rpc.error) {
        throw new Error(httpStatusError(this.serverName, response.status));
      }
      return rpc;
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new Error(httpStatusError(this.serverName, response.status, '空响应'));
    }

    const trimmed = text.trim();
    if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
      const { messages } = consumeSseJsonRpc(`${text}\n\n`);
      return pickResponseById(messages, message.id);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) {
        throw new Error(httpStatusError(this.serverName, response.status, snippet(text)));
      }
      throw new Error(`MCP server ${this.serverName} 返回了非 JSON 响应: ${snippet(text)}`);
    }

    try {
      return asJsonRpcResponse(parsed, message.id);
    } catch (err) {
      if (!response.ok) {
        throw new Error(httpStatusError(this.serverName, response.status, snippet(text)));
      }
      throw err;
    }
  }

  async notify(
    message: { jsonrpc: '2.0'; method: string; params?: Record<string, any> },
    timeoutMs = 15_000,
  ): Promise<void> {
    const response = await this.post(message, timeoutMs);
    this.captureSessionId(response);
    if (response.status === 202 || response.ok) {
      try {
        await response.arrayBuffer();
      } catch {
        /* ignore */
      }
      return;
    }
    const text = await response.text().catch(() => '');
    throw new Error(httpStatusError(this.serverName, response.status, snippet(text)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5_000),
        redirect: 'follow',
      });
    } catch {
      /* 规范允许 405；关闭失败不影响本地状态 */
    }
  }
}

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function httpStatusError(serverName: string, status: number, detail?: string): string {
  const hint = status === 401 || status === 403
    ? '（请检查 headers.Authorization）'
    : '';
  const extra = detail ? `: ${detail}` : '';
  return `MCP server ${serverName} HTTP ${status}${hint}${extra}`;
}
