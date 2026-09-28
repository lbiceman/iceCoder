import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateExecutionModeSeries,
  aggregateExecutionModeStats,
  extractExecutionModeEvents,
  filterExecutionModeEvents,
  formatExecutionModeReport,
  readJsonlFile,
} from '../../../src/web/routes/supervisor-events.js';

describe('execution-mode telemetry API helpers', () => {
  it('reads recent JSONL records and ignores corrupt lines', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-mode-events-'));
    const file = path.join(dir, 'telemetry.jsonl');
    await fs.writeFile(file, [
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'execution_mode_enter', round: 2 }),
      '{broken',
    ].join('\n'));
    expect(await readJsonlFile(file, 7)).toHaveLength(1);
  });

  it('extracts only execution-mode events', () => {
    const events = extractExecutionModeEvents([
      {
        timestamp: new Date().toISOString(),
        type: 'execution_mode_enter',
        executionMode: 'forced',
        round: 3,
        enteredBy: ['tool_failure'],
        primaryReasonHuman: '工具失败',
      },
      { type: 'other' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.executionMode).toBe('forced');
  });

  it('aggregates enter/exit counts and primary signals', () => {
    const stats = aggregateExecutionModeStats([
      {
        type: 'execution_mode_enter',
        timestamp: 't1',
        payload: {
          executionMode: 'forced',
          enteredBy: ['tool_failure', 'multi_write'],
          enteredByPrimary: 'tool_failure',
          primaryReasonHuman: '工具失败',
          round: 2,
        },
      },
      {
        type: 'execution_mode_enter',
        timestamp: 't2',
        payload: {
          executionMode: 'forced',
          enteredBy: ['multi_write'],
          enteredByPrimary: 'multi_write',
          primaryReasonHuman: '多文件写入',
          round: 4,
        },
      },
      {
        type: 'execution_mode_exit',
        timestamp: 't3',
        payload: {
          executionMode: 'free',
          enteredBy: ['tool_failure'],
          enteredByPrimary: 'tool_failure',
          primaryReasonHuman: 'free',
          round: 6,
        },
      },
    ]);
    expect(stats.enter).toBe(2);
    expect(stats.exit).toBe(1);
    expect(stats.byMode).toEqual({ forced: 2 });
    expect(stats.bySignal).toEqual({ tool_failure: 1, multi_write: 1 });
    expect(stats.recent).toHaveLength(3);
  });

  it('buckets enter/exit into a rolling window', () => {
    const now = Date.parse('2026-09-21T15:30:00+08:00');
    const series = aggregateExecutionModeSeries([
      {
        type: 'execution_mode_enter',
        timestamp: new Date(now - 2 * 86_400_000).toISOString(),
        payload: {
          executionMode: 'forced',
          enteredBy: ['tool_failure'],
          enteredByPrimary: 'tool_failure',
          primaryReasonHuman: '工具失败',
          round: 2,
        },
      },
      {
        type: 'execution_mode_exit',
        timestamp: new Date(now).toISOString(),
        payload: {
          executionMode: 'free',
          enteredBy: [],
          primaryReasonHuman: 'free',
          round: 6,
        },
      },
    ], 7, now);
    expect(series).toHaveLength(7);
    expect(series.reduce((sum, row) => sum + row.enter, 0)).toBe(1);
    expect(series.reduce((sum, row) => sum + row.exit, 0)).toBe(1);
    expect(series[series.length - 1]?.exit).toBe(1);
  });

  it('keeps rolling 24h enters that sit before the first hour tick', () => {
    const now = Date.parse('2026-09-21T15:30:00+08:00');
    const series = aggregateExecutionModeSeries([
      {
        type: 'execution_mode_enter',
        timestamp: new Date(now - 23.5 * 3_600_000).toISOString(),
        payload: {
          executionMode: 'forced',
          enteredBy: ['tool_failure'],
          enteredByPrimary: 'tool_failure',
          primaryReasonHuman: '工具失败',
          round: 2,
        },
      },
    ], 1, now);
    expect(series).toHaveLength(24);
    expect(series[0]?.enter).toBe(1);
  });

  it('formats a compact text report for ~supervisor without changing JSON stats', () => {
    const stats = aggregateExecutionModeStats([
      {
        type: 'execution_mode_enter',
        timestamp: 't1',
        payload: {
          executionMode: 'forced',
          enteredBy: ['tool_failure'],
          enteredByPrimary: 'tool_failure',
          primaryReasonHuman: '工具失败',
          round: 2,
        },
      },
      {
        type: 'execution_mode_exit',
        timestamp: 't2',
        payload: {
          executionMode: 'free',
          enteredBy: ['tool_failure'],
          enteredByPrimary: 'tool_failure',
          primaryReasonHuman: 'free',
          round: 6,
        },
      },
    ]);
    const report = formatExecutionModeReport(stats, 7);
    expect(report).toContain('**执行模式报告**（最近 7 天）');
    expect(report).toContain('**进入** 1 次 | 退出 1 次');
    expect(report).toContain('forced:1');
    expect(report).toContain('工具失败:1');
    expect(report).toContain('- 进入 forced · 工具失败 · 第 2 轮');
    expect(report).toContain('- 退出 free · 第 6 轮');
    expect(stats.enter).toBe(1);
    expect(stats.exit).toBe(1);
    expect(stats.recent).toHaveLength(2);
  });

  it('returns an empty-state text report when there are no events', () => {
    const report = formatExecutionModeReport({
      enter: 0,
      exit: 0,
      byMode: {},
      bySignal: {},
      recent: [],
    }, 7);
    expect(report).toContain('暂无监管触发记录。');
  });

  it('filters events for the text report only', () => {
    const events = extractExecutionModeEvents([
      {
        timestamp: new Date().toISOString(),
        type: 'execution_mode_enter',
        executionMode: 'forced',
        enteredBy: ['tool_failure'],
        enteredByPrimary: 'tool_failure',
        primaryReasonHuman: '工具失败',
        round: 2,
      },
      {
        timestamp: new Date().toISOString(),
        type: 'execution_mode_enter',
        executionMode: 'forced',
        enteredBy: ['multi_write'],
        enteredByPrimary: 'multi_write',
        primaryReasonHuman: '多文件写入',
        round: 4,
      },
      {
        timestamp: new Date().toISOString(),
        type: 'execution_mode_exit',
        executionMode: 'free',
        round: 6,
      },
    ]);
    expect(filterExecutionModeEvents(events, 'enter')).toHaveLength(2);
    expect(filterExecutionModeEvents(events, 'tool_failure')).toHaveLength(1);
    expect(filterExecutionModeEvents(events, '')).toEqual(events);
  });
});
