import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
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

  it('blocks repeated missing read_file as policy_block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-exec-budget-'));
    const relPath = 'src/scenes/ShopScene.ts';
    mkdirSync(join(root, 'src', 'scenes'), { recursive: true });
    writeFileSync(join(root, relPath.replace(/\//g, '\\')), 'export {};\n');
    const tc: ToolCall = {
      id: 'tc-write',
      name: 'write_file',
      arguments: { path: relPath, content: 'updated' },
    };
    const messages: UnifiedMessage[] = [];
    const loopController = new LoopController({ maxRounds: 1 });
    const execute = vi.fn();
    const statsObj = emptyHarnessPolicyStats();
    const budget = new BranchBudgetTracker({ fileEditMax: 2 });
    budget.bindWorkspaceRoot(root);
    budget.recordFileEdit(relPath);
    budget.recordFileEdit(relPath);

    const stats = await executeToolCallsStreaming(
      {
        toolExecutor: { execute } as never,
        loopController,
        permissionRules: [],
        workspaceRoot: root,
        lockedWorkspaceRoot: root,
        branchBudget: budget,
        harnessPolicyStats: statsObj,
      },
      {
        toolCalls: [tc],
        messages,
        logger: { toolCall: () => {}, toolResult: () => {} } as never,
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(statsObj.budgetBlockByPath[relPath]).toBe(1);
    expect(stats.budgetBlockedFilePaths).toEqual([relPath]);
  });
});
