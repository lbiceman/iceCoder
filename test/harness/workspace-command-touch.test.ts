import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { TaskState } from '../../src/harness/task-state.js';
import {
  diffInventoryTouchedPaths,
  extractLikelyWritePathsFromCommand,
  listWorkspaceFileInventory,
} from '../../src/harness/workspace-command-touch.js';
import { collectSessionTouchedPaths } from '../../src/harness/intent-checkpoint-store.js';

describe('workspace-command-touch', () => {
  it('extracts redirect and copy/move targets from shell commands', () => {
    expect(extractLikelyWritePathsFromCommand('echo hi > 1.txt')).toContain('1.txt');
    expect(extractLikelyWritePathsFromCommand('cat a.txt >> notes/log.txt')).toContain('notes/log.txt');
    expect(extractLikelyWritePathsFromCommand('cp empty.txt dest/2.txt')).toContain('dest/2.txt');
    expect(extractLikelyWritePathsFromCommand('Set-Content -Path foo.txt -Value x')).toContain('foo.txt');
    expect(extractLikelyWritePathsFromCommand('npm test')).toEqual([]);
    expect(extractLikelyWritePathsFromCommand('echo hi 2>&1')).not.toContain('&1');
  });

  it('collectSessionTouchedPaths reads run_command redirects', () => {
    expect(collectSessionTouchedPaths('run_command', { command: 'echo x > out/a.txt' })).toEqual(['out/a.txt']);
    expect(collectSessionTouchedPaths('run_command', { action: 'list' })).toEqual([]);
    expect(collectSessionTouchedPaths('shell_exec', { command: 'tee result.md' })).toContain('result.md');
  });

  it('inventory diff marks files created after a command', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-cmd-inv-'));
    try {
      await fs.writeFile(path.join(root, 'keep.txt'), 'k', 'utf-8');
      const before = await listWorkspaceFileInventory(root);
      await fs.writeFile(path.join(root, '1.txt'), 'new', 'utf-8');
      const after = await listWorkspaceFileInventory(root);
      const diff = diffInventoryTouchedPaths(root, before, after);
      expect(diff.created).toContain('1.txt');
      expect(diff.created).not.toContain('keep.txt');
      expect(diff.changed).not.toContain('keep.txt');
      await fs.writeFile(path.join(root, 'keep.txt'), 'changed', 'utf-8');
      const afterEdit = await listWorkspaceFileInventory(root);
      const editDiff = diffInventoryTouchedPaths(root, after, afterEdit);
      expect(editDiff.changed).toContain('keep.txt');
      expect(editDiff.created).not.toContain('keep.txt');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('records one task mutation for all inventory changes from one successful command', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-cmd-mutation-'));
    const taskState = new TaskState('generate files');
    try {
      await fs.writeFile(path.join(root, 'deleted.txt'), 'old', 'utf8');
      const executeTool = vi.fn(async () => {
        await fs.writeFile(path.join(root, 'created-a.txt'), 'a', 'utf8');
        await fs.writeFile(path.join(root, 'created-b.txt'), 'b', 'utf8');
        await fs.rm(path.join(root, 'deleted.txt'));
        return { success: true, output: 'generated' };
      });

      await executeToolCallsStreaming(
        {
          toolExecutor: { executeTool } as never,
          loopController: new LoopController({ maxRounds: 1 }),
          permissionRules: [],
          workspaceRoot: root,
        },
        {
          toolCalls: [{
            id: 'cmd-success',
            name: 'run_command',
            arguments: { command: 'node generate-files.js' },
          }],
          messages: [],
          logger: { toolCall: () => {}, toolResult: () => {} } as never,
          taskState,
        },
      );

      expect(taskState.snapshot().workspaceMutationVersion).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not record an inventory mutation when the command fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-cmd-mutation-fail-'));
    const taskState = new TaskState('generate files');
    try {
      const executeTool = vi.fn(async () => {
        await fs.writeFile(path.join(root, 'partial.txt'), 'partial', 'utf8');
        return { success: false, output: '', error: 'exit 1' };
      });

      await executeToolCallsStreaming(
        {
          toolExecutor: { executeTool } as never,
          loopController: new LoopController({ maxRounds: 1 }),
          permissionRules: [],
          workspaceRoot: root,
          sessionId: 'mutation-failure',
        },
        {
          toolCalls: [{
            id: 'cmd-failure',
            name: 'run_command',
            arguments: { command: 'node generate-files.js' },
          }],
          messages: [],
          logger: { toolCall: () => {}, toolResult: () => {} } as never,
          taskState,
        },
      );

      expect(taskState.snapshot().workspaceMutationVersion).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
