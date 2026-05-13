import { describe, it, expect, afterEach } from 'vitest';
import {
  tierFromMaxContextTokens,
  readEffectiveContextWindowTokens,
  getContextWindowTier,
  CONTEXT_TIER_S_MAX,
  CONTEXT_TIER_M_MAX,
  CONTEXT_TIER_L_MAX,
} from '../../src/harness/context-window-tier.js';

describe('tierFromMaxContextTokens', () => {
  it('invalid → S', () => {
    expect(tierFromMaxContextTokens(NaN)).toBe('S');
    expect(tierFromMaxContextTokens(0)).toBe('S');
    expect(tierFromMaxContextTokens(-1)).toBe('S');
  });

  it('边界：S/M/L/XL', () => {
    expect(tierFromMaxContextTokens(CONTEXT_TIER_S_MAX)).toBe('S');
    expect(tierFromMaxContextTokens(CONTEXT_TIER_S_MAX + 1)).toBe('M');
    expect(tierFromMaxContextTokens(CONTEXT_TIER_M_MAX)).toBe('M');
    expect(tierFromMaxContextTokens(CONTEXT_TIER_M_MAX + 1)).toBe('L');
    expect(tierFromMaxContextTokens(CONTEXT_TIER_L_MAX)).toBe('L');
    expect(tierFromMaxContextTokens(CONTEXT_TIER_L_MAX + 1)).toBe('XL');
    expect(tierFromMaxContextTokens(1_000_000)).toBe('XL');
  });
});

describe('readEffectiveContextWindowTokens + getContextWindowTier', () => {
  const orig = process.env.ICE_CONTEXT_WINDOW;

  afterEach(() => {
    if (orig === undefined) delete process.env.ICE_CONTEXT_WINDOW;
    else process.env.ICE_CONTEXT_WINDOW = orig;
  });

  it('ICE_CONTEXT_WINDOW 优先于配置文件', () => {
    process.env.ICE_CONTEXT_WINDOW = '200000';
    expect(readEffectiveContextWindowTokens()).toBe(200_000);
    expect(getContextWindowTier()).toBe('M');
  });

  it('ICE_CONTEXT_WINDOW 为小窗口时档位为 S', () => {
    process.env.ICE_CONTEXT_WINDOW = '96000';
    expect(readEffectiveContextWindowTokens()).toBe(96_000);
    expect(getContextWindowTier()).toBe('S');
  });
});
