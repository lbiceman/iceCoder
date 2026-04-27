/**
 * memory-age 单元测试。
 * 覆盖年龄计算、人类可读字符串、新鲜度警告。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  memoryAgeDays,
  memoryAge,
  memoryFreshnessText,
  memoryFreshnessNote,
} from './memory-age.js';

const DAY_MS = 86_400_000;

describe('memoryAgeDays', () => {
  it('今天的时间戳返回 0', () => {
    expect(memoryAgeDays(Date.now())).toBe(0);
    expect(memoryAgeDays(Date.now() - 1000)).toBe(0); // 1 秒前
  });

  it('昨天返回 1', () => {
    expect(memoryAgeDays(Date.now() - DAY_MS)).toBe(1);
  });

  it('多天前返回正确天数', () => {
    expect(memoryAgeDays(Date.now() - 7 * DAY_MS)).toBe(7);
    expect(memoryAgeDays(Date.now() - 30 * DAY_MS)).toBe(30);
  });

  it('未来时间戳截断为 0', () => {
    expect(memoryAgeDays(Date.now() + DAY_MS)).toBe(0);
    expect(memoryAgeDays(Date.now() + 100 * DAY_MS)).toBe(0);
  });
});

describe('memoryAge', () => {
  it('今天返回"今天"', () => {
    expect(memoryAge(Date.now())).toBe('今天');
  });

  it('昨天返回"昨天"', () => {
    expect(memoryAge(Date.now() - DAY_MS)).toBe('昨天');
  });

  it('多天前返回"N 天前"', () => {
    expect(memoryAge(Date.now() - 5 * DAY_MS)).toBe('5 天前');
    expect(memoryAge(Date.now() - 100 * DAY_MS)).toBe('100 天前');
  });
});

describe('memoryFreshnessText', () => {
  it('今天和昨天返回空字符串', () => {
    expect(memoryFreshnessText(Date.now())).toBe('');
    expect(memoryFreshnessText(Date.now() - DAY_MS)).toBe('');
  });

  it('2 天以上返回警告文本', () => {
    const text = memoryFreshnessText(Date.now() - 5 * DAY_MS);
    expect(text).toContain('5 天');
    expect(text).toContain('验证');
  });
});

describe('memoryFreshnessNote', () => {
  it('今天返回空字符串', () => {
    expect(memoryFreshnessNote(Date.now())).toBe('');
  });

  it('过期记忆返回带 system-reminder 标签的提醒', () => {
    const note = memoryFreshnessNote(Date.now() - 10 * DAY_MS);
    expect(note).toContain('<system-reminder>');
    expect(note).toContain('</system-reminder>');
    expect(note).toContain('10 天');
  });
});
