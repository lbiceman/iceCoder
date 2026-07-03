/**
 * 持久化 MCP 配置变更（如 disabled 开关），并抑制 watch 触发的全量热重载。
 */

import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';
import type { MCPConfig, MCPServerConfig } from './types.js';

/** UI 写回 mcp.json 后忽略 watch 的时长（应大于 reload debounce） */
export const MCP_CONFIG_PERSIST_SUPPRESS_MS = 3_000;

let mcpConfigWatchSuppressedUntil = 0;

export function suppressMcpConfigWatch(ms = MCP_CONFIG_PERSIST_SUPPRESS_MS): void {
  mcpConfigWatchSuppressedUntil = Date.now() + ms;
}

export function isMcpConfigWatchSuppressed(): boolean {
  return Date.now() < mcpConfigWatchSuppressedUntil;
}

async function readMcpConfigFile(configPath: string): Promise<MCPConfig> {
  const raw = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as MCPConfig;
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  return config;
}

async function writeMcpConfigFile(configPath: string, config: MCPConfig): Promise<void> {
  suppressMcpConfigWatch();
  await writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function validateMcpServerConfig(config: unknown): MCPServerConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('配置必须是 JSON 对象');
  }
  const entry = config as MCPServerConfig;
  if (!entry.command || typeof entry.command !== 'string' || !entry.command.trim()) {
    throw new Error('配置缺少 command 字段');
  }
  if (entry.args != null && !Array.isArray(entry.args)) {
    throw new Error('args 必须是字符串数组');
  }
  if (entry.env != null && (typeof entry.env !== 'object' || Array.isArray(entry.env))) {
    throw new Error('env 必须是对象');
  }
  return entry;
}

/**
 * 读取单个 MCP Server 的完整配置（来自 mcp.json）。
 */
export async function getMcpServerConfig(
  configPath: string,
  serverName: string,
): Promise<MCPServerConfig> {
  const config = await readMcpConfigFile(configPath);
  const entry = config.mcpServers[serverName];
  if (!entry) {
    throw new Error(`MCP 服务器 ${serverName} 在配置文件中不存在`);
  }
  return entry;
}

/**
 * 写入或更新单个 MCP Server 配置（服务器须已存在）。
 */
export async function updateMcpServerConfig(
  configPath: string,
  serverName: string,
  serverConfig: MCPServerConfig,
): Promise<void> {
  const name = serverName.trim();
  if (!name) {
    throw new Error('服务器名称不能为空');
  }

  const validated = validateMcpServerConfig(serverConfig);
  const config = await readMcpConfigFile(configPath);
  if (!config.mcpServers[name]) {
    throw new Error(`MCP 服务器 ${name} 在配置文件中不存在`);
  }

  config.mcpServers[name] = validated;
  await writeMcpConfigFile(configPath, config);
}

/**
 * 新增 MCP Server 配置。
 */
export async function addMcpServerConfig(
  configPath: string,
  serverName: string,
  serverConfig: MCPServerConfig,
): Promise<void> {
  const name = serverName.trim();
  if (!name) {
    throw new Error('服务器名称不能为空');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error('服务器名称仅允许字母、数字、点、下划线和连字符');
  }

  const validated = validateMcpServerConfig(serverConfig);
  const config = await readMcpConfigFile(configPath);
  if (config.mcpServers[name]) {
    throw new Error(`MCP 服务器 ${name} 已存在`);
  }

  config.mcpServers[name] = validated;
  await writeMcpConfigFile(configPath, config);
}

/**
 * 从 mcp.json 删除单个 MCP Server 配置。
 */
export async function removeMcpServerConfig(
  configPath: string,
  serverName: string,
): Promise<void> {
  const name = serverName.trim();
  if (!name) {
    throw new Error('服务器名称不能为空');
  }

  const config = await readMcpConfigFile(configPath);
  if (!config.mcpServers[name]) {
    throw new Error(`MCP 服务器 ${name} 在配置文件中不存在`);
  }

  delete config.mcpServers[name];
  await writeMcpConfigFile(configPath, config);
}

/**
 * 更新单个 MCP Server 的 disabled 字段并写回 mcp.json。
 */
export async function setMcpServerDisabled(
  configPath: string,
  serverName: string,
  disabled: boolean,
): Promise<void> {
  const config = await readMcpConfigFile(configPath);
  const entry = config.mcpServers[serverName];
  if (!entry) {
    throw new Error(`MCP 服务器 ${serverName} 在配置文件中不存在`);
  }

  entry.disabled = disabled;
  await writeMcpConfigFile(configPath, config);
}
