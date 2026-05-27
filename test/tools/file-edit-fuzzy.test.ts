import { describe, expect, it } from 'vitest';
import { findReplaceRange, applyNonRegexReplace } from '../../src/tools/file-edit-fuzzy.js';

describe('findReplaceRange', () => {
  it('matches exact substring', () => {
    const content = 'alpha\nbeta\ngamma';
    const range = findReplaceRange(content, 'beta');
    expect(range).toEqual({ start: 6, end: 10, matched: 'beta' });
  });

  it('matches when trailing whitespace differs', () => {
    const content = 'function foo() {\n  return 1;  \n}';
    const search = 'function foo() {\n  return 1;\n}';
    const range = findReplaceRange(content, search);
    expect(range).not.toBeNull();
    expect(content.slice(range!.start, range!.end)).toContain('return 1');
  });

  it('matches line-trimmed multiline block', () => {
    const content = '  line1\n  line2\n  line3';
    const search = 'line1\nline2';
    const range = findReplaceRange(content, search);
    expect(range).not.toBeNull();
  });

  it('returns null when no match', () => {
    expect(findReplaceRange('abc', 'xyz')).toBeNull();
  });
});

describe('applyNonRegexReplace', () => {
  it('uses fuzzy loop when exact substring is absent', () => {
    const content = '  foo\n  bar\n  foo';
    const result = applyNonRegexReplace(content, 'foo\nbar', 'baz', true);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('baz');
    expect(result.fuzzy).toBe(true);
  });

  it('replaces once with fuzzy single match', () => {
    const content = '  line1\n  line2';
    const result = applyNonRegexReplace(content, 'line1\nline2', 'X', false);
    expect(result.changed).toBe(true);
    expect(result.fuzzy).toBe(true);
  });
});
