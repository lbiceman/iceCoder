import { describe, expect, it } from 'vitest';
import {
  applyReasoningEffortToChatParams,
  applyReasoningEffortToResponsesParams,
  parseReasoningEffort,
  parseReasoningEffortLevels,
  parseReasoningEffortLevelsStrict,
  resolveWireReasoningEffort,
} from '../../src/llm/reasoning-effort.js';

describe('parseReasoningEffort', () => {
  it('accepts configured wire tokens including max', () => {
    expect(parseReasoningEffort('low')).toBe('low');
    expect(parseReasoningEffort('medium')).toBe('medium');
    expect(parseReasoningEffort('high')).toBe('high');
    expect(parseReasoningEffort('xhigh')).toBe('xhigh');
    expect(parseReasoningEffort('max')).toBe('max');
  });

  it('trims and lowercases', () => {
    expect(parseReasoningEffort(' MAX ')).toBe('max');
  });

  it('rejects invalid values', () => {
    expect(parseReasoningEffort(undefined)).toBeUndefined();
    expect(parseReasoningEffort(null)).toBeUndefined();
    expect(parseReasoningEffort('')).toBeUndefined();
    expect(parseReasoningEffort('!!!')).toBeUndefined();
    expect(parseReasoningEffort(2)).toBeUndefined();
  });
});

describe('parseReasoningEffortLevels', () => {
  it('parses comma-separated tokens and drops empties', () => {
    expect(parseReasoningEffortLevels(' low, high, max ')).toEqual(['low', 'high', 'max']);
    expect(parseReasoningEffortLevels('')).toEqual([]);
    expect(parseReasoningEffortLevels(undefined)).toEqual([]);
  });

  it('rejects illegal fragments on strict parse', () => {
    expect(parseReasoningEffortLevelsStrict('low,!!!')).toEqual({
      ok: false,
      error: '推理强度含非法档位：!!!',
    });
    expect(parseReasoningEffortLevelsStrict('low,high,max')).toEqual({
      ok: true,
      levels: ['low', 'high', 'max'],
      stored: 'low,high,max',
    });
  });
});

describe('resolveWireReasoningEffort', () => {
  it('omits the field when the provider has no ladder', () => {
    expect(resolveWireReasoningEffort('high', [])).toBeUndefined();
    expect(resolveWireReasoningEffort('high', undefined)).toBeUndefined();
  });

  it('maps UI values onto OpenCode Go low/high/max', () => {
    const allowed = ['low', 'high', 'max'];
    expect(resolveWireReasoningEffort('low', allowed)).toBe('low');
    expect(resolveWireReasoningEffort('high', allowed)).toBe('high');
    expect(resolveWireReasoningEffort('max', allowed)).toBe('max');
    expect(resolveWireReasoningEffort('medium', allowed)).toBe('high');
    expect(resolveWireReasoningEffort('xhigh', allowed)).toBe('high');
    expect(resolveWireReasoningEffort(undefined, allowed)).toBe('high');
  });
});

describe('applyReasoningEffort', () => {
  it('writes reasoning_effort on chat completions params', () => {
    const params: Record<string, unknown> = { model: 'omen-alpha' };
    applyReasoningEffortToChatParams(params, 'high');
    expect(params.reasoning_effort).toBe('high');
    applyReasoningEffortToChatParams(params, undefined);
    expect(params.reasoning_effort).toBe('high');
  });

  it('writes reasoning.effort on responses params without dropping other fields', () => {
    const params: Record<string, unknown> = { reasoning: { summary: 'auto' } };
    applyReasoningEffortToResponsesParams(params, 'max');
    expect(params.reasoning).toEqual({ summary: 'auto', effort: 'max' });
  });
});
