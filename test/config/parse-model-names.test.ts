import { describe, it, expect } from 'vitest';
import {
  normalizeProviderActiveModel,
  parseModelNames,
  resolveActiveModelName,
} from '../../src/config/parse-model-names.js';

describe('parseModelNames', () => {
  it('splits comma-separated names and trims whitespace', () => {
    expect(parseModelNames('mimo2.5-pro,mimo-2.5')).toEqual(['mimo2.5-pro', 'mimo-2.5']);
    expect(parseModelNames(' a , b , a ')).toEqual(['a', 'b']);
  });

  it('returns empty array for blank input', () => {
    expect(parseModelNames('')).toEqual([]);
    expect(parseModelNames('  ,  ')).toEqual([]);
  });
});

describe('resolveActiveModelName', () => {
  it('uses activeModelName when valid', () => {
    expect(resolveActiveModelName({
      modelName: 'a,b',
      activeModelName: 'b',
    })).toBe('b');
  });

  it('falls back to first parsed name', () => {
    expect(resolveActiveModelName({ modelName: 'a,b' })).toBe('a');
    expect(resolveActiveModelName({ modelName: 'a,b', activeModelName: 'missing' })).toBe('a');
  });
});

describe('normalizeProviderActiveModel', () => {
  it('sets activeModelName to first name when missing or invalid', () => {
    expect(normalizeProviderActiveModel({ modelName: 'x,y' })).toEqual({
      modelName: 'x,y',
      activeModelName: 'x',
    });
    expect(normalizeProviderActiveModel({ modelName: 'x,y', activeModelName: 'y' })).toEqual({
      modelName: 'x,y',
      activeModelName: 'y',
    });
  });
});
