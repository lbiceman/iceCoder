import { afterEach, describe, expect, it } from 'vitest';
import {
  EPHEMERAL_RESERVE_TOKENS,
  SPILL_ALWAYS_MIN_CHARS,
  classifyToolResult,
  findRereadTarget,
  measureLiveToolResultSavings,
  normalizeToolPath,
  resolveContextHardLimit,
  resolveToolResultBudget,
  shapeToolResult,
  shouldSpillToolResult,
  toolResultNeedsSpill,
} from '../../src/harness/tool-result-budget.js';
import { DEFAULT_AGENT_MAX_OUTPUT_TOKENS } from '../../src/config/model-capabilities.js';
import { getToolTokenCap } from '../../src/tools/tool-output-limits.js';
import { formatReadFileCappedPage } from '../../src/tools/read-file-page.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

const WINDOW_128K = 128_000;

describe('classifyToolResult', () => {
  it('maps tools and failures to budget classes', () => {
    expect(classifyToolResult('read_file', true)).toBe('file_read');
    expect(classifyToolResult('run_command', true)).toBe('command');
    expect(classifyToolResult('run_command', false)).toBe('failed_command');
    expect(classifyToolResult('grep', true)).toBe('search');
    expect(classifyToolResult('fetch_url', true)).toBe('web');
    expect(classifyToolResult('read_file', false)).toBe('default');
    expect(classifyToolResult('custom_tool', true)).toBe('default');
  });
});

describe('getToolTokenCap', () => {
  afterEach(() => {
    delete process.env.ICE_READ_FILE_MAX_TOKENS;
  });

  it('scales file reads by tier and honours the env override', () => {
    expect(getToolTokenCap('file_read', 'S')).toBe(8_000);
    expect(getToolTokenCap('file_read', 'L')).toBe(20_000);
    expect(getToolTokenCap('command', 'L')).toBe(10_000);
    expect(getToolTokenCap('search', 'XL')).toBe(5_000);
    process.env.ICE_READ_FILE_MAX_TOKENS = '30000';
    expect(getToolTokenCap('file_read', 'S')).toBe(30_000);
    process.env.ICE_READ_FILE_MAX_TOKENS = '10';
    expect(getToolTokenCap('file_read', 'S')).toBe(1_000);
  });
});

describe('resolveToolResultBudget', () => {
  it('uses the tier cap when there is plenty of room', () => {
    const b = resolveToolResultBudget({
      toolName: 'read_file', success: true, contextWindowTokens: WINDOW_128K,
      effectiveUsedTokens: 10_000, metadataMaxChars: Infinity, tier: 'L',
    });
    expect(b).toEqual({ cls: 'file_read', capTokens: 20_000, source: 'tier' });
  });

  it('hard limit reserves output and ephemeral blocks', () => {
    expect(resolveContextHardLimit(WINDOW_128K)).toBe(WINDOW_128K - DEFAULT_AGENT_MAX_OUTPUT_TOKENS - EPHEMERAL_RESERVE_TOKENS);
    expect(resolveContextHardLimit(WINDOW_128K, 8_000, 0)).toBe(120_000);
    expect(resolveContextHardLimit(10_000, 16_000)).toBe(0);
  });

  it('tightens to half of the remaining room under the hard limit', () => {
    const hardLimit = resolveContextHardLimit(WINDOW_128K);
    const b = resolveToolResultBudget({
      toolName: 'read_file', success: true, contextWindowTokens: WINDOW_128K,
      effectiveUsedTokens: hardLimit - 10_000, metadataMaxChars: Infinity, tier: 'L',
    });
    expect(b).toEqual({ cls: 'file_read', capTokens: 5_000, source: 'remaining' });
  });

  it('the 2000-token floor yields to the real remaining room', () => {
    const hardLimit = resolveContextHardLimit(WINDOW_128K);
    const at = (used: number) => resolveToolResultBudget({
      toolName: 'run_command', success: true, contextWindowTokens: WINDOW_128K,
      effectiveUsedTokens: used, metadataMaxChars: Infinity, tier: 'L',
    }).capTokens;
    expect(at(hardLimit - 3_000)).toBe(2_000);
    expect(at(hardLimit - 1_200)).toBe(1_200);
    expect(at(hardLimit)).toBe(0);
    expect(at(WINDOW_128K)).toBe(0);
  });

  it('honours a larger output reserve', () => {
    const b = resolveToolResultBudget({
      toolName: 'grep', success: true, contextWindowTokens: WINDOW_128K,
      effectiveUsedTokens: 90_000, metadataMaxChars: Infinity, tier: 'L', maxOutputTokens: 32_000,
    });
    expect(b).toEqual({ cls: 'search', capTokens: 2_000, source: 'remaining' });
  });

  it('char-capped classes also get a token cap when room is short', () => {
    const hardLimit = resolveContextHardLimit(WINDOW_128K);
    const failed = resolveToolResultBudget({
      toolName: 'run_command', success: false, contextWindowTokens: WINDOW_128K,
      effectiveUsedTokens: hardLimit - 4_000, metadataMaxChars: Infinity,
    });
    expect(failed.source).toBe('remaining');
    expect(failed.capTokens).toBe(2_000);
    expect(failed.capChars).toBeGreaterThanOrEqual(48_000);
  });

  it('keeps char caps for failed commands and default tools', () => {
    const failed = resolveToolResultBudget({
      toolName: 'run_command', success: false, contextWindowTokens: WINDOW_128K,
      effectiveUsedTokens: 0, metadataMaxChars: 1_000,
    });
    expect(failed.source).toBe('chars');
    expect(failed.capChars).toBeGreaterThanOrEqual(48_000);

    const other = resolveToolResultBudget({
      toolName: 'custom', success: true, contextWindowTokens: WINDOW_128K,
      effectiveUsedTokens: 0, metadataMaxChars: 1_000,
    });
    expect(other).toEqual({ cls: 'default', capChars: 1_000, source: 'chars' });
  });

  it('file reads with a readRange do not spill; everything else does', () => {
    const fileBudget = { cls: 'file_read' as const, capTokens: 1, source: 'tier' as const };
    const range = { path: 'a', startLine: 1, endLine: 1, requestedEnd: 1, totalLines: 1, numbered: false, headerLines: 0, capped: false };
    expect(toolResultNeedsSpill(fileBudget, range)).toBe(false);
    expect(toolResultNeedsSpill(fileBudget)).toBe(true);
    expect(toolResultNeedsSpill({ cls: 'command', capTokens: 1, source: 'tier' })).toBe(true);
  });

  it('spills long non-file results at write time even when they fit', () => {
    const command = { cls: 'command' as const, capTokens: 10_000, source: 'tier' as const };
    expect(shouldSpillToolResult('x'.repeat(SPILL_ALWAYS_MIN_CHARS), command)).toBe(false);
    expect(shouldSpillToolResult('x'.repeat(SPILL_ALWAYS_MIN_CHARS + 1), command)).toBe(true);
    expect(shouldSpillToolResult('x'.repeat(50), { cls: 'command', capTokens: 1, source: 'remaining' })).toBe(true);
    const range = { path: 'a', startLine: 1, endLine: 1, requestedEnd: 1, totalLines: 1, numbered: false, headerLines: 0, capped: false };
    expect(shouldSpillToolResult('x'.repeat(50_000), { cls: 'file_read', capTokens: 1, source: 'tier' }, range)).toBe(false);
  });
});

describe('shapeToolResult', () => {
  const tierBudget = (cls: 'file_read' | 'command' | 'search' | 'web', capTokens: number) =>
    ({ cls, capTokens, source: 'tier' as const });

  it('injects outputs that fit without any change', () => {
    const out = 'ok\n'.repeat(100);
    const shaped = shapeToolResult({ toolName: 'run_command', output: out, budget: tierBudget('command', 10_000) });
    expect(shaped.view).toBe(out);
    expect(shaped.meta).toMatchObject({ strategy: 'full', originalChars: out.length, injectedChars: out.length });
  });

  it('records a handler-capped read as a page with omitted lines', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `l${i} ${'q'.repeat(50)}`);
    const page = formatReadFileCappedPage('t.css', lines, 1, 400, 2_000);
    const shaped = shapeToolResult({
      toolName: 'read_file', output: page.output, budget: tierBudget('file_read', 20_000), readRange: page.range,
    });
    expect(shaped.view).toBe(page.output);
    expect(shaped.meta.strategy).toBe('page');
    expect(shaped.meta.lines).toEqual({ start: 1, end: page.range.endLine, total: 400 });
    expect(shaped.meta.omittedLines).toEqual([[page.range.endLine + 1, 400]]);
  });

  it('repages a read that exceeds the guarded budget instead of hollowing it', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `l${i} ${'q'.repeat(50)}`);
    const output = lines.join('\n');
    const range = { path: 't.css', startLine: 1, endLine: 400, requestedEnd: 400, totalLines: 400, numbered: false, headerLines: 0, capped: false };
    const shaped = shapeToolResult({ toolName: 'read_file', output, budget: tierBudget('file_read', 2_000), readRange: range });
    expect(shaped.meta.strategy).toBe('page');
    expect(shaped.view).toContain('PARTIAL');
    expect(shaped.view).not.toContain('输出已截断');
    expect(shaped.meta.omittedLines![0][1]).toBe(400);
  });

  it('keeps the head of search output and points to the spill file', () => {
    const output = Array.from({ length: 2_000 }, (_, i) => `src/f${i}.ts:1: match`).join('\n');
    const shaped = shapeToolResult({
      toolName: 'grep', output, budget: tierBudget('search', 1_000), spillPath: '/tmp/x.log',
    });
    expect(shaped.meta.strategy).toBe('head');
    expect(shaped.view.startsWith('src/f0.ts:1: match')).toBe(true);
    expect(shaped.view).toContain('共 2000 行');
    expect(shaped.view).toContain('Full output saved to: /tmp/x.log');
    expect(shaped.meta.spillPath).toBe('/tmp/x.log');
  });

  it('keeps head and tail of command output with total line count', () => {
    const output = Array.from({ length: 3_000 }, (_, i) => `log line ${i}`).join('\n');
    const shaped = shapeToolResult({
      toolName: 'run_command', output, budget: tierBudget('command', 2_000), spillPath: '/tmp/c.log',
    });
    expect(shaped.meta.strategy).toBe('head_tail');
    expect(shaped.view.startsWith('Total output lines: 3000\n')).toBe(true);
    expect(shaped.view).toContain('log line 0');
    expect(shaped.view).toContain('log line 2999');
    expect(shaped.meta.omittedChars![0]).toBeLessThan(shaped.meta.omittedChars![1]);
    expect(shaped.meta.injectedTokens).toBeLessThan(shaped.meta.originalTokens);
  });

  it('uses tail-heavy truncation for failed commands', () => {
    const output = 'x'.repeat(100_000);
    const shaped = shapeToolResult({
      toolName: 'run_command', output, budget: { cls: 'failed_command', capChars: 50_000, source: 'chars' },
    });
    expect(shaped.meta.strategy).toBe('tail');
    expect(shaped.view.length).toBeLessThan(output.length);
  });

  it('respects a token cap on a failed command when room is short', () => {
    const output = 'error line\n'.repeat(5_000);
    const shaped = shapeToolResult({
      toolName: 'run_command', output,
      budget: { cls: 'failed_command', capChars: 50_000, capTokens: 1_000, source: 'remaining' },
      spillPath: '/tmp/f.log',
    });
    expect(shaped.meta.injectedTokens).toBeLessThan(1_300);
    expect(shaped.view).toContain('Full output saved to: /tmp/f.log');
  });

  it('injects only a recovery note once the round budget is used up', () => {
    const output = Array.from({ length: 500 }, (_, i) => `row ${i} ${'z'.repeat(40)}`).join('\n');
    const shaped = shapeToolResult({
      toolName: 'run_command', output, budget: { cls: 'command', capTokens: 0, source: 'remaining' }, spillPath: '/tmp/o.log',
    });
    expect(shaped.meta.strategy).toBe('omitted');
    expect(shaped.view).toContain('This is NOT the tool output');
    expect(shaped.view).toContain('read_file path="/tmp/o.log"');
    expect(shaped.view).not.toContain('row 0');
  });

  it('omitted reads point at the exact lines and say nothing was saved otherwise', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `l${i} ${'q'.repeat(50)}`);
    const range = { path: 't.css', startLine: 1, endLine: 300, requestedEnd: 300, totalLines: 300, numbered: false, headerLines: 0, capped: false };
    const read = shapeToolResult({ toolName: 'read_file', output: lines.join('\n'), budget: { cls: 'file_read', capTokens: 100, source: 'remaining' }, readRange: range });
    expect(read.meta.strategy).toBe('omitted');
    expect(read.meta.omittedLines).toEqual([[1, 300]]);
    expect(read.meta.lines).toBeUndefined();
    expect(read.view).toContain('read_file path=t.css offset=1');

    const cmd = shapeToolResult({ toolName: 'grep', output: 'm\n'.repeat(2_000), budget: { cls: 'search', capTokens: 0, source: 'remaining' } });
    expect(cmd.view).toContain('The output was not saved');
  });

  it('still injects tiny outputs when the budget is used up', () => {
    const shaped = shapeToolResult({ toolName: 'run_command', output: 'exit 0', budget: { cls: 'command', capTokens: 0, source: 'remaining' } });
    expect(shaped.view).toBe('exit 0');
    expect(shaped.meta.strategy).toBe('full');
  });

  it('without a spill file the truncation marker says the rest is not recoverable', () => {
    const output = Array.from({ length: 3_000 }, (_, i) => `log line ${i}`).join('\n');
    const shaped = shapeToolResult({ toolName: 'run_command', output, budget: tierBudget('command', 1_000) });
    expect(shaped.view).toContain('The full output was not saved');
  });
});

describe('findRereadTarget', () => {
  const readMsg = (id: string, extra: Partial<UnifiedMessage>): UnifiedMessage => ({
    role: 'tool',
    toolCallId: id,
    content: 'body',
    ...extra,
  });

  it('detects reading lines a previous page omitted', () => {
    const msgs: UnifiedMessage[] = [
      readMsg('r1', {
        toolResultMeta: {
          toolName: 'read_file', strategy: 'page', originalChars: 1, originalTokens: 1, injectedChars: 1, injectedTokens: 1,
          path: 'src\\Tokens.css', lines: { start: 1, end: 100, total: 300 }, omittedLines: [[101, 300]],
        },
      }),
    ];
    expect(findRereadTarget(msgs, './src/Tokens.css', [101, 200])).toEqual({ toolCallId: 'r1', reason: 'paged' });
    expect(findRereadTarget(msgs, 'src/Tokens.css', [1, 50])).toBeNull();
    expect(findRereadTarget(msgs, 'other.css', [101, 200])).toBeNull();
  });

  it('detects re-reading a pressure-cleared range', () => {
    const msgs: UnifiedMessage[] = [
      readMsg('r1', {
        apiSealedContent: 'stub',
        apiSealedBy: 'pressureClear',
        toolResultMeta: {
          toolName: 'read_file', strategy: 'full', originalChars: 1, originalTokens: 1, injectedChars: 1, injectedTokens: 1,
          path: 'a.ts', lines: { start: 1, end: 50, total: 50 },
        },
      }),
    ];
    expect(findRereadTarget(msgs, 'a.ts', [10, 20])).toEqual({ toolCallId: 'r1', reason: 'cleared' });
  });

  it('detects reading a spilled output file', () => {
    const msgs: UnifiedMessage[] = [
      readMsg('c1', {
        toolResultMeta: {
          toolName: 'run_command', strategy: 'head_tail', originalChars: 1, originalTokens: 1, injectedChars: 1, injectedTokens: 1,
          spillPath: 'D:\\data\\tool-output\\s\\c1.log',
        },
      }),
    ];
    expect(findRereadTarget(msgs, 'D:/data/tool-output/s/c1.log')).toEqual({ toolCallId: 'c1', reason: 'spill' });
    expect(findRereadTarget(msgs, 'D:/data/tool-output/s/c1.log', [1, 50])).toEqual({ toolCallId: 'c1', reason: 'spill' });
    expect(findRereadTarget(msgs, 'D:/data/tool-output/s/other.log')).toBeNull();
  });

  it('normalizes separators and leading ./', () => {
    expect(normalizeToolPath('./src\\a.ts')).toBe('src/a.ts');
  });
});

describe('measureLiveToolResultSavings', () => {
  const meta = (extra: Partial<NonNullable<UnifiedMessage['toolResultMeta']>>): NonNullable<UnifiedMessage['toolResultMeta']> => ({
    toolName: 'run_command', strategy: 'full', originalChars: 4000, originalTokens: 1000, injectedChars: 4000, injectedTokens: 1000, ...extra,
  });

  it('separates shaped savings, cleared savings and reread cost', () => {
    const msgs: UnifiedMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'tool', toolCallId: 'a', content: 'x', toolResultMeta: meta({ strategy: 'head_tail', injectedTokens: 300 }) },
      { role: 'tool', toolCallId: 'b', content: 'y'.repeat(4000), apiSealedContent: 'stub', apiSealedBy: 'pressureClear', toolResultMeta: meta({}) },
      { role: 'tool', toolCallId: 'c', content: 'z', toolResultMeta: meta({ toolName: 'read_file', rereadOf: 'a', injectedTokens: 200 }) },
      { role: 'tool', toolCallId: 'd', content: 'w', toolResultMeta: meta({ strategy: 'range_error', injectedTokens: 10 }) },
    ];
    const s = measureLiveToolResultSavings(msgs);
    expect(s.shapedSavedTokens).toBe(700);
    expect(s.shapedResults).toBe(1);
    expect(s.clearedResults).toBe(1);
    expect(s.clearedSavedTokens).toBeGreaterThan(990);
    expect(s.rereadTokens).toBe(200);
    expect(s.rereadResults).toBe(1);
  });

  it('estimates what a handler-capped read page did not send', () => {
    const s = measureLiveToolResultSavings([{
      role: 'tool', toolCallId: 'p', content: 'x',
      toolResultMeta: meta({
        toolName: 'read_file', strategy: 'page', originalTokens: 8_000, injectedTokens: 8_000,
        lines: { start: 1, end: 1_000, total: 3_000 }, omittedLines: [[1_001, 3_000]],
      }),
    }]);
    expect(s.shapedSavedTokens).toBe(16_000);
  });
});
