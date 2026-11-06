import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { classicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDiffViewer() {
  const src = classicWindowSource(readFileSync(path.join(__dirname, '../../src/public/js/diff-viewer.ts'), 'utf-8'));
  const ctx: {
    window: { DiffViewer?: unknown };
    DiffViewer?: { renderFromText: (t: string, o?: object) => unknown; parseChangesOnly: (t: string) => unknown[] };
  } = { window: {} };
  runInNewContext(src, ctx);
  return ctx.window.DiffViewer as NonNullable<typeof ctx.window.DiffViewer> & {
    extractUnifiedDiff: (t: string) => string | null;
    buildDisplayItems: (c: unknown[]) => Array<{ change?: unknown; omit?: boolean; omitted?: number }>;
  };
}

describe('diff-viewer edit_file output', () => {
  const diff = `--- README.zh-CN.md
+++ README.zh-CN.md
@@ -287,4 +287,4 @@
 
 ISC
 
-<!-- 这是一行测试文字 -->
+我是iceCoder，模型：mimo-2.5-pro`;

  it('parses changes from embedded tool output', () => {
    const DV = loadDiffViewer();
    const wrapped = `File modified: README.zh-CN.md\n\n${diff}`;
    const extracted = (DV as { extractUnifiedDiff: (t: string) => string | null }).extractUnifiedDiff(wrapped);
    const files = DV.parseChangesOnly(extracted || '');
    expect(files.length).toBe(1);
    expect(files[0].changes.length).toBe(2);
    expect(files[0].changes[0]).toMatchObject({ type: 'del', lineNum: 290, content: '<!-- 这是一行测试文字 -->' });
    expect((DV as { countDiffLineStats: (t: string) => { add: number; del: number } | null }).countDiffLineStats(wrapped))
      .toEqual({ add: 1, del: 1 });
    expect(files[0].changes[1]).toMatchObject({ type: 'add', lineNum: 290, content: '我是iceCoder，模型：mimo-2.5-pro' });
  });

  it('interleaves bulk delete+insert blocks for line-by-line display', () => {
    const DV = loadDiffViewer();
    const diff = `--- a.txt
+++ b.txt
@@ -1,3 +1,3 @@
-old1
-old2
-old3
+new1
+new2
+new3`;
    const files = DV.parseChangesOnly(diff);
    expect(files[0].changes.map(function (c) { return c.type + ':' + c.content; })).toEqual([
      'del:old1', 'add:new1', 'del:old2', 'add:new2', 'del:old3', 'add:new3',
    ]);
  });

  it('extracts patch-only hunks after tool summary', () => {
    const DV = loadDiffViewer();
    const wrapped = '补丁已应用\n\n@@ -5,1 +5,1 @@\n-old line\n+new line';
    const extracted = (DV as { extractUnifiedDiff: (t: string) => string | null }).extractUnifiedDiff(wrapped);
    expect(extracted).toMatch(/^@@ -5/);
    const files = DV.parseChangesOnly(extracted || '');
    expect(files[0].changes.length).toBe(2);
  });

  it('buildDisplayItems shows head, omit, tail for large diffs', () => {
    const DV = loadDiffViewer();
    const build = (DV as { buildDisplayItems: (c: unknown[]) => Array<{ change?: unknown; omit?: boolean; omitted?: number }> }).buildDisplayItems;
    const changes = Array.from({ length: 120 }, (_, i) => ({ type: 'add', content: 'line' + i, lineNum: i + 1 }));
    const items = build(changes);
    expect(items.length).toBe(101);
    expect(items[50].omit).toBe(true);
    expect(items[50].omitted).toBe(20);
    expect(items[0].change).toMatchObject({ content: 'line0' });
    expect(items[100].change).toMatchObject({ content: 'line119' });
  });

  it('counts added and deleted lines across files', () => {
    const DV = loadDiffViewer() as { countDiffLineStats: (t: string) => { add: number; del: number } | null };
    const created = `File written: tmp/a.mjs\n\n--- /dev/null\n+++ b/tmp/a.mjs\n@@ -0,0 +1,3 @@\n+one\n+two\n+three`;
    expect(DV.countDiffLineStats(created)).toEqual({ add: 3, del: 0 });
    const multi = `--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1,2 +1 @@\n keep\n-gone\n`;
    expect(DV.countDiffLineStats(multi)).toEqual({ add: 1, del: 2 });
    expect(DV.countDiffLineStats('command finished')).toBeNull();
  });
});
