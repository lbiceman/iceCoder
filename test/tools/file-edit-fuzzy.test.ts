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

  it('fuzzy replaceAll does not loop when replace extends search prefix', () => {
    const content = '  line1\n  line2\nrest';
    const search = 'line1\nline2';
    const replace = 'line1\nline2\nnew line';
    const result = applyNonRegexReplace(content, search, replace, true);
    expect(result.changed).toBe(true);
    expect(result.content).toBe('line1\nline2\nnew line\nrest');
    expect(result.content.match(/new line/g)).toHaveLength(1);
  });

  it('handles MEMORY.md index row insert without hanging', () => {
    const content = `## 用户偏好
| 文件 | 要点 |
|------|------|

| user_commit_style.md | desc |`;
    const search = '## 用户偏好\n| 文件 | 要点 |\n|------|------|';
    const replace = `## 用户偏好
| 文件 | 要点 |
|------|------|
| [Git commit](user_commit_style.md) — desc |`;
    const result = applyNonRegexReplace(content, search, replace, true);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('[Git commit](user_commit_style.md)');
    expect(result.content.match(/\[Git commit\]/g)).toHaveLength(1);
  });
});
