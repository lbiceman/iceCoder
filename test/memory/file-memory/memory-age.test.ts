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
  getMemoryDecayStatus,
  memoryDecayFactor,
} from '../../../src/memory/file-memory/memory-age.js';
import type { MemoryHeader } from '../../../src/memory/file-memory/types.js';

const DAY_MS = 86_400_000;

function makeHeader(overrides: Partial<MemoryHeader>): MemoryHeader {
  return {
    filePath: '/tmp/test.md',
    filename: 'test.md',
    mtimeMs: Date.now(),
    description: null,
    type: undefined,
    confidence: 0.5,
    recallCount: 0,
    lastRecalledMs: 0,
    createdMs: Date.now(),
    tags: [],
    source: undefined,
    contentPreview: '',
    relatedTo: [],
    eventDateMs: 0,
    ...overrides,
  };
}

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

// ─── getMemoryDecayStatus ───

describe('getMemoryDecayStatus', () => {
  it('新建记忆返回 fresh', () => {
    const mem = makeHeader({ mtimeMs: Date.now() });
    expect(getMemoryDecayStatus(mem)).toBe('fresh');
  });

  it('90 天前的记忆返回 stale', () => {
    const mem = makeHeader({ mtimeMs: Date.now() - 91 * DAY_MS });
    expect(getMemoryDecayStatus(mem)).toBe('stale');
  });

  it('180 天前的记忆返回 expired', () => {
    const mem = makeHeader({ mtimeMs: Date.now() - 181 * DAY_MS });
    expect(getMemoryDecayStatus(mem)).toBe('expired');
  });

  it('高置信度（>=0.8）记忆衰减阈值翻倍', () => {
    // 90 天 + 高置信度 → 仍为 fresh（阈值 180 天）
    const highConf = makeHeader({ mtimeMs: Date.now() - 91 * DAY_MS, confidence: 1.0 });
    expect(getMemoryDecayStatus(highConf)).toBe('fresh');

    // 90 天 + 低置信度 → stale
    const lowConf = makeHeader({ mtimeMs: Date.now() - 91 * DAY_MS, confidence: 0.3 });
    expect(getMemoryDecayStatus(lowConf)).toBe('stale');
  });

  it('高置信度 180 天后仍为 stale（阈值 360 天才 expired）', () => {
    const mem = makeHeader({ mtimeMs: Date.now() - 181 * DAY_MS, confidence: 1.0 });
    expect(getMemoryDecayStatus(mem)).toBe('stale');
  });

  it('高置信度 360 天后为 expired', () => {
    const mem = makeHeader({ mtimeMs: Date.now() - 361 * DAY_MS, confidence: 1.0 });
    expect(getMemoryDecayStatus(mem)).toBe('expired');
  });

  it('lastRecalledMs 比 mtimeMs 更新时以 lastRecalledMs 为准', () => {
    // mtimeMs 很旧，但最近被召回过
    const mem = makeHeader({
      mtimeMs: Date.now() - 200 * DAY_MS,
      lastRecalledMs: Date.now() - 10 * DAY_MS,
    });
    expect(getMemoryDecayStatus(mem)).toBe('fresh');
  });
});

// ─── memoryDecayFactor ───

describe('memoryDecayFactor', () => {
  it('fresh 记忆返回 1.0', () => {
    const mem = makeHeader({ mtimeMs: Date.now() });
    expect(memoryDecayFactor(mem)).toBe(1.0);
  });

  it('stale 记忆返回 0.5', () => {
    const mem = makeHeader({ mtimeMs: Date.now() - 91 * DAY_MS });
    expect(memoryDecayFactor(mem)).toBe(0.5);
  });

  it('expired 记忆返回 0.1', () => {
    const mem = makeHeader({ mtimeMs: Date.now() - 181 * DAY_MS });
    expect(memoryDecayFactor(mem)).toBe(0.1);
  });

  it('衰减因子直接影响召回分数排序', () => {
    // 两个相同分数的记忆，fresh 应该排在 stale 前面
    const fresh = makeHeader({ filename: 'fresh.md', mtimeMs: Date.now(), confidence: 0.5 });
    const stale = makeHeader({ filename: 'stale.md', mtimeMs: Date.now() - 100 * DAY_MS, confidence: 0.5 });

    const freshScore = 1.0 * memoryDecayFactor(fresh);
    const staleScore = 1.0 * memoryDecayFactor(stale);

    expect(freshScore).toBeGreaterThan(staleScore);
  });
});
