import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileTools } from '../../src/tools/builtin/file-tools.js';
import {
  formatReadFileCappedPage,
  linesFittingTokens,
  readFileOutputLines,
  repageReadFileOutput,
} from '../../src/tools/read-file-page.js';
import { estimateStringTokens } from '../../src/llm/token-estimator.js';

function themeCss(linesPerTheme: number): string {
  return ['dark', 'light', 'modern', 'fresh']
    .map(t => [`[data-theme="${t}"] {`, ...Array.from({ length: linesPerTheme }, (_, i) => `  --${t}-token-${i}: #123456;`), '}'].join('\n'))
    .join('\n');
}

describe('read-file-page helpers', () => {
  it('linesFittingTokens returns at least one line even when a single line exceeds the cap', () => {
    expect(linesFittingTokens(['x'.repeat(10_000)], 1, 10)).toBe(1);
  });

  it('capped page lists unread ranges and next offset without hollowing the middle', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1} ${'y'.repeat(40)}`);
    const page = formatReadFileCappedPage('big.txt', lines, 1, 500, 1_000);

    expect(page.range.capped).toBe(true);
    expect(page.range.endLine).toBeLessThan(500);
    expect(page.output).toContain(`(lines 1-${page.range.endLine} of 500, PARTIAL`);
    expect(page.output).toContain(`Unread: lines ${page.range.endLine + 1}-500`);
    expect(page.output).toContain(`Next: read_file offset=${page.range.endLine + 1}`);
    expect(page.output).toContain('do not assume it is absent');
    const body = readFileOutputLines(page.output, page.range);
    expect(body).toEqual(lines.slice(0, page.range.endLine));
  });

  it('repageReadFileOutput keeps contiguous lines and the original requested end', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `row ${i + 1} ${'z'.repeat(60)}`);
    const output = lines.join('\n');
    const range = {
      path: 'r.txt', startLine: 1, endLine: 300, requestedEnd: 300, totalLines: 300,
      numbered: false, headerLines: 0, capped: false,
    };

    expect(repageReadFileOutput(output, range, 100_000)).toBeNull();
    const repaged = repageReadFileOutput(output, range, 1_500)!;
    expect(repaged.range.requestedEnd).toBe(300);
    expect(repaged.range.endLine).toBeLessThan(300);
    expect(readFileOutputLines(repaged.output, repaged.range)).toEqual(lines.slice(0, repaged.range.endLine));
    expect(estimateStringTokens(repaged.output)).toBeLessThanOrEqual(1_500);
  });
});

describe('read_file handler paging', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-read-page-'));
    process.env.ICE_READ_FILE_MAX_TOKENS = '2000';
  });

  afterEach(async () => {
    delete process.env.ICE_READ_FILE_MAX_TOKENS;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function readTool() {
    return createFileTools(tmpDir, 'sess-page').find(t => t.definition.name === 'read_file')!;
  }

  it('returns a small file verbatim with a full readRange', async () => {
    const css = themeCss(10);
    await fs.writeFile(path.join(tmpDir, 'tokens.css'), css, 'utf-8');

    const res = await readTool().handler({ path: 'tokens.css' });

    expect(res.success).toBe(true);
    expect(res.output).toBe(css);
    expect(res.readRange).toMatchObject({ startLine: 1, totalLines: css.split('\n').length, capped: false, numbered: false });
  });

  it('pages a large theme file so every theme is reachable by following Next', async () => {
    const css = themeCss(80);
    const total = css.split('\n').length;
    await fs.writeFile(path.join(tmpDir, 'tokens.css'), css, 'utf-8');
    const tool = readTool();

    const first = await tool.handler({ path: 'tokens.css' });
    expect(first.success).toBe(true);
    expect(first.readRange!.capped).toBe(true);
    expect(first.output).toContain(`of ${total}, PARTIAL`);
    expect(first.output).not.toContain('[data-theme="fresh"]');

    const match = /Next: read_file offset=(\d+) limit=(\d+)/.exec(first.output);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(first.readRange!.endLine + 1);
    const limit = Number(match![2]);

    const seen = [first.output];
    let range = first.readRange!;
    for (let guard = 0; range.endLine < total && guard < 20; guard++) {
      const next = await tool.handler({ path: 'tokens.css', offset: range.endLine + 1, limit });
      expect(next.success).toBe(true);
      seen.push(next.output);
      range = next.readRange!;
    }
    expect(range.endLine).toBe(total);
    const joined = seen.join('\n');
    for (const t of ['dark', 'light', 'modern', 'fresh']) {
      expect(joined).toContain(`[data-theme="${t}"]`);
    }
  });

  it('rejects an explicit range over the cap and states the largest limit that fits', async () => {
    const css = themeCss(200);
    await fs.writeFile(path.join(tmpDir, 'tokens.css'), css, 'utf-8');

    const res = await readTool().handler({ path: 'tokens.css', offset: 1, limit: 800 });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/over the 2000-token read cap/);
    const fit = Number(/at most limit=(\d+)/.exec(res.error!)![1]);
    expect(fit).toBeGreaterThan(0);
    expect(res.readRangeRejected).toMatchObject({ startLine: 1, endLine: 800, capTokens: 2000 });

    const ok = await readTool().handler({ path: 'tokens.css', offset: 1, limit: fit });
    expect(ok.success).toBe(true);
    expect(ok.readRange).toMatchObject({ startLine: 1, endLine: fit, capped: false });
  });

  it('explicit range within the cap keeps the historical header format', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a\nb\nc\nd\n', 'utf-8');

    const res = await readTool().handler({ path: 'a.txt', offset: 2, limit: 2 });

    expect(res.output).toBe(`a.txt (lines 2-3, total 5)\n${'─'.repeat(40)}\n2: b\n3: c`);
  });
});
