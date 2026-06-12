/**
 * 根据当前生效的上下文窗口（token）划分 S/M/L/XL，与 data/config.json 中默认 provider 的
 * maxContextTokens 对齐（可被 ICE_CONTEXT_WINDOW 覆盖）。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IceCoderConfigFile } from '../web/types.js';

/** 默认上下文窗口（配置文件不可用且无 env 时与压缩器一致） */
export const DEFAULT_EFFECTIVE_CONTEXT_WINDOW = 128_000;

/** MiniMax 等 provider 配置标 200K 但 API 更严；续跑 fork / emergency 用此保守上限 */
export const MINIMAX_COMPACTION_SAFE_CAP = 128_000;

export interface ProviderCompactionHint {
  id?: string;
  modelName?: string;
  apiUrl?: string;
}

/** 按 provider 元数据返回续跑压缩用的保守 token 上限；无特殊 cap 则 null */
export function providerCompactionCapForProvider(provider: ProviderCompactionHint): number | null {
  const id = (provider.id ?? '').toLowerCase();
  const model = (provider.modelName ?? '').toLowerCase();
  const url = (provider.apiUrl ?? '').toLowerCase();
  if (id.includes('minimax') || model.includes('minimax') || url.includes('minimax')) {
    return MINIMAX_COMPACTION_SAFE_CAP;
  }
  return null;
}

function readDefaultProviderFromConfig(): ProviderCompactionHint | null {
  try {
    const configPath = path.resolve('data/config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as IceCoderConfigFile;
    const defaultProvider = config.providers?.find(p => p.isDefault);
    return defaultProvider ?? null;
  } catch {
    return null;
  }
}

/** S：≤128K（含） */
export const CONTEXT_TIER_S_MAX = 128_000;
/** M：(128K, 256K] */
export const CONTEXT_TIER_M_MAX = 256_000;
/** L：(256K, 512K] */
export const CONTEXT_TIER_L_MAX = 512_000;
/** XL：>512K */

export type ContextWindowTier = 'S' | 'M' | 'L' | 'XL';

/**
 * 由单次配置的 maxContextTokens（或任意「上下文上限」数值）得到档位。
 * - invalid / ≤0 → S（保守）
 */
export function tierFromMaxContextTokens(tokens: number): ContextWindowTier {
  const n = Math.floor(Number(tokens));
  if (!Number.isFinite(n) || n <= 0) return 'S';
  if (n <= CONTEXT_TIER_S_MAX) return 'S';
  if (n <= CONTEXT_TIER_M_MAX) return 'M';
  if (n <= CONTEXT_TIER_L_MAX) return 'L';
  return 'XL';
}

/**
 * 与压缩器相同的「生效上下文窗口」解析：
 * 1. ICE_CONTEXT_WINDOW
 * 2. data/config.json 默认 provider 的 maxContextTokens
 * 3. 所有 provider 中最大的 maxContextTokens
 * 4. DEFAULT_EFFECTIVE_CONTEXT_WINDOW
 */
export function readEffectiveContextWindowTokens(): number {
  const env = parseInt(process.env.ICE_CONTEXT_WINDOW || '', 10);
  if (Number.isFinite(env) && env > 0) return env;

  try {
    const configPath = path.resolve('data/config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as IceCoderConfigFile;
    const defaultProvider = config.providers?.find(p => p.isDefault && p.maxContextTokens);
    if (defaultProvider?.maxContextTokens && defaultProvider.maxContextTokens > 0) {
      return defaultProvider.maxContextTokens;
    }
    let maxCtx = 0;
    for (const p of config.providers ?? []) {
      if (p.maxContextTokens && p.maxContextTokens > maxCtx) {
        maxCtx = p.maxContextTokens;
      }
    }
    if (maxCtx > 0) return maxCtx;
  } catch {
    /* 配置文件缺失或解析失败 */
  }

  return DEFAULT_EFFECTIVE_CONTEXT_WINDOW;
}

/**
 * 续跑 fork / emergency compact 用的保守窗口：
 * - ICE_CONTEXT_WINDOW 显式设置时尊重用户值
 * - 否则 min(生效窗口, provider 保守 cap)，如 MiniMax → 128K
 */
export function readCompactionContextWindowTokens(): number {
  const env = parseInt(process.env.ICE_CONTEXT_WINDOW || '', 10);
  if (Number.isFinite(env) && env > 0) return env;

  const effective = readEffectiveContextWindowTokens();
  const provider = readDefaultProviderFromConfig();
  if (!provider) return effective;
  const cap = providerCompactionCapForProvider(provider);
  if (cap == null) return effective;
  return Math.min(effective, cap);
}

/** 当前进程生效窗口对应的 S/M/L/XL（供 Harness / 记忆预算等按档位查表） */
export function getContextWindowTier(): ContextWindowTier {
  return tierFromMaxContextTokens(readEffectiveContextWindowTokens());
}
