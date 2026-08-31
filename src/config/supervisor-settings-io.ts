/** Read, validate, and persist the compact L0/L1 supervisor settings. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExecutionModeConfig, SupervisorConfigFile } from '../types/supervisor.js';
import {
  buildSupervisorConfigFile,
  DEFAULT_EXECUTION_MODE,
  resolveSupervisorConfigFilePath,
  type LoadSupervisorConfigOptions,
} from '../harness/supervisor/supervisor-config.js';

const TOP_KEYS = new Set(['mode', 'executionMode']);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, min = 0): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

export function validateSupervisorSettingsDocument(raw: unknown): string | null {
  if (!isObject(raw)) return 'config 须为对象';
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) return `含未知字段：${key}`;
  }
  if (raw.mode !== 'off' && raw.mode !== 'adaptive' && raw.mode !== 'strict') {
    return 'mode 须为 off、adaptive、strict 之一';
  }
  if (!isObject(raw.executionMode)) return 'executionMode 须为对象';
  const cfg = raw.executionMode;
  for (const key of [
    'pendingStepsEnterThreshold',
    'writeTargetsEnterThreshold',
    'diffLinesEnterThreshold',
    'stableRoundsExitThreshold',
    'modeLockRounds',
    'forcedMinDwellRounds',
  ]) {
    if (!finiteNumber(cfg[key])) return `executionMode.${key} 须为非负有限数字`;
  }
  if (!Array.isArray(cfg.readonlyToolNames)
    || cfg.readonlyToolNames.some(value => typeof value !== 'string')) {
    return 'executionMode.readonlyToolNames 须为字符串数组';
  }
  return null;
}

export async function readSupervisorSettingsDocument(
  options: LoadSupervisorConfigOptions = {},
): Promise<{ config: SupervisorConfigFile; configPath: string }> {
  const configPath = resolveSupervisorConfigFilePath(options);
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf-8')) as unknown;
    if (isObject(parsed)) raw = parsed;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error
      && (error as { code?: string }).code === 'ENOENT')) throw error;
  }
  return { config: buildSupervisorConfigFile(raw), configPath };
}

export async function writeSupervisorSettingsDocument(
  raw: unknown,
  options: LoadSupervisorConfigOptions = {},
): Promise<SupervisorConfigFile> {
  const error = validateSupervisorSettingsDocument(raw);
  if (error) throw Object.assign(new Error(error), { code: 'VALIDATE' });
  const input = raw as SupervisorConfigFile;
  const next: SupervisorConfigFile = {
    mode: input.mode,
    executionMode: {
      ...DEFAULT_EXECUTION_MODE,
      ...input.executionMode,
    } satisfies ExecutionModeConfig,
  };
  const configPath = resolveSupervisorConfigFilePath(options);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return next;
}
