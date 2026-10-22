import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeToolCallsStreaming } from '../../src/harness/harness-tool-executor.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { TaskState } from '../../src/harness/task-state.js';
import { loadSessionTouchedPaths } from '../../src/harness/intent-checkpoint-store.js';
import {
  limitTrackedCommandDiff,
  MAX_TRACKED_CREATED_FILES_PER_COMMAND,
} from '../../src/harness/workspace-command-touch.js';
import type { AgentToolScope } from '../../src/harness/types.js';

async function runCommandCreating(count: number, agentScope?: AgentToolScope) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-bulk-created-'));
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-bulk-session-'));
  const taskState = new TaskState('unpack assets');
  const executeTool = vi.fn(async () => {
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await Promise.all(Array.from({ length: count }, (_, i) =>
      fs.writeFile(path.join(root, 'assets', `a-${i}.png`), `png-${i}`, 'utf8'),
    ));
    return { success: true, output: 'unpacked' };
  });
  await executeToolCallsStreaming(
    {
      toolExecutor: { executeTool } as never,
      loopController: new LoopController({ maxRounds: 1 }),
      permissionRules: [],
      workspaceRoot: root,
      sessionDir,
      sessionId: 'bulk',
      agentScope,
    },
    {
      toolCalls: [{ id: 'cmd-unzip', name: 'run_command', arguments: { command: 'tar -xf assets.tar' } }],
      messages: [],
      logger: { toolCall: () => {}, toolResult: () => {} } as never,
      taskState,
    },
  );
  const touched = await loadSessionTouchedPaths(sessionDir, 'bulk');
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(sessionDir, { recursive: true, force: true });
  return { touched, taskState };
}

describe('单条命令批量新建文件不逐个追踪', () => {
  it('阈值以内原样保留，超过阈值清空 created 并给出数量', () => {
    const atLimit = Array.from({ length: MAX_TRACKED_CREATED_FILES_PER_COMMAND }, (_, i) => `f${i}`);
    expect(limitTrackedCommandDiff({ created: atLimit, changed: ['c'] })).toEqual({
      created: atLimit,
      changed: ['c'],
      bulkCreatedSkipped: 0,
    });
    const over = [...atLimit, 'extra'];
    expect(limitTrackedCommandDiff({ created: over, changed: ['c'] })).toEqual({
      created: [],
      changed: ['c'],
      bulkCreatedSkipped: over.length,
    });
  });

  it('少量新建文件照常记入会话改动', async () => {
    const { touched, taskState } = await runCommandCreating(3);
    expect(touched.sort()).toEqual(['assets/a-0.png', 'assets/a-1.png', 'assets/a-2.png']);
    expect(taskState.snapshot().workspaceMutationVersion).toBe(1);
  });

  it('批量新建不写入会话改动，但仍推进 mutation version', async () => {
    const { touched, taskState } = await runCommandCreating(MAX_TRACKED_CREATED_FILES_PER_COMMAND + 1);
    expect(touched).toEqual([]);
    expect(taskState.snapshot().workspaceMutationVersion).toBe(1);
  });

  it('子 Agent 收到的差异不含批量文件，只有数量', async () => {
    const onCommandWorkspaceChange = vi.fn();
    await runCommandCreating(MAX_TRACKED_CREATED_FILES_PER_COMMAND + 1, {
      agentId: 'agent-x',
      checkBeforeTool: () => null,
      onCommandWorkspaceChange,
    });
    expect(onCommandWorkspaceChange).toHaveBeenCalledTimes(1);
    const diff = onCommandWorkspaceChange.mock.calls[0][1];
    expect(diff.created).toEqual([]);
    expect(diff.bulkCreatedSkipped).toBe(MAX_TRACKED_CREATED_FILES_PER_COMMAND + 1);
  });
});
