import { describe, expect, it } from 'vitest';
import type { ToolResultMeta, UnifiedMessage } from '../../src/llm/types.js';
import { enforcePreSendBudget } from '../../src/harness/context-budget-guard.js';
import { buildMessagesForLlm } from '../../src/harness/harness-api-messages.js';
import { estimateMessagesTokens } from '../../src/llm/token-estimator.js';

const meta = (extra: Partial<ToolResultMeta>): ToolResultMeta => ({
  toolName: 'run_command', strategy: 'full', originalChars: 1, originalTokens: 1, injectedChars: 1, injectedTokens: 1, ...extra,
});

function history(unsent: UnifiedMessage[]): UnifiedMessage[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'run_command', arguments: {} }] },
    { role: 'tool', toolCallId: 'old', content: 'O'.repeat(8_000), toolResultMeta: meta({ spillPath: '/s/old.log' }) },
    {
      role: 'assistant',
      content: '',
      toolCalls: unsent.map(m => ({ id: m.toolCallId!, name: m.toolResultMeta?.toolName ?? 'run_command', arguments: {} })),
    },
    ...unsent,
  ];
}

describe('enforcePreSendBudget', () => {
  it('does nothing when the request fits', () => {
    const msgs = history([{ role: 'tool', toolCallId: 'a', content: 'ok' }]);
    const before = msgs.map(m => m);
    const r = enforcePreSendBudget({ canonical: msgs, view: buildMessagesForLlm(msgs), contextWindowTokens: 128_000, maxOutputTokens: 16_000 });
    expect(r.shrunkResults).toBe(0);
    expect(r.overflowTokens).toBe(0);
    expect(msgs).toEqual(before);
  });

  it('shrinks only unsent results, largest first, until the request fits', () => {
    const msgs = history([
      { role: 'tool', toolCallId: 'big', content: 'B'.repeat(40_000), toolResultMeta: meta({ spillPath: '/s/big.log' }) },
      { role: 'tool', toolCallId: 'small', content: 'S'.repeat(6_000), toolResultMeta: meta({}) },
    ]);
    const total = estimateMessagesTokens(buildMessagesForLlm(msgs));
    const r = enforcePreSendBudget({
      canonical: msgs, view: buildMessagesForLlm(msgs), contextWindowTokens: total + 1_000, maxOutputTokens: 4_000,
    });
    expect(r.shrunkResults).toBe(1);
    expect(r.overflowTokens).toBe(0);
    const big = msgs.find(m => m.toolCallId === 'big')!;
    expect(big.content).toBe('B'.repeat(40_000));
    expect(big.apiSealedBy).toBe('resultBudget');
    expect(big.apiSealedContent).toContain('This is NOT the tool output');
    expect(big.apiSealedContent).toContain('/s/big.log');
    expect(big.toolResultMeta?.strategy).toBe('omitted');
    expect(msgs.find(m => m.toolCallId === 'small')!.apiSealedBy).toBeUndefined();
    expect(msgs.find(m => m.toolCallId === 'old')!.apiSealedBy).toBeUndefined();
    expect(estimateMessagesTokens(buildMessagesForLlm(msgs))).toBeLessThanOrEqual(r.limitTokens);
  });

  it('reports overflow when already-sent history alone is too large', () => {
    const msgs = history([{ role: 'tool', toolCallId: 'a', content: 'A'.repeat(4_000), toolResultMeta: meta({}) }]);
    const r = enforcePreSendBudget({ canonical: msgs, view: buildMessagesForLlm(msgs), contextWindowTokens: 3_000, maxOutputTokens: 1_000 });
    expect(r.shrunkResults).toBe(1);
    expect(r.overflowTokens).toBeGreaterThan(0);
    expect(msgs.find(m => m.toolCallId === 'old')!.apiSealedBy).toBeUndefined();
    expect(msgs.find(m => m.toolCallId === 'a')!.apiSealedContent).toContain('The output was not saved');
  });

  it('treats results before a final text reply as already sent', () => {
    const msgs: UnifiedMessage[] = [
      ...history([{ role: 'tool', toolCallId: 'a', content: 'A'.repeat(40_000), toolResultMeta: meta({}) }]),
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'next' },
    ];
    const r = enforcePreSendBudget({ canonical: msgs, view: buildMessagesForLlm(msgs), contextWindowTokens: 4_000, maxOutputTokens: 1_000 });
    expect(r.shrunkResults).toBe(0);
    expect(r.overflowTokens).toBeGreaterThan(0);
  });

  it('marks an omitted read as unseen lines rather than returned lines', () => {
    const msgs = history([{
      role: 'tool', toolCallId: 'r', content: 'L'.repeat(40_000),
      toolResultMeta: meta({ toolName: 'read_file', path: 'src/a.css', lines: { start: 1, end: 800, total: 800 } }),
    }]);
    enforcePreSendBudget({ canonical: msgs, view: buildMessagesForLlm(msgs), contextWindowTokens: 6_000, maxOutputTokens: 1_000 });
    const r = msgs.find(m => m.toolCallId === 'r')!;
    expect(r.apiSealedContent).toContain('lines 1-800 of 800 were not shown');
    expect(r.apiSealedContent).toContain('read_file path=src/a.css');
    expect(r.toolResultMeta?.lines).toBeUndefined();
    expect(r.toolResultMeta?.omittedLines).toEqual([[1, 800]]);
  });

  it('counts tool definitions against the limit', () => {
    const msgs = history([{ role: 'tool', toolCallId: 'a', content: 'ok' }]);
    const tools = Array.from({ length: 50 }, (_, i) => ({
      name: `t${i}`, description: 'd'.repeat(400), parameters: { type: 'object', properties: {} },
    }));
    const without = enforcePreSendBudget({ canonical: msgs, view: buildMessagesForLlm(msgs), contextWindowTokens: 20_000, maxOutputTokens: 1_000 });
    const withTools = enforcePreSendBudget({ canonical: msgs, view: buildMessagesForLlm(msgs), tools, contextWindowTokens: 20_000, maxOutputTokens: 1_000 });
    expect(withTools.totalTokens).toBeGreaterThan(without.totalTokens + 2_000);
  });
});
