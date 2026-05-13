import { describe, it, expect, vi } from 'vitest';
import {
  SESSION_PET_PALETTE_COLORS,
  SESSION_PET_DISPLAY_NAME,
  tokenPercentToPaletteIndex,
  eyeColorForTokenPct,
  pickRandomPaletteColor,
  buildSessionPetCanvasAriaLabel,
} from '../../src/public/js/session-pet-palette.js';

describe('session-pet-palette', () => {
  const n = SESSION_PET_PALETTE_COLORS.length;

  it('显示名与会话指示器文案一致（冰豆）', () => {
    expect(SESSION_PET_DISPLAY_NAME).toBe('冰豆');
  });

  it('色板长度与工程一致', () => {
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('tokenPercentToPaletteIndex：0 → 0，100 → 最后一档', () => {
    expect(tokenPercentToPaletteIndex(0, n)).toBe(0);
    expect(tokenPercentToPaletteIndex(100, n)).toBe(n - 1);
  });

  it('tokenPercentToPaletteIndex：中间值落在合法下标', () => {
    for (const pct of [1, 33, 50, 66, 99]) {
      const i = tokenPercentToPaletteIndex(pct, n);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(n);
    }
  });

  it('eyeColorForTokenPct：边界与中间返回色板内颜色', () => {
    expect(eyeColorForTokenPct(0)).toBe(SESSION_PET_PALETTE_COLORS[0]);
    expect(eyeColorForTokenPct(100)).toBe(SESSION_PET_PALETTE_COLORS[n - 1]);
    expect(SESSION_PET_PALETTE_COLORS).toContain(eyeColorForTokenPct(42));
  });

  it('空色板回退默认色', () => {
    expect(eyeColorForTokenPct(50, [])).toBe('#FCD7E4');
  });

  it('pickRandomPaletteColor 从色板取值', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      expect(pickRandomPaletteColor()).toBe(SESSION_PET_PALETTE_COLORS[n - 1]);
    } finally {
      spy.mockRestore();
    }
  });

  it('buildSessionPetCanvasAriaLabel 提及圆环与随机眼色', () => {
    const label = buildSessionPetCanvasAriaLabel({
      tokenPct: 40,
      tokenUsed: 1000,
      tokenMax: 8000,
      tokenOutput: 100,
      tokenUsedLabel: '1.0K',
      tokenMaxLabel: '8.0K',
      outputLabel: '100',
    });
    expect(label).toContain('冰豆');
    expect(label).toMatch(/圆环/);
    expect(label).toMatch(/随机/);
    expect(label).toContain('40%');
  });
});
