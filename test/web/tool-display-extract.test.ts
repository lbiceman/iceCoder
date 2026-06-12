import { describe, expect, it } from 'vitest';
import {
  extractDiffSource,
  extractDiffSourceFromToolArgs,
  extractUnifiedDiffFromText,
  looksLikeUnifiedDiffText,
} from '../../src/web/tool-display-extract.js';

describe('tool-display-extract', () => {
  it('extracts patch_file patch from args', () => {
    const patch = '@@ -1,2 +1,3 @@\n-old\n+new\n context';
    expect(extractDiffSourceFromToolArgs('patch_file', { patch })).toBe(patch);
  });

  it('extracts unified diff from git output', () => {
    const out = '[git diff]\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new';
    const src = extractDiffSource('git', out);
    expect(src).toContain('@@ -1 +1 @@');
    expect(src).toContain('-old');
  });

  it('prefers patch args over empty output', () => {
    const patch = '@@ -1 +1 @@\n+line';
    expect(extractDiffSource('patch_file', '补丁已应用', { patch })).toBe(patch);
  });

  it('extracts patch-only hunks after summary line', () => {
    const out = '补丁已应用到 README.md\n  成功: 1/1 个 hunk\n\n@@ -10,2 +10,3 @@\n-old\n+new\n context';
    const src = extractUnifiedDiffFromText(out);
    expect(src).toMatch(/^@@ -10/);
    expect(src).toContain('-old');
    expect(src).toContain('+new');
  });

  it('looksLikeUnifiedDiffText detects embedded diff', () => {
    const out = 'File modified: a.txt\n\n--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-x\n+y';
    expect(looksLikeUnifiedDiffText(out)).toBe(true);
    expect(extractDiffSource('edit_file', out)).toContain('+y');
  });

  it('extracts diff from batch_edit_file output without tool whitelist gate', () => {
    const out = 'Batch edit: f.ts\n\n--- f.ts\n+++ f.ts\n@@ -1 +1 @@\n-a\n+b';
    expect(extractDiffSource('batch_edit_file', out)).toContain('+b');
  });
});
