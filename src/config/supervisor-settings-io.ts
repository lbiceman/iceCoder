/**
 * 设置页读写 supervisor-config.json：校验并落盘。档位 mode 由侧栏写入 config.json，本页不改。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SupervisorConfigFile } from '../types/supervisor.js';
import {
  buildSupervisorConfigFile,
  resolveSupervisorConfigFilePath,
  type LoadSupervisorConfigOptions,
} from '../harness/supervisor/supervisor-config.js';

const TOP_KEYS = new Set([
  'mode',
  'shadow',
  'params',
  'triggers',
  'goalDrift',
  'snapshotConfidence',
  'correctionBudget',
  'eventTimeline',
  'executionMode',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function expectBoolean(path: string, value: unknown): string | null {
  if (typeof value !== 'boolean') return `${path} 须为 boolean`;
  return null;
}

function expectNumber(path: string, value: unknown, min?: number, max?: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} 须为有限数字`;
  if (min != null && value < min) return `${path} 不能小于 ${min}`;
  if (max != null && value > max) return `${path} 不能大于 ${max}`;
  return null;
}

function expectString(path: string, value: unknown): string | null {
  if (typeof value !== 'string') return `${path} 须为字符串`;
  return null;
}

function expectStringArray(path: string, value: unknown): string | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    return `${path} 须为字符串数组`;
  }
  return null;
}

function expectEnum(path: string, value: unknown, allowed: string[]): string | null {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `${path} 须为 ${allowed.join('、')} 之一`;
  }
  return null;
}

function validateModeParams(path: string, raw: unknown, freeOnly: boolean): string | null {
  if (!isPlainObject(raw)) return `${path} 须为对象`;
  const err = expectBoolean(`${path}.firstRoundGraph`, raw.firstRoundGraph)
    ?? expectNumber(`${path}.riskThreshold`, raw.riskThreshold, 0, 1);
  if (err) return err;
  if (freeOnly) return null;
  return expectNumber(`${path}.maxRecoveryRounds`, raw.maxRecoveryRounds, 0)
    ?? expectNumber(`${path}.recoveryTokenRatio`, raw.recoveryTokenRatio, 0, 1)
    ?? expectNumber(`${path}.maxRecoveryRetries`, raw.maxRecoveryRetries, 0)
    ?? expectNumber(`${path}.stabilityWindowRounds`, raw.stabilityWindowRounds, 0)
    ?? expectNumber(`${path}.handoffCooldownRounds`, raw.handoffCooldownRounds, 0)
    ?? (raw.evaluateRoundMode !== undefined
      ? expectEnum(`${path}.evaluateRoundMode`, raw.evaluateRoundMode, ['full', 'metrics_only'])
      : null)
    ?? (raw.checkToolCall !== undefined ? expectBoolean(`${path}.checkToolCall`, raw.checkToolCall) : null);
}

/**
 * 校验设置页提交的完整监管配置。通过则返回 null。
 */
export function validateSupervisorSettingsDocument(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'config 须为对象';
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) return `含未知字段：${key}`;
  }

  const err = expectEnum('mode', raw.mode, ['off', 'adaptive', 'strict'])
    ?? expectBoolean('shadow', raw.shadow);
  if (err) return err;

  if (!isPlainObject(raw.params)) return 'params 须为对象';
  const paramsErr = validateModeParams('params.strict', raw.params.strict, false)
    ?? validateModeParams('params.adaptiveFree', raw.params.adaptiveFree, true)
    ?? validateModeParams('params.adaptiveTakeover', raw.params.adaptiveTakeover, false);
  if (paramsErr) return paramsErr;

  if (!isPlainObject(raw.triggers)) return 'triggers 须为对象';
  const triggersErr = expectNumber('triggers.toolRepeatFailMin', raw.triggers.toolRepeatFailMin, 1)
    ?? expectNumber('triggers.noProgressRoundsMin', raw.triggers.noProgressRoundsMin, 1)
    ?? expectNumber('triggers.fileLoopMin', raw.triggers.fileLoopMin, 1)
    ?? expectBoolean('triggers.goalDriftEnabled', raw.triggers.goalDriftEnabled)
    ?? expectBoolean('triggers.scopeCreepEnabled', raw.triggers.scopeCreepEnabled)
    ?? expectBoolean('triggers.userForceTakeoverEnabled', raw.triggers.userForceTakeoverEnabled);
  if (triggersErr) return triggersErr;

  if (!isPlainObject(raw.goalDrift)) return 'goalDrift 须为对象';
  const driftErr = expectNumber('goalDrift.alignmentThreshold', raw.goalDrift.alignmentThreshold, 0, 1)
    ?? expectNumber('goalDrift.consecutiveRoundsBelow', raw.goalDrift.consecutiveRoundsBelow, 1)
    ?? (raw.goalDrift.llmGrayZoneLow !== undefined
      ? expectNumber('goalDrift.llmGrayZoneLow', raw.goalDrift.llmGrayZoneLow, 0, 1)
      : null)
    ?? (raw.goalDrift.llmGrayZoneHigh !== undefined
      ? expectNumber('goalDrift.llmGrayZoneHigh', raw.goalDrift.llmGrayZoneHigh, 0, 1)
      : null);
  if (driftErr) return driftErr;

  if (!isPlainObject(raw.snapshotConfidence)) return 'snapshotConfidence 须为对象';
  const snapErr = expectNumber('snapshotConfidence.templateGraphMin', raw.snapshotConfidence.templateGraphMin, 0, 1)
    ?? optionalNumber('snapshotConfidence.weightGitClean', raw.snapshotConfidence.weightGitClean)
    ?? optionalNumber('snapshotConfidence.weightSnapshotAge', raw.snapshotConfidence.weightSnapshotAge)
    ?? optionalNumber('snapshotConfidence.weightVerifyPassed', raw.snapshotConfidence.weightVerifyPassed)
    ?? optionalNumber('snapshotConfidence.weightRepoContextMatch', raw.snapshotConfidence.weightRepoContextMatch)
    ?? optionalNumber('snapshotConfidence.weightBuildSignal', raw.snapshotConfidence.weightBuildSignal);
  if (snapErr) return snapErr;

  if (!isPlainObject(raw.correctionBudget)) return 'correctionBudget 须为对象';
  const budgetErr = expectNumber(
    'correctionBudget.freeSegmentMaxPerTask',
    raw.correctionBudget.freeSegmentMaxPerTask,
    0,
  );
  if (budgetErr) return budgetErr;

  if (!isPlainObject(raw.eventTimeline)) return 'eventTimeline 须为对象';
  const timelineErr = expectBoolean('eventTimeline.enabled', raw.eventTimeline.enabled)
    ?? expectString('eventTimeline.persistPath', raw.eventTimeline.persistPath);
  if (timelineErr) return timelineErr;

  if (!isPlainObject(raw.executionMode)) return 'executionMode 须为对象';
  return (raw.executionMode.enabled !== undefined
      ? expectBoolean('executionMode.enabled', raw.executionMode.enabled)
      : null)
    ?? expectNumber('executionMode.pendingStepsEnterThreshold', raw.executionMode.pendingStepsEnterThreshold, 0)
    ?? expectNumber('executionMode.writeTargetsEnterThreshold', raw.executionMode.writeTargetsEnterThreshold, 0)
    ?? expectNumber('executionMode.diffLinesEnterThreshold', raw.executionMode.diffLinesEnterThreshold, 0)
    ?? expectNumber('executionMode.stableRoundsExitThreshold', raw.executionMode.stableRoundsExitThreshold, 0)
    ?? expectNumber('executionMode.modeLockRounds', raw.executionMode.modeLockRounds, 0)
    ?? expectNumber('executionMode.forcedMinDwellRounds', raw.executionMode.forcedMinDwellRounds, 0)
    ?? expectStringArray('executionMode.readonlyToolNames', raw.executionMode.readonlyToolNames);
}

function optionalNumber(path: string, value: unknown): string | null {
  if (value === undefined) return null;
  return expectNumber(path, value, 0, 1);
}

export async function readSupervisorSettingsDocument(
  options: LoadSupervisorConfigOptions = {},
): Promise<{ config: SupervisorConfigFile; configPath: string }> {
  const configPath = resolveSupervisorConfigFilePath(options);
  let raw: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(text) as unknown;
    if (isPlainObject(parsed)) raw = parsed;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return { config: buildSupervisorConfigFile(raw), configPath };
}

export async function writeSupervisorSettingsDocument(
  raw: unknown,
  options: LoadSupervisorConfigOptions & { mainConfigPath?: string } = {},
): Promise<SupervisorConfigFile> {
  const validationError = validateSupervisorSettingsDocument(raw);
  if (validationError) {
    throw Object.assign(new Error(validationError), { code: 'VALIDATE' });
  }
  const input = raw as SupervisorConfigFile;
  const merged = buildSupervisorConfigFile(input);
  const next: SupervisorConfigFile = {
    ...merged,
    params: {
      strict: { ...merged.params.strict, ...input.params.strict },
      adaptiveFree: { ...merged.params.adaptiveFree, ...input.params.adaptiveFree },
      adaptiveTakeover: { ...merged.params.adaptiveTakeover, ...input.params.adaptiveTakeover },
    },
    triggers: { ...merged.triggers, ...input.triggers },
    goalDrift: { ...merged.goalDrift, ...input.goalDrift },
    snapshotConfidence: { ...merged.snapshotConfidence, ...input.snapshotConfidence },
    correctionBudget: { ...merged.correctionBudget, ...input.correctionBudget },
    eventTimeline: { ...merged.eventTimeline, ...input.eventTimeline },
    executionMode: { ...merged.executionMode, ...input.executionMode },
  };
  const configPath = resolveSupervisorConfigFilePath(options);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return next;
}

function isMissingFile(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}
