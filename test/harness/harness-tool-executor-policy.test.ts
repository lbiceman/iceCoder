import { describe, expect, it, vi } from 'vitest';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { ToolCall, UnifiedMessage } from '../../src/llm/types.js';

describe('harness-tool-executor policy blocks', () => {
  it('treats workspace lock violation as policy block, not execution failure', async () => {
    const tc: ToolCall = {
      id: 'tc-outside',
      name: 'read_file',
      arguments: { path: 'C:/outside/project/foo.ts' },
    };
    const messages: UnifiedMessage[] = [];
    const loopController = new LoopController({ maxRounds: 1 });
    const execute = vi.fn();

    const stats = await executeToolCallsStreaming(
      {
        toolExecutor: { execute } as never,
        loopController,
        permissionRules: [],
        workspaceRoot: 'E:/locked/project',
        lockedWorkspaceRoot: 'E:/locked/project',
        referenceReads: [],
      },
      {
        toolCalls: [tc],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(stats.failedCount).toBe(0);
    expect(stats.failedSignatures).toHaveLength(0);
    expect(stats.policyBlockedSignatures).toEqual([toolCallSignature(tc)]);
  });
});
