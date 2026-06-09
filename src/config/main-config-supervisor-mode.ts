/**
 * 从 data/config.json 读写 supervisorMode（用户可配置的三档监管模式）。
 */

import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
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

export function resolveMainConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ICE_CONFIG_PATH?.trim()) {
    return env.ICE_CONFIG_PATH.trim();
  }
  return 'data/config.json';
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

/** 仅当 config.json 显式 `"skipSandbox": true` 时为 true。 */
export function resolveSkipSandbox(value: unknown): boolean {
  return value === true;
}

/** 读取 config.json 中的 skipSandbox；缺失或非 true 时返回 false。 */
export async function readSkipSandboxFromMainConfig(
  configPath: string,
): Promise<boolean> {
  const config = await readMainConfigFile(configPath);
  return resolveSkipSandbox(config.skipSandbox);
}

/** 同步读取 skipSandbox（供 Shell 工具执行时按需查询）。 */
export function readSkipSandboxFromMainConfigSync(
  configPath: string = resolveMainConfigPath(),
): boolean {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as IceCoderConfigFile;
    return resolveSkipSandbox(parsed.skipSandbox);
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}
