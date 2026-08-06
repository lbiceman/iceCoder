/**
 * interactive_shell 工具 handler 单测（任务 2.1）
 *
 * 覆盖 T3/T4/T5/T8/T17 工具层验收。
 */

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type FakePty = {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  emitData: (data: string) => void;
  emitExit: (exitCode: number) => void;
};

const fakePtyInstances = vi.hoisted((): FakePty[] => []);
const ptySpawnMock = vi.hoisted(() => vi.fn());

function createFakePty(): FakePty {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((e: { exitCode: number }) => void) | null = null;
  const fake: FakePty = {
    pid: 20_000 + fakePtyInstances.length,
    write: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      dataHandler = cb;
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      exitHandler = cb;
    }),
    emitData(data: string) {
      dataHandler?.(data);
    },
    emitExit(exitCode: number) {
      exitHandler?.({ exitCode });
    },
  };
  return fake;
}

vi.mock('node-pty', () => ({
  spawn: ptySpawnMock,
}));

import { __resetInteractiveShellManagers } from '../../src/tools/interactive-shell-manager.js';
import { createInteractiveShellTool } from '../../src/tools/builtin/interactive-shell-tool.js';

function resetFakePtyMocks(): void {
  fakePtyInstances.length = 0;
  ptySpawnMock.mockReset();
  ptySpawnMock.mockImplementation(() => {
    const fake = createFakePty();
    fakePtyInstances.push(fake);
    return fake;
  });
}

describe('interactive_shell tool — handler (task 2.1)', () => {
  let workDir: string;
  const sessionId = 'sess-ish-tool';

  beforeEach(() => {
    resetFakePtyMocks();
    workDir = mkdtempSync(join(tmpdir(), 'ice-ish-tool-'));
  });

  afterEach(() => {
    __resetInteractiveShellManagers();
  });

  it('T3: read detects awaiting_input on password prompt', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);
    const start = await tool.handler({ action: 'start' });
    expect(start.success).toBe(true);
    const { taskId } = JSON.parse(start.output);

    fakePtyInstances[0].emitData('bash$ read -p "请输入密码:" pwd\r\n请输入密码: ');

    const read = await tool.handler({ action: 'read', task_id: taskId, since: 0 });
    expect(read.success).toBe(true);
    const parsed = JSON.parse(read.output);
    expect(parsed.action).toBe('read');
    expect(parsed.status).toBe('awaiting_input');
    expect(parsed.promptHint).toBe('password');
    expect(parsed.promptText).toMatch(/请输入密码/);
    expect(parsed.cursor).toBeGreaterThan(0);
  });

  it('T4: write sends input to PTY when awaiting_input', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);
    const start = await tool.handler({ action: 'start' });
    const { taskId } = JSON.parse(start.output);

    fakePtyInstances[0].emitData('Password: ');

    const read = await tool.handler({ action: 'read', task_id: taskId, since: 0 });
    expect(JSON.parse(read.output).status).toBe('awaiting_input');

    const write = await tool.handler({ action: 'write', task_id: taskId, input: 's3cr3t' });
    expect(write.success).toBe(true);
    const written = fakePtyInstances[0].write.mock.calls.at(-1)![0] as string;
    expect(written).toMatch(/^s3cr3t/);

    const parsed = JSON.parse(write.output);
    expect(parsed.action).toBe('write');
    expect(parsed.status).toBe('running');
  });

  it('write rejects when not awaiting_input and hints shell_exec', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);
    const start = await tool.handler({ action: 'start' });
    const { taskId } = JSON.parse(start.output);

    fakePtyInstances[0].emitData('hello\n$ ');

    const write = await tool.handler({ action: 'write', task_id: taskId, input: 'rm -rf /' });
    expect(write.success).toBe(false);
    expect(write.error).toMatch(/非交互输入态|shell_exec/);
    expect(fakePtyInstances[0].write).not.toHaveBeenCalled();
  });

  it('T36: rejects fragmented command writes in command state before touching PTY', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);
    const start = await tool.handler({ action: 'start' });
    const { taskId } = JSON.parse(start.output);

    fakePtyInstances[0].emitData('ready\n$ ');

    for (const fragment of ['rm ', '-rf /tmp/x', 'ENTER']) {
      const write = await tool.handler({ action: 'write', task_id: taskId, input: fragment });
      expect(write.success, fragment).toBe(false);
      expect(write.error, fragment).toMatch(/非交互输入态|shell_exec|命令片段/);
    }
    expect(fakePtyInstances[0].write).not.toHaveBeenCalled();
  });

  it('T5: two start calls reuse same taskId', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);

    const first = await tool.handler({ action: 'start', label: 'shell-a' });
    const second = await tool.handler({ action: 'start', label: 'shell-b' });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const a = JSON.parse(first.output);
    const b = JSON.parse(second.output);
    expect(b.status).toBe('reused');
    expect(b.taskId).toBe(a.taskId);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
  });

  it('T8: start hard-blocks rm -rf / before spawning or writing PTY', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);

    const result = await tool.handler({ action: 'start', command: 'rm -rf /' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Hard Block|Sandbox|Blocked/i);
    expect(JSON.parse(result.output).taskId).toBeUndefined();
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(fakePtyInstances).toHaveLength(0);
  });

  it('T17: stop kills PTY; subsequent start spawns new task', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);

    const first = await tool.handler({ action: 'start' });
    const { taskId: firstId } = JSON.parse(first.output);

    const stop = await tool.handler({ action: 'stop', task_id: firstId });
    expect(stop.success).toBe(true);
    expect(JSON.parse(stop.output).status).toBe('stopped');
    expect(fakePtyInstances[0].kill).toHaveBeenCalled();

    const second = await tool.handler({ action: 'start' });
    expect(second.success).toBe(true);
    const { taskId: secondId, status } = JSON.parse(second.output);
    expect(status).toBe('started');
    expect(secondId).not.toBe(firstId);
    expect(ptySpawnMock).toHaveBeenCalledTimes(2);
  });

  it('check is alias of read', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);
    const start = await tool.handler({ action: 'start' });
    const { taskId } = JSON.parse(start.output);

    fakePtyInstances[0].emitData('(yes/no): ');

    const check = await tool.handler({ action: 'check', task_id: taskId, since: 0 });
    expect(check.success).toBe(true);
    expect(JSON.parse(check.output).action).toBe('check');
    expect(JSON.parse(check.output).status).toBe('awaiting_input');
  });

  it('requires task_id for non-start actions', async () => {
    const tool = createInteractiveShellTool(workDir, sessionId);
    const result = await tool.handler({ action: 'read' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/task_id is required/);
  });
});
