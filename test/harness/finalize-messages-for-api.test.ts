import { describe, expect, it } from 'vitest';

import { finalizeMessagesForApi } from '../../src/harness/context-assembler.js';
import { isToolCallPairingError } from '../../src/harness/checkpoint-resume-compact.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('finalizeMessagesForApi', () => {
  it('coalesces tool results after assistant when user block was inserted between', () => {
    const input: UnifiedMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'run_command', arguments: { action: 'list' } }],
      },
      { role: 'user', content: '<resume-checkpoint>\nphase: x\n</resume-checkpoint>' },
      { role: 'tool', toolCallId: 'tc-1', content: 'ok' },
    ];
    const out = finalizeMessagesForApi(input);
    expect(out[1]?.role).toBe('tool');
    expect(out[1]?.toolCallId).toBe('tc-1');
    expect(out[2]?.role).toBe('user');
  });
});

describe('isToolCallPairingError', () => {
  it('detects vendor-specific pairing error messages', () => {
    expect(isToolCallPairingError(new Error('400 invalid params, tool call result does not follow tool call (2013)'))).toBe(true);
    expect(isToolCallPairingError(new Error('network timeout'))).toBe(false);
  });
});
