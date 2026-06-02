import { describe, expect, it } from 'vitest';

import {
  coalesceToolResultsAfterAssistants,
  ensureToolCallPairing,
  normalizeMessages,
} from '../../src/harness/context-assembler.js';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('coalesceToolResultsAfterAssistants', () => {
  it('moves tool results before interleaved user blocks (resume-checkpoint)', () => {
    const input: UnifiedMessage[] = [
      { role: 'user', content: '<resume-checkpoint>\nphase: verification\n</resume-checkpoint>' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'read_file', arguments: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: 'tc-1', content: 'file body' },
    ];

    const out = coalesceToolResultsAfterAssistants(input);
    expect(out[1]?.role).toBe('assistant');
    expect(out[2]?.role).toBe('tool');
    expect(out[2]?.toolCallId).toBe('tc-1');
  });

  it('normalizeMessages repairs assistant → user → tool for API', () => {
    const input: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-2', name: 'run_command', arguments: { command: 'npm test' } }],
      },
      { role: 'user', content: '<resume-checkpoint>\nnextStep: fix\n</resume-checkpoint>' },
      { role: 'tool', toolCallId: 'tc-2', content: 'ok' },
    ];

    const out = normalizeMessages(input);
    const assistantIdx = out.findIndex(m => m.role === 'assistant' && m.toolCalls?.length);
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(out[assistantIdx + 1]?.role).toBe('tool');
    expect(out[assistantIdx + 1]?.toolCallId).toBe('tc-2');
  });
});

describe('ContextCompactor.compactForCheckpointResume · tool pairing', () => {
  it('does not leave tool before assistant after aggressive shrink', () => {
    const anchor = 'Implement survivors benchmark with npm test acceptance gate'.padEnd(90, '.');
    const resumeSummary = {
      role: 'user' as const,
      content: '<resume-checkpoint>\nphase: verification\n</resume-checkpoint>',
      preserveOnCompaction: true,
    };

    const input: UnifiedMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: anchor },
    ];
    for (let i = 0; i < 80; i++) {
      input.push(
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `tc-${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }],
        },
        { role: 'tool', toolCallId: `tc-${i}`, content: 'body '.repeat(300) },
      );
    }

    const compactor = new ContextCompactor({
      threshold: 9999,
      keepRecent: 20,
      keepRecentMinTokens: 50,
      keepRecentMaxTokens: 20_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
      maxReinjectFiles: 0,
      maxReinjectTokens: 0,
      maxToolResultLength: 400,
    });

    const forked = compactor.compactForCheckpointResume(input, resumeSummary, { aggressive: true });
    const repaired = ensureToolCallPairing(forked);

    for (let i = 0; i < repaired.length; i++) {
      if (repaired[i]?.role !== 'tool') continue;
      const prev = repaired[i - 1];
      expect(prev?.role === 'assistant' && (prev.toolCalls?.length ?? 0) > 0).toBe(true);
    }
  });
});
