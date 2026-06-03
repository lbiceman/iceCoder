import { describe, expect, it } from 'vitest';
import {
  buildFileChangeDiff,
  formatToolOutputWithDiff,
  interleaveDeleteInsert,
} from '../../src/tools/file-change-diff.js';
import { extractDiffSource } from '../../src/web/tool-display-extract.js';

describe('file-change-diff', () => {
  it('builds unified diff for append', () => {
    const diff = buildFileChangeDiff('line1\nline2', 'line1\nline2\nnew line', 'README.md');
    expect(diff).toContain('--- README.md');
    expect(diff).toContain('+new line');
  });

  it('returns null when content unchanged', () => {
    expect(buildFileChangeDiff('same', 'same', 'a.txt')).toBeNull();
  });

  it('interleaves delete and insert lines in unified diff output', () => {
    const diff = buildFileChangeDiff('a\nb\nc', 'x\ny\nz', 'f.txt');
    expect(diff).toBeTruthy();
    const body = diff!.split('\n').filter(
      (l) => (l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---')),
    );
    expect(body).toEqual(['-a', '+x', '-b', '+y', '-c', '+z']);
  });

  it('interleaveDeleteInsert pairs consecutive blocks', () => {
    const out = interleaveDeleteInsert([
      { type: 'delete', oldIdx: 1, newIdx: 0, line: 'a' },
      { type: 'delete', oldIdx: 2, newIdx: 0, line: 'b' },
      { type: 'insert', oldIdx: 0, newIdx: 1, line: 'x' },
      { type: 'insert', oldIdx: 0, newIdx: 2, line: 'y' },
    ]);
    expect(out.map((c) => c.type + c.line)).toEqual(['deletea', 'insertx', 'deleteb', 'inserty']);
  });

  it('formatToolOutputWithDiff embeds diff after summary', () => {
    const out = formatToolOutputWithDiff('Content appended to: README.md', '--- README.md\n+++ README.md\n@@ -1 +1,2 @@\n line\n+new');
    expect(out).toContain('Content appended to');
    expect(out).toContain('--- README.md');
  });
});

describe('tool-display-extract file edits', () => {
  it('extracts diff from append_file output', () => {
    const output = formatToolOutputWithDiff(
      'Content appended to: README.zh-CN.md',
      buildFileChangeDiff('# Title', '# Title\n\nnew line', 'README.zh-CN.md'),
    );
    const src = extractDiffSource('append_file', output);
    expect(src).toContain('+new line');
  });

  it('extracts diff from edit_file output', () => {
    const diff = buildFileChangeDiff('hello world', 'hello iceCoder', 'a.txt');
    const output = formatToolOutputWithDiff('File modified: a.txt', diff);
    const src = extractDiffSource('edit_file', output);
    expect(src).toContain('+hello iceCoder');
    expect(src).toContain('-hello world');
  });
});
