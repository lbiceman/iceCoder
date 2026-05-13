/**
 * 根据当前生效的上下文窗口（token）划分 S/M/L/XL，与 data/config.json 中默认 provider 的
 * maxContextTokens 对齐（可被 ICE_CONTEXT_WINDOW 覆盖）。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IceCoderConfigFile } from '../web/types.js';

/** 默认上下文窗口（配置文件不可用且无 env 时与压缩器一致） */
export const DEFAULT_EFFECTIVE_CONTEXT_WINDOW = 128_000;

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

/** 当前进程生效窗口对应的 S/M/L/XL（供 Harness / 记忆预算等按档位查表） */
export function getContextWindowTier(): ContextWindowTier {
  return tierFromMaxContextTokens(readEffectiveContextWindowTokens());
}
