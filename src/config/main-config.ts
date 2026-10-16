/**
 * data/config.json 的路径解析与单项开关读写（权限确认、子 Agent、Windows 工具、Shell 黑名单）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveLocalDataDir } from '../cli/paths.js';
import type { IceCoderConfigFile } from '../web/types.js';

export async function readMainConfigFile(configPath: string): Promise<IceCoderConfigFile> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as IceCoderConfigFile;
    if (!parsed.providers) parsed.providers = [];
    return parsed;
  } catch (error) {
    if (isMissingFile(error)) {
      return { providers: [] };
    }
    throw error;
  }
}

/** 与 Web/CLI 共用：优先 `ICE_CONFIG_PATH`，否则 `{ICE_DATA_DIR|本地缓存}/config.json`。 */
export function resolveMainConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ICE_CONFIG_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const dataDir = env.ICE_DATA_DIR?.trim();
  if (dataDir) {
    return path.join(path.resolve(dataDir), 'config.json');
  }
  return path.join(resolveLocalDataDir(env), 'config.json');
}

/** 仅当 config.json 显式 `"skipPermissionChecks": true` 时为 true。 */
export function resolveSkipPermissionChecks(value: unknown): boolean {
  return value === true;
}

/** 读取 config.json 中的 skipPermissionChecks；缺失或非 true 时返回 false。 */
export async function readSkipPermissionChecksFromMainConfig(
  configPath: string,
): Promise<boolean> {
  const config = await readMainConfigFile(configPath);
  return resolveSkipPermissionChecks(config.skipPermissionChecks);
}

export async function writeSkipPermissionChecksToMainConfig(
  configPath: string,
  enabled: boolean,
): Promise<boolean> {
  const skipPermissionChecks = resolveSkipPermissionChecks(enabled);
  const config = await readMainConfigFile(configPath);
  config.skipPermissionChecks = skipPermissionChecks;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return skipPermissionChecks;
}

/** 仅当 config.json 显式 `"enableSubAgents": false` 时关闭；缺失视为开启。 */
export function resolveEnableSubAgents(value: unknown): boolean {
  return value !== false;
}

/** 读取 config.json 中的 enableSubAgents；缺失时返回 true。 */
export async function readEnableSubAgentsFromMainConfig(
  configPath: string,
): Promise<boolean> {
  const config = await readMainConfigFile(configPath);
  return resolveEnableSubAgents(config.enableSubAgents);
}

export async function writeEnableSubAgentsToMainConfig(
  configPath: string,
  enabled: boolean,
): Promise<boolean> {
  const enableSubAgents = enabled === true;
  const config = await readMainConfigFile(configPath);
  config.enableSubAgents = enableSubAgents;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return enableSubAgents;
}

/** 仅当 config.json 显式 `"useWindows": true` 时开启；缺失视为关闭。 */
export function resolveUseWindows(value: unknown): boolean {
  return value === true;
}

/** 读取 config.json 中的 useWindows；缺失时返回 false。 */
export async function readUseWindowsFromMainConfig(configPath: string): Promise<boolean> {
  const config = await readMainConfigFile(configPath);
  return resolveUseWindows(config.useWindows);
}

export async function writeUseWindowsToMainConfig(
  configPath: string,
  enabled: boolean,
): Promise<boolean> {
  const useWindows = enabled === true;
  const config = await readMainConfigFile(configPath);
  config.useWindows = useWindows;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return useWindows;
}

export async function writeShellBlacklistToMainConfig(
  configPath: string,
  patterns: string[],
): Promise<string[]> {
  const shellBlacklist = patterns
    .map(item => item.trim())
    .filter(item => item.length > 0);
  const config = await readMainConfigFile(configPath);
  config.shellBlacklist = shellBlacklist;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return shellBlacklist;
}

function isMissingFile(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}
