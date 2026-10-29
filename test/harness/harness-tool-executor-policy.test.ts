import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { emptyHarnessPolicyStats } from '../../src/harness/harness-policy-stats.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { ToolCall, UnifiedMessage } from '../../src/llm/types.js';

describe('harness-tool-executor policy blocks', () => {
  it('allows paths outside locked workspace without policy block', async () => {
    const tc: ToolCall = {
      id: 'tc-outside',
      name: 'read_file',
      arguments: { path: 'C:/outside/project/foo.ts' },
    };
    const messages: UnifiedMessage[] = [];
    const loopController = new LoopController({ maxRounds: 1 });
    const executeTool = vi.fn().mockResolvedValue({ success: true, output: 'ok' });

    const stats = await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
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

    expect(executeTool).toHaveBeenCalledOnce();
    expect(stats.policyBlockedSignatures).toHaveLength(0);
  });

  it('executes every write to the same file, with no per-file edit cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-exec-repeat-'));
    const relPath = 'src/scenes/ShopScene.ts';
    mkdirSync(join(root, 'src', 'scenes'), { recursive: true });
    writeFileSync(join(root, 'src', 'scenes', 'ShopScene.ts'), 'export {};\n');
    const toolCalls: ToolCall[] = [1, 2, 3, 4, 5].map(n => ({
      id: `tc-write-${n}`,
      name: 'write_file',
      arguments: { path: relPath, content: `v${n}` },
    }));
    const messages: UnifiedMessage[] = [];
    const executeTool = vi.fn().mockResolvedValue({ success: true, output: 'written' });
    const statsObj = emptyHarnessPolicyStats();

    const stats = await executeToolCallsStreaming(
      {
        toolExecutor: { executeTool } as never,
        loopController: new LoopController({ maxRounds: 1 }),
        permissionRules: [],
        workspaceRoot: root,
        lockedWorkspaceRoot: root,
        harnessPolicyStats: statsObj,
      },
      {
        toolCalls,
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(executeTool).toHaveBeenCalledTimes(5);
    expect(stats.policyBlockedSignatures).toHaveLength(0);
    expect(statsObj.policyBlockCount).toBe(0);
  });
});

