/**
 * shell_exec 工具 handler 单测（任务 2.2）
 *
 * 覆盖 T24/T27 工具层验收。
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
    pid: 30_000 + fakePtyInstances.length,
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

import {
  __resetInteractiveShellManagers,
  getInteractiveShellManagerFor,
} from '../../src/tools/interactive-shell-manager.js';
import { createShellExecTool } from '../../src/tools/builtin/shell-exec-tool.js';

function resetFakePtyMocks(): void {
  fakePtyInstances.length = 0;
  ptySpawnMock.mockReset();
  ptySpawnMock.mockImplementation(() => {
    const fake = createFakePty();
    fakePtyInstances.push(fake);
    return fake;
  });
}

describe('shell_exec tool — handler (task 2.2)', () => {
  let workDir: string;
  const sessionId = 'sess-shell-exec';

  beforeEach(() => {
    resetFakePtyMocks();
    workDir = mkdtempSync(join(tmpdir(), 'ice-shell-exec-'));
  });

  afterEach(() => {
    __resetInteractiveShellManagers();
  });

  it('T24: writes df -h to current PTY and returns output + cursor', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellExecTool(workDir, sessionId);

    const execPromise = tool.handler({
      task_id: taskId,
      command: 'df -h',
      timeout_ms: 5_000,
    });

    await vi.waitFor(() => {
      expect(fakePtyInstances[0].write).toHaveBeenCalled();
    });

    const written = fakePtyInstances[0].write.mock.calls[0][0] as string;
    expect(written).toMatch(/^df -h/);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);

    fakePtyInstances[0].emitData('Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        50G   20G   28G  42% /\n$ ');

    const result = await execPromise;
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.taskId).toBe(taskId);
    expect(parsed.status).toBe('running');
    expect(parsed.output).toMatch(/Filesystem/);
    expect(parsed.output).not.toMatch(/^df -h/m); // 增量输出，不含命令 echo
    expect(parsed.cursor).toBeGreaterThan(0);
    expect(parsed.totalOutputLines).toBe(3);
  });

  it('T27: rejects exec when PTY is awaiting_input', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    mgr._testInjectOutput(taskId, 'Password: ');

    const tool = createShellExecTool(workDir, sessionId);
    const result = await tool.handler({ task_id: taskId, command: 'df -h' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/交互输入态|interactive_shell write/i);
    const parsed = JSON.parse(result.output);
    expect(parsed.hint).toMatch(/interactive_shell write/i);
    expect(fakePtyInstances[0].write).not.toHaveBeenCalled();
  });

  it('does not spawn a new shell on exec', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellExecTool(workDir, sessionId);

    const execPromise = tool.handler({ task_id: taskId, command: 'echo hi', timeout_ms: 3_000 });
    await vi.waitFor(() => expect(fakePtyInstances[0].write).toHaveBeenCalled());
    fakePtyInstances[0].emitData('hi\n$ ');

    await execPromise;
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
  });

  it('timeout does not kill PTY', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellExecTool(workDir, sessionId);

    const result = await tool.handler({
      task_id: taskId,
      command: 'sleep 999',
      wait_until: 'exit',
      timeout_ms: 800,
    });

    expect(result.success).toBe(false);
    expect(JSON.parse(result.output).status).toBe('timeout');
    expect(fakePtyInstances[0].kill).not.toHaveBeenCalled();
    expect(mgr.getActiveTask()?.status).toBe('running');
  });

  it('wait_until=exit returns when PTY exits', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellExecTool(workDir, sessionId);

    const execPromise = tool.handler({
      task_id: taskId,
      command: 'exit',
      wait_until: 'exit',
      timeout_ms: 5_000,
    });

    await vi.waitFor(() => expect(fakePtyInstances[0].write).toHaveBeenCalled());
    fakePtyInstances[0].emitExit(0);

    const result = await execPromise;
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).status).toBe('completed');
  });
});
