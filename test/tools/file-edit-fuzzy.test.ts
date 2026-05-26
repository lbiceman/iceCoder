import { describe, expect, it } from 'vitest';
import { findReplaceRange } from '../../src/tools/file-edit-fuzzy.js';

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
