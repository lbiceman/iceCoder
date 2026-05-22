import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '../../src/llm/types.js';
import { executeToolCallsThroughGate } from '../../src/harness/supervisor/tool-gate.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function call(id: string, name: string): ToolCall {
  return { id, name, arguments: { path: `${name}.txt` } };
}

describe('ToolGate - Batch 5', () => {
  it('does not enable step gate in free mode even when graph hints block', () => {
    const toolCalls = [call('tc1', 'edit_file')];
    const messages: UnifiedMessage[] = [];

    const result = executeToolCallsThroughGate({
      toolCalls,
      messages,
      ctx: {
        phase: 'free',
        mode: 'adaptive',
        executionMode: 'free',
        graphHints: [{ toolName: 'edit_file', action: 'block', message: 'blocked by graph' }],
      },
    });

    expect(result.executableToolCalls).toEqual(toolCalls);
    expect(result.skippedSignatures).toEqual(new Set());
    expect(messages).toEqual([]);
  });

  it('blocks forced graph-denied tool calls before executor and adds visible tool results', () => {
    const execute = vi.fn();
    const toolCalls = [call('tc1', 'edit_file'), call('tc2', 'read_file')];
    const messages: UnifiedMessage[] = [];

    const result = executeToolCallsThroughGate({
      toolCalls,
      messages,
      ctx: {
        phase: 'free',
        mode: 'adaptive',
        executionMode: 'forced',
        graphHints: [
          { toolName: 'edit_file', action: 'block', message: 'edit_file is outside the current step' },
          { toolName: 'read_file', action: 'allow' },
        ],
      },
    });
    for (const tc of result.executableToolCalls) execute(tc);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(toolCalls[1]);
    expect(result.skippedSignatures).toEqual(new Set([toolCallSignature(toolCalls[0])]));
    expect(messages).toContainEqual({
      role: 'tool',
      toolCallId: 'tc1',
      content: expect.stringContaining('edit_file is outside the current step'),
    });
  });
});
