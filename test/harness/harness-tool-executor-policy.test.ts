import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { emptyHarnessPolicyStats } from '../../src/harness/harness-policy-stats.js';
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

  it('blocks repeated missing read_file as policy_block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-exec-'));
    const tc: ToolCall = {
      id: 'tc-missing',
      name: 'read_file',
      arguments: { path: 'src/scenes/MapSelectScene.ts' },
    };
    const messages: UnifiedMessage[] = [];
    const loopController = new LoopController({ maxRounds: 1 });
    const execute = vi.fn();
    const statsObj = emptyHarnessPolicyStats();
    const attempts = new Map<string, number>([[tc.arguments.path as string, 1]]);
    const steps: Array<{ toolOutcome?: string }> = [];

    const stats = await executeToolCallsStreaming(
      {
        toolExecutor: { execute } as never,
        loopController,
        permissionRules: [],
        workspaceRoot: root,
        lockedWorkspaceRoot: root,
        missingFileAttempts: attempts,
        harnessPolicyStats: statsObj,
      },
      {
        toolCalls: [tc],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
        onStep: (event) => {
          if (event.type === 'tool_result') steps.push(event);
        },
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(stats.failedCount).toBe(0);
    expect(statsObj.missingFileBlockCount).toBe(1);
    expect(steps[0]?.toolOutcome).toBe('policy_block');
    expect(messages[0]?.content).toMatch(/Missing File/);
  });
});
