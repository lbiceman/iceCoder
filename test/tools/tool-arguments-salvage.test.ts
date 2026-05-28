import { describe, expect, it } from 'vitest';
import { salvageTruncatedToolJson } from '../../src/tools/tool-arguments-salvage.js';
import { planTruncatedWriteToolRecovery, shouldPlanTruncatedWriteToolRecovery, writeToolMissingRequiredPath } from '../../src/harness/harness-tool-truncation-recovery.js';

describe('salvageTruncatedToolJson', () => {
  it('extracts path and partial content from truncated JSON', () => {
    const raw = '{"path":"src/a.ts","content":"import x\\nfrom';
    const salvaged = salvageTruncatedToolJson(raw);
    expect(salvaged).toMatchObject({
      path: 'src/a.ts',
      content: 'import x\nfrom',
      _salvageTruncated: true,
    });
  });

  it('extracts edit_file search field', () => {
    const raw = '{"path":"a.ts","search":"foo","replace":"bar';
    const salvaged = salvageTruncatedToolJson(raw);
    expect(salvaged?.path).toBe('a.ts');
    expect(salvaged?.search).toBe('foo');
    expect(salvaged?.replace).toBe('bar');
  });
});

describe('planTruncatedWriteToolRecovery', () => {
  it('skips write tools and keeps read tools', () => {
    const plan = planTruncatedWriteToolRecovery([
      { id: '1', name: 'write_file', arguments: { path: 'a.ts', content: 'x' } },
      { id: '2', name: 'read_file', arguments: { path: 'a.ts' } },
    ]);
    expect(plan.skippedWriteCalls).toHaveLength(1);
    expect(plan.toolCallsToRun).toHaveLength(1);
    expect(plan.toolCallsToRun[0]!.name).toBe('read_file');
    expect(plan.injectedMessages).toHaveLength(2);
  });
});

describe('shouldPlanTruncatedWriteToolRecovery', () => {
  it('detects finishReason=length with write tools', () => {
    expect(shouldPlanTruncatedWriteToolRecovery({
      toolCalls: [{ id: '1', name: 'write_file', arguments: { path: 'a.ts', content: 'x' } }],
      finishReason: 'length',
      outputTokens: 8000,
      maxOutputTokens: 16384,
    })).toBe(true);
  });

  it('detects tool_calls + output ceiling + missing path + large content', () => {
    expect(shouldPlanTruncatedWriteToolRecovery({
      toolCalls: [{ id: '1', name: 'write_file', arguments: { content: 'x'.repeat(600) } }],
      finishReason: 'tool_calls',
      outputTokens: 16384,
      maxOutputTokens: 16384,
    })).toBe(true);
    expect(writeToolMissingRequiredPath({ id: '1', name: 'write_file', arguments: { content: 'x' } })).toBe(true);
  });

  it('does not skip write when path present and output below ceiling', () => {
    expect(shouldPlanTruncatedWriteToolRecovery({
      toolCalls: [{ id: '1', name: 'write_file', arguments: { path: 'a.ts', content: 'ok' } }],
      finishReason: 'tool_calls',
      outputTokens: 100,
      maxOutputTokens: 16384,
    })).toBe(false);
  });
});
