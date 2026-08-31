/** L0/L1 supervisor 配置加载：只解析档位与 executionMode，不再创建 L2 Bridge。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRuntimeDataDir } from '../../cli/paths.js';
import type {
  ExecutionModeConfig,
  ResolvedSupervisorConfig,
  SupervisorConfigFile,
} from '../../types/supervisor.js';
import {
  readSupervisorModeFromMainConfig,
  resolveMainConfigPath,
} from '../../config/main-config-supervisor-mode.js';
import { resolveGlobalPolicy } from './mode-controller.js';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export interface LoadSupervisorConfigOptions {
  configPath?: string;
  mainConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
}

export const DEFAULT_EXECUTION_MODE: ExecutionModeConfig = {
  pendingStepsEnterThreshold: 2,
  writeTargetsEnterThreshold: 1,
  diffLinesEnterThreshold: 200,
  stableRoundsExitThreshold: 2,
  modeLockRounds: 2,
  forcedMinDwellRounds: 1,
  readonlyToolNames: ['read_file', 'glob', 'grep', 'list_dir'],
};

export function defaultSupervisorConfig(): SupervisorConfigFile {
  return {
    mode: 'adaptive',
    executionMode: { ...DEFAULT_EXECUTION_MODE },
  };
}

export function resolveSupervisorConfig(
  config: DeepPartial<SupervisorConfigFile> = {},
): ResolvedSupervisorConfig {
  const merged = mergeConfig(defaultSupervisorConfig(), config);
  return {
    ...merged,
    executionMode: {
      ...DEFAULT_EXECUTION_MODE,
      ...(merged.executionMode ?? {}),
    },
    globalPolicy: resolveGlobalPolicy(merged),
  };
}

async function loadSupervisorConfig(
  options: LoadSupervisorConfigOptions = {},
): Promise<ResolvedSupervisorConfig> {
  const env = options.env ?? process.env;
  const loaded = await readConfigFile(resolveConfigPath(options, env));
  const mainConfigPath = options.mainConfigPath ?? resolveMainConfigPath(env);
  const modeFromMain = await readSupervisorModeFromMainConfig(mainConfigPath);
  return resolveSupervisorConfig(modeFromMain ? { ...loaded, mode: modeFromMain } : loaded);
}

export async function loadHarnessSupervisorRuntime(
  options: LoadSupervisorConfigOptions = {},
): Promise<{
  supervisorConfig: ResolvedSupervisorConfig;
  globalPolicy: ResolvedSupervisorConfig['globalPolicy'];
}> {
  try {
    const supervisorConfig = await loadSupervisorConfig(options);
    return { supervisorConfig, globalPolicy: supervisorConfig.globalPolicy };
  } catch (err) {
    console.debug(
      '[supervisor-config] load failed, fallback to off:',
      err instanceof Error ? err.message : err,
    );
    const supervisorConfig = resolveSupervisorConfig({ mode: 'off' });
    return { supervisorConfig, globalPolicy: supervisorConfig.globalPolicy };
  }
}

export function resolveSupervisorConfigFilePath(
  options: LoadSupervisorConfigOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveConfigPath(options, env);
}

export function buildSupervisorConfigFile(
  override: DeepPartial<SupervisorConfigFile> = {},
): SupervisorConfigFile {
  return mergeConfig(defaultSupervisorConfig(), override);
}

function resolveConfigPath(options: LoadSupervisorConfigOptions, env: NodeJS.ProcessEnv): string {
  const explicitPath = options.configPath ?? env.ICE_SUPERVISOR_CONFIG_PATH;
  if (explicitPath) return path.resolve(explicitPath);
  return path.join(options.dataDir ?? env.ICE_DATA_DIR ?? getRuntimeDataDir(), 'supervisor-config.json');
}

async function readConfigFile(configPath: string): Promise<DeepPartial<SupervisorConfigFile>> {
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf-8')) as DeepPartial<SupervisorConfigFile>;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'ENOENT') return {};
    throw error;
  }
}

function mergeConfig(
  base: SupervisorConfigFile,
  override: DeepPartial<SupervisorConfigFile>,
): SupervisorConfigFile {
  return {
    mode: override.mode ?? base.mode,
    executionMode: {
      ...(base.executionMode ?? DEFAULT_EXECUTION_MODE),
      ...(override.executionMode ?? {}),
    },
  };
}
