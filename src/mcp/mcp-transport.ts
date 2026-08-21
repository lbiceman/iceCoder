/**
 * MCP 传输判定（stdio vs 远程 HTTP）。
 */

import type { MCPServerConfig } from './types.js';

export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse';

function normalizeTransportType(type: string | undefined): string {
  return String(type ?? '').trim().toLowerCase().replace(/_/g, '-');
}

/**
 * 从 mcp.json 条目判断传输方式。
 * `streamablehttp` / `streamable-http` / `http` 以及仅有 url 的条目视为 Streamable HTTP。
 */
export function resolveMcpTransportKind(config: MCPServerConfig): McpTransportKind {
  const raw = normalizeTransportType(config.type);
  if (raw === 'sse' || raw === 'http+sse' || raw === 'http-sse') return 'sse';
  if (
    raw === 'http'
    || raw === 'streamable-http'
    || raw === 'streamablehttp'
    || raw === 'streamable'
  ) {
    return 'streamable-http';
  }
  if (typeof config.url === 'string' && config.url.trim()) return 'streamable-http';
  return 'stdio';
}

export function isRemoteMcpConfig(config: MCPServerConfig): boolean {
  const kind = resolveMcpTransportKind(config);
  return kind === 'streamable-http' || kind === 'sse';
}

/** 规范化远程 MCP 请求头；非法值直接抛错。 */
export function normalizeMcpHeaders(headers: unknown): Record<string, string> {
  if (headers == null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('headers 必须是对象');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const name = key.trim();
    if (!name) continue;
    if (typeof value !== 'string') {
      throw new Error(`headers.${name} 必须是字符串`);
    }
    out[name] = value;
  }
  return out;
}

/** 解析并校验远程 MCP url。 */
export function resolveMcpHttpUrl(config: MCPServerConfig): URL {
  const raw = config.url?.trim();
  if (!raw) {
    throw new Error('远程 MCP 配置缺少 url');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`远程 MCP url 无效: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`远程 MCP url 必须是 http(s) 地址: ${raw}`);
  }
  return parsed;
}
