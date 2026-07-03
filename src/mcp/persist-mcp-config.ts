/**
 * 持久化 MCP 配置变更（如 disabled 开关），并抑制 watch 触发的全量热重载。
 */

import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';
import type { MCPConfig } from './types.js';

/** UI 写回 mcp.json 后忽略 watch 的时长（应大于 reload debounce） */
export const MCP_CONFIG_PERSIST_SUPPRESS_MS = 3_000;

let mcpConfigWatchSuppressedUntil = 0;

export function suppressMcpConfigWatch(ms = MCP_CONFIG_PERSIST_SUPPRESS_MS): void {
  mcpConfigWatchSuppressedUntil = Date.now() + ms;
}

export function isMcpConfigWatchSuppressed(): boolean {
  return Date.now() < mcpConfigWatchSuppressedUntil;
}

/**
 * 更新单个 MCP Server 的 disabled 字段并写回 mcp.json。
 */
export async function setMcpServerDisabled(
  configPath: string,
  serverName: string,
  disabled: boolean,
): Promise<void> {
  const raw = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as MCPConfig;
  const entry = config.mcpServers?.[serverName];
  if (!entry) {
    throw new Error(`MCP 服务器 ${serverName} 在配置文件中不存在`);
  }

  entry.disabled = disabled;
  suppressMcpConfigWatch();
  await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
