/**
 * shell_send_keys 工具 handler 单测（任务 2.4）
 *
 * 覆盖 T26 及控制键映射。
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
    pid: 50_000 + fakePtyInstances.length,
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
import {
  createShellSendKeysTool,
  SHELL_SEND_KEY_BYTES,
  SHELL_SEND_KEY_NAMES,
} from '../../src/tools/builtin/shell-send-keys-tool.js';

function resetFakePtyMocks(): void {
  fakePtyInstances.length = 0;
  ptySpawnMock.mockReset();
  ptySpawnMock.mockImplementation(() => {
    const fake = createFakePty();
    fakePtyInstances.push(fake);
    return fake;
  });
}

describe('shell_send_keys tool — handler (task 2.4)', () => {
  let workDir: string;
  const sessionId = 'sess-shell-keys';

  beforeEach(() => {
    resetFakePtyMocks();
    workDir = mkdtempSync(join(tmpdir(), 'ice-shell-keys-'));
  });

  afterEach(() => {
    __resetInteractiveShellManagers();
  });

  it('T26: CTRL_C interrupts foreground command without killing PTY', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    fakePtyInstances[0].emitData('sleep 999 running...\n');

    const tool = createShellSendKeysTool(workDir, sessionId);
    const result = await tool.handler({ task_id: taskId, keys: ['CTRL_C'] });

    expect(result.success).toBe(true);
    expect(fakePtyInstances[0].write).toHaveBeenCalledWith('\x03');
    expect(fakePtyInstances[0].kill).not.toHaveBeenCalled();

    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe('running');
    expect(parsed.sent).toEqual(['CTRL_C']);
    expect(parsed.cursor).toBeGreaterThanOrEqual(0);
    expect(mgr.getActiveTask()?.status).toBe('running');
  });

  it('maps all supported control keys to fixed byte sequences', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellSendKeysTool(workDir, sessionId);

    const result = await tool.handler({
      task_id: taskId,
      keys: [...SHELL_SEND_KEY_NAMES],
    });

    expect(result.success).toBe(true);
    const writes = fakePtyInstances[0].write.mock.calls.map((c) => c[0] as string);
    expect(writes).toEqual(SHELL_SEND_KEY_NAMES.map((k) => SHELL_SEND_KEY_BYTES[k]));
  });

  it('sends multiple keys in order', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellSendKeysTool(workDir, sessionId);

    await tool.handler({ task_id: taskId, keys: ['TAB', 'ENTER'] });

    const writes = fakePtyInstances[0].write.mock.calls.map((c) => c[0] as string);
    expect(writes).toEqual(['\t', '\r']);
  });

  it('rejects invalid key names', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const tool = createShellSendKeysTool(workDir, sessionId);

    const result = await tool.handler({ task_id: taskId, keys: ['CTRL_C', 'RAW_BYTES'] as any });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/keys must be/);
    expect(fakePtyInstances[0].write).not.toHaveBeenCalled();
  });

  it('CTRL_C does not go through writeCommand / sandbox path', async () => {
    const mgr = getInteractiveShellManagerFor(sessionId, workDir);
    const { taskId } = mgr.start();
    const writeCommandSpy = vi.spyOn(mgr, 'writeCommand');

    const tool = createShellSendKeysTool(workDir, sessionId);
    await tool.handler({ task_id: taskId, keys: ['CTRL_C'] });

    expect(writeCommandSpy).not.toHaveBeenCalled();
    writeCommandSpy.mockRestore();
  });
});
