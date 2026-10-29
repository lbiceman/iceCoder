/**
 * 硬压缩只改发给模型的视图：content 保留写入时的结果，read_file 按连续行重新分页。
 */
import { describe, expect, it } from 'vitest';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import { formatReadFileCappedPage } from '../../src/tools/read-file-page.js';
import { readFileRangeMeta } from '../../src/harness/tool-result-budget.js';
import { buildMessagesForLlm } from '../../src/harness/harness-api-messages.js';

const compactor = () => new ContextCompactor({
  threshold: 9999,
  keepRecent: 4,
  keepRecentMinTokens: 50,
  keepRecentMaxTokens: 10_000,
  keepRecentMinMessages: 2,
  enableLLMSummary: false,
  maxReinjectFiles: 0,
  maxReinjectTokens: 0,
  maxToolResultLength: 3_000,
});

describe('ContextCompactor.trimToolResults · view only', () => {
  it('shortens a command view but keeps content and points at the spill file', () => {
    const original = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\n');
    const msgs: UnifiedMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'run_command', arguments: { command: 'npm test' } }] },
      {
        role: 'tool', toolCallId: 'c', content: original,
        toolResultMeta: {
          toolName: 'run_command', strategy: 'full', originalChars: original.length, originalTokens: 4_000,
          injectedChars: original.length, injectedTokens: 4_000, spillPath: '/s/c.log',
        },
      },
    ];
    const out = compactor().trimToolResults(msgs);
    const tool = out[1];
    expect(tool.content).toBe(original);
    expect(tool.apiSealedBy).toBe('compaction');
    expect(String(tool.apiSealedContent).length).toBeLessThan(4_000);
    expect(tool.apiSealedContent).toContain('Full original output saved at: /s/c.log');
    expect(buildMessagesForLlm(out)[1].content).toBe(tool.apiSealedContent);
  });

  it('says the original was not saved when there is no spill file', () => {
    const original = 'x'.repeat(10_000);
    const msgs: UnifiedMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'g', name: 'grep', arguments: {} }] },
      { role: 'tool', toolCallId: 'g', content: original },
    ];
    const tool = compactor().trimToolResults(msgs)[1];
    expect(tool.content).toBe(original);
    expect(tool.apiSealedContent).toContain('the original output was not saved');
  });

  it('re-pages a read_file view by contiguous lines and records the omitted lines', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `.theme-${i} { color: #${String(i).padStart(6, '0')}; } /* ${'p'.repeat(20)} */`);
    const page = formatReadFileCappedPage('src/themes.css', lines, 1, 600, 50_000);
    const msgs: UnifiedMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'r', name: 'read_file', arguments: { path: 'src/themes.css' } }] },
      {
        role: 'tool', toolCallId: 'r', content: page.output,
        toolResultMeta: {
          toolName: 'read_file', strategy: 'full', originalChars: page.output.length, originalTokens: 10_000,
          injectedChars: page.output.length, injectedTokens: 10_000, ...readFileRangeMeta(page.range),
        },
      },
    ];
    const tool = compactor().trimToolResults(msgs)[1];
    expect(tool.content).toBe(page.output);
    expect(tool.apiSealedBy).toBe('compaction');
    const view = String(tool.apiSealedContent);
    expect(view).not.toContain('characters omitted from middle');
    expect(view).toContain('.theme-0 ');
    const end = tool.toolResultMeta!.lines!.end;
    expect(end).toBeLessThan(600);
    expect(view).toContain(`.theme-${end - 1} `);
    expect(view).not.toContain(`.theme-${end + 5} `);
    expect(tool.toolResultMeta!.omittedLines).toEqual([[end + 1, 600]]);
  });

  it('microcompact keeps short unsaved results and clears saved ones into a recoverable stub', () => {
    const c = new ContextCompactor({
      threshold: 9999, keepRecent: 1, keepRecentMinTokens: 50, keepRecentMaxTokens: 10_000, keepRecentMinMessages: 1,
      enableLLMSummary: false, maxReinjectFiles: 0, maxReinjectTokens: 0,
    });
    const short = 'a.ts\nb.ts\n'.repeat(40);
    const long = 'L'.repeat(5_000);
    const msgs: UnifiedMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 's', name: 'run_command', arguments: {} }, { id: 'l', name: 'run_command', arguments: {} }] },
      { role: 'tool', toolCallId: 's', content: short },
      {
        role: 'tool', toolCallId: 'l', content: long,
        toolResultMeta: { toolName: 'run_command', strategy: 'full', originalChars: 5_000, originalTokens: 1_250, injectedChars: 5_000, injectedTokens: 1_250, spillPath: '/s/l.log' },
      },
      { role: 'user', content: 'next' },
    ];
    const out = (c as unknown as { microcompact(m: UnifiedMessage[]): UnifiedMessage[] }).microcompact(msgs);
    expect(out[1]).toBe(msgs[1]);
    expect(out[2].content).toBe(long);
    expect(out[2].apiSealedBy).toBe('pressureClear');
    expect(out[2].apiSealedContent).toContain('Full original output saved at: /s/l.log');
  });

  it('leaves pressure-cleared placeholders alone', () => {
    const msgs: UnifiedMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'run_command', arguments: {} }] },
      { role: 'tool', toolCallId: 'c', content: 'y'.repeat(10_000), apiSealedContent: '[Old tool result cleared for context] stub', apiSealedBy: 'pressureClear' },
    ];
    const out = compactor().trimToolResults(msgs);
    expect(out[1]).toBe(msgs[1]);
  });
});
