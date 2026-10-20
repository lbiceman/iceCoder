import { describe, expect, it } from 'vitest';

import { AGENT_EVAL_SUITES, agentEvalCases } from '../../scripts/agent-eval-cases.js';
import {
  formatComparison,
  median,
  parseHistory,
  summarizeCase,
  type HistoryRecord,
} from '../../scripts/agent-eval-compare.js';

function record(label: string, tokens: Record<string, number>, passed = true): HistoryRecord {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    mode: 'real',
    label,
    suite: 'context',
    model: { providerId: 'p', model: 'm' },
    results: Object.entries(tokens).map(([id, totalTokens]) => ({
      id,
      passed,
      ...(passed ? {} : { failures: ['expected npm test to pass'] }),
      stats: { totalTokens, llmCalls: 3, toolCalls: 2, peakPromptTokens: Math.round(totalTokens / 3) },
    })),
  };
}

describe('agent-eval compare', () => {
  it('every suite case exists', () => {
    const ids = new Set(agentEvalCases.map(c => c.id));
    for (const groups of Object.values(AGENT_EVAL_SUITES)) {
      for (const id of groups.flatMap(g => g.cases)) expect(ids.has(id), id).toBe(true);
    }
  });

  it('median handles odd and even counts', () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
  });

  it('summarizes runs including failed ones', () => {
    const s = summarizeCase([
      ...record('a', { x: 100 }).results,
      ...record('a', { x: 300 }, false).results,
      ...record('a', { x: 200 }).results,
    ]);
    expect(s).toMatchObject({ runs: 3, passes: 2, medianTokens: 200, meanTokens: 200 });
    expect(s.failures).toEqual(['expected npm test to pass']);
  });

  it('reports per-case and total token deltas and flags model mismatch', () => {
    const base = [record('base', { 'model-led-three-file-bugfix': 1000 }), record('base', { 'model-led-three-file-bugfix': 1200 })];
    const next = [record('new', { 'model-led-three-file-bugfix': 800 }), record('new', { 'model-led-three-file-bugfix': 900 })];
    const text = formatComparison({ base, next, suite: 'context' });
    expect(text).toContain('| 多文件修改 | model-led-three-file-bugfix | 2/2 | 2/2 | 1100 | 850 | -23% |');
    expect(text).not.toContain('两边模型不一致');

    const other = next.map(r => ({ ...r, model: { providerId: 'q', model: 'other' } }));
    expect(formatComparison({ base, next: other, suite: 'context' })).toContain('两边模型不一致');
  });

  it('parses JSONL with blank and CRLF lines', () => {
    const line = JSON.stringify(record('x', { a: 1 }));
    expect(parseHistory(`${line}\r\n\r\n${line}\n`)).toHaveLength(2);
  });
});
