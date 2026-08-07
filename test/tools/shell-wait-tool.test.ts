/**
 * shell_wait 工具 handler 单测（任务 2.3）
 *
 * 覆盖 T25 工具层验收。
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
    pid: 40_000 + fakePtyInstances.length,
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
import { createShellWaitTool } from '../../src/tools/builtin/shell-wait-tool.js';

function resetFakePtyMocks(): void {
  fakePtyInstances.length = 0;
  ptySpawnMock.mockReset();
  ptySpawnMock.mockImplementation(() => {
    const fake = createFakePty();
    fakePtyInstances.push(fake);
    return fake;
  });
}

describe('shell_wait tool — handler (task 2.3)', () => {
  let workDir: string;
  const sessionId = 'sess-shell-wait';

  beforeEach(() => {
    resetFakePtyMocks();
    workDir = mkdtempSync(join(tmpdir(), 'ice-shell-wait-'));
  });

  afterEach(() => {
    __resetInteractiveShellManagers();
  });

  it('T25: returns early when delayed output arrives (until=output)', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const since = mgr.read(taskId, 0)!.cursor;
    const tool = createShellWaitTool(workDir, sessionId);

    const waitPromise = tool.handler({
      task_id: taskId,
      since,
      until: 'output',
      timeout_ms: 5_000,
    });

    await new Promise((r) => setTimeout(r, 200));
    fakePtyInstances[0].emitData('Installing packages...\nDone.\n');

    const result = await waitPromise;
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe('running');
    expect(parsed.output).toMatch(/Installing packages/);
    expect(parsed.cursor).toBeGreaterThan(since);
  });

  it('until=output 先返回 since 后已经存在的输出', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const since = mgr.read(taskId, 0)!.cursor;
    fakePtyInstances[0].emitData('already available');
    const tool = createShellWaitTool(workDir, sessionId);

    const result = await tool.handler({
      task_id: taskId,
      since,
      until: 'output',
      timeout_ms: 5_000,
    });

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe('running');
    expect(parsed.output).toBe('already available');
    expect(parsed.cursor).toBe(since + 'already available'.length);
  });

  it('until=output 可由无换行 multi-chunk 输出唤醒', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const since = mgr.read(taskId, 0)!.cursor;
    const tool = createShellWaitTool(workDir, sessionId);

    const waitPromise = tool.handler({
      task_id: taskId,
      since,
      until: 'output',
      pattern: 'welcome',
      timeout_ms: 5_000,
    });
    fakePtyInstances[0].emitData('wel');
    await new Promise((r) => setTimeout(r, 100));
    fakePtyInstances[0].emitData('come');

    const parsed = JSON.parse((await waitPromise).output);
    expect(parsed.matched).toBe(true);
    expect(parsed.output).toBe('welcome');
  });

  it('T25: returns awaiting_input when password prompt appears', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellWaitTool(workDir, sessionId);

    const waitPromise = tool.handler({
      task_id: taskId,
      since: 0,
      until: 'output',
      timeout_ms: 5_000,
    });

    await new Promise((r) => setTimeout(r, 150));
    fakePtyInstances[0].emitData('Password: ');

    const result = await waitPromise;
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe('awaiting_input');
    expect(parsed.promptHint).toBe('password');
  });

  it('T25: returns completed when PTY exits (until=exit)', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellWaitTool(workDir, sessionId);

    const waitPromise = tool.handler({
      task_id: taskId,
      since: 0,
      until: 'exit',
      timeout_ms: 5_000,
    });

    await new Promise((r) => setTimeout(r, 100));
    fakePtyInstances[0].emitExit(0);

    const result = await waitPromise;
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).status).toBe('completed');
  });

  it('T25: timeout is normal status and does not kill PTY', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellWaitTool(workDir, sessionId);

    const result = await tool.handler({
      task_id: taskId,
      since: 0,
      until: 'output',
      timeout_ms: 800,
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output).status).toBe('timeout');
    expect(fakePtyInstances[0].kill).not.toHaveBeenCalled();
    expect(mgr.getActiveTask()?.status).toBe('running');
  });

  it('pattern matches plain text substring', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellWaitTool(workDir, sessionId);

    const waitPromise = tool.handler({
      task_id: taskId,
      since: 0,
      until: 'output',
      pattern: 'BUILD SUCCESS',
      timeout_ms: 5_000,
    });

    await new Promise((r) => setTimeout(r, 150));
    fakePtyInstances[0].emitData('Compiling...\n');
    await new Promise((r) => setTimeout(r, 100));
    fakePtyInstances[0].emitData('BUILD SUCCESS\n');

    const result = await waitPromise;
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.matched).toBe(true);
    expect(parsed.output).toMatch(/BUILD SUCCESS/);
  });
});
