/**
 * 从 data/config.json 读写 supervisorMode（用户可配置的三档监管模式）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IceCoderConfigFile } from '../web/types.js';
import type { SupervisorMode } from '../types/supervisor.js';

export const DEFAULT_MAIN_CONFIG_SUPERVISOR_MODE: SupervisorMode = 'adaptive';

export function normalizeSupervisorMode(
  value: unknown,
  fallback: SupervisorMode = DEFAULT_MAIN_CONFIG_SUPERVISOR_MODE,
): SupervisorMode {
  if (value === 'off' || value === 'adaptive' || value === 'strict') {
    return value;
  }
  return fallback;
}

export async function readMainConfigFile(configPath: string): Promise<IceCoderConfigFile> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as IceCoderConfigFile;
    if (!parsed.providers) parsed.providers = [];
    return parsed;
  } catch (error) {
    if (isMissingFile(error)) {
      return { providers: [], supervisorMode: DEFAULT_MAIN_CONFIG_SUPERVISOR_MODE };
    }
    throw error;
  }
}

/** 读取 config.json 中的 supervisorMode；字段缺失时返回 undefined（由 supervisor-config.json 兜底）。 */
export async function readSupervisorModeFromMainConfig(
  configPath: string,
): Promise<SupervisorMode | undefined> {
  const config = await readMainConfigFile(configPath);
  if (config.supervisorMode == null) {
    return undefined;
  }
  return normalizeSupervisorMode(config.supervisorMode);
}

export async function writeSupervisorModeToMainConfig(
  configPath: string,
  mode: SupervisorMode,
): Promise<SupervisorMode> {
  const normalized = normalizeSupervisorMode(mode);
  const config = await readMainConfigFile(configPath);
  config.supervisorMode = normalized;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return normalized;
}

/** 与 Web/CLI 共用：优先 `ICE_CONFIG_PATH`，否则 `{cwd}/data/config.json`。 */
export function resolveMainConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ICE_CONFIG_PATH?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve('data/config.json');
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
