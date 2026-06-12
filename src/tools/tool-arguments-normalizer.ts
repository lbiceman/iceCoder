/**
 * 工具参数归一化（全 provider 通用）。
 *
 * 覆盖三类来源，不针对任何特定模型：
 * 1. function.arguments 字符串 parse 失败时，适配器兜底为 { raw: "<原始串>" }
 * 2. 模型/API 用单字段包裹整段 JSON：raw / arguments / input / params 等
 * 3. 截断 JSON：parse 失败时 salvage path/content/search 等字段并标记 _salvageTruncated
 */

import {
  salvageTruncatedToolJson,
  SALVAGE_TRUNCATED_KEY,
} from './tool-arguments-salvage.js';

/** 常见的「整段 JSON 字符串」包裹字段名 */
const STRING_WRAPPER_KEYS = [
  'raw',
  'arguments',
  'input',
  'params',
  'parameters',
  'kwargs',
] as const;

type StringWrapperKey = (typeof STRING_WRAPPER_KEYS)[number];

const MAX_UNWRAP_DEPTH = 4;

function isStringWrapperKey(key: string): key is StringWrapperKey {
  return (STRING_WRAPPER_KEYS as readonly string[]).includes(key);
}

function tryUnwrapStringifiedPayload(
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const keys = Object.keys(args);
  if (keys.length !== 1) return null;

  const wrapperKey = keys[0]!;
  if (!isStringWrapperKey(wrapperKey)) return null;

  const value = args[wrapperKey];
  if (typeof value !== 'string' || value.length === 0) return null;

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const salvaged = salvageTruncatedToolJson(value);
    if (salvaged) return salvaged;
  }

  return null;
}

/** 各工具 handler 已支持的参数别名，在此统一提升为 canonical 名。 */
function applyCommonParameterAliases(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (out.path === undefined && typeof out.filePath === 'string') {
    out.path = out.filePath;
  }
  if (out.command === undefined && typeof out.cmd === 'string') {
    out.command = out.cmd;
  }
  return out;
}

function unwrapLayers(args: Record<string, unknown>): Record<string, unknown> {
  let current = args;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const unwrapped = tryUnwrapStringifiedPayload(current);
    if (!unwrapped) break;
    current = applyCommonParameterAliases(unwrapped);
  }
  return current;
}

export function normalizeToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }

  const unwrapped = unwrapLayers(args);
  if (unwrapped !== args) {
    return applyCommonParameterAliases(unwrapped);
  }

  // 单字段 wrapper 且无法 unwrap：尝试直接 salvage wrapper 字符串
  const keys = Object.keys(args);
  if (keys.length === 1 && isStringWrapperKey(keys[0]!)) {
    const value = args[keys[0]!];
    if (typeof value === 'string') {
      const salvaged = salvageTruncatedToolJson(value);
      if (salvaged) return applyCommonParameterAliases(salvaged);
    }
  }

  return applyCommonParameterAliases(args);
}

/** 参数仍为未展开的单字段字符串包裹（含 salvage 失败后的 raw 兜底）。 */
export function isUnexpandedStringWrapper(args: Record<string, unknown>): boolean {
  if (args[SALVAGE_TRUNCATED_KEY] === true) return false;
  const keys = Object.keys(args);
  if (keys.length !== 1) return false;
  const key = keys[0]!;
  return isStringWrapperKey(key) && typeof args[key] === 'string';
}

export function buildWrappedArgumentFormatHint(): string {
  return [
    'Pass tool parameters as top-level JSON fields (e.g. path, content, command).',
    'Do not wrap the whole payload in a single string field (raw, arguments, input, params).',
    'If the payload was truncated, use edit_file/patch_file or split into smaller writes.',
  ].join(' ');
}

export { isSalvagedTruncatedArguments, buildSalvageTruncatedError } from './tool-arguments-salvage.js';
