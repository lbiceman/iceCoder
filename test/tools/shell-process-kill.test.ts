import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const resolveWindowsSystemExecutableMock = vi.hoisted(() => vi.fn((name: string) => `resolved-${name}`));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../src/tools/shell-spawn-env.js', () => ({
  resolveWindowsSystemExecutable: resolveWindowsSystemExecutableMock,
  resolveShellExecutable: () => 'resolved-shell',
  augmentPathForShellSpawn: (value: string | undefined) => value || '',
}));

import {
  killProcessesOnPortWindows,
  killShellProcessTree,
  killWindowsProcessTree,
} from '../../src/tools/shell-process-kill.js';
import { BackgroundTaskManager } from '../../src/tools/background-task-manager.js';

type Handler = (...args: any[]) => void;

function makeSpawnedChild() {
  const handlers = new Map<string, Handler[]>();
  return {
    once: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    }),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    }),
    unref: vi.fn(),
    emit(event: string, ...args: any[]) {
      for (const handler of handlers.get(event) || []) handler(...args);
    },
  };
}

describe('killWindowsProcessTree', () => {
  let spawned: ReturnType<typeof makeSpawnedChild>[];

  beforeEach(() => {
    spawnMock.mockReset();
    spawned = [];
    spawnMock.mockImplementation(() => {
      const child = makeSpawnedChild();
      spawned.push(child);
      return child;
    });
    resolveWindowsSystemExecutableMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('taskkill close code=0 后不执行 PowerShell CIM fallback', () => {
    killWindowsProcessTree(1234);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'resolved-taskkill',
      ['/PID', '1234', '/T', '/F'],
      expect.objectContaining({
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      }),
    );
    expect(spawned[0].unref).toHaveBeenCalledTimes(1);

    spawned[0].emit('close', 0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith('[shell-kill] taskkill /T /F 成功 pid=1234');
  });

  it('taskkill close 非零时执行非阻塞 PowerShell CIM fallback', () => {
    killWindowsProcessTree(5678);
    spawned[0].emit('close', 1);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[0]).toBe('resolved-powershell');
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expect.stringMatching(/\$root=5678;[\s\S]*Get-CimInstance Win32_Process/),
    ]);
    expect(spawnMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ windowsHide: true, detached: true, stdio: 'ignore' }),
    );
    expect(spawned[1].unref).toHaveBeenCalled();
  });

  it('taskkill error 时只启动一次 CIM fallback', () => {
    killWindowsProcessTree(6789);
    spawned[0].emit('error', new Error('taskkill spawn failed'));
    spawned[0].emit('close', -1);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[1]?.[3]).toMatch(
      /\$root=6789;[\s\S]*Get-CimInstance Win32_Process/,
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('taskkill 启动失败 pid=6789'),
    );
  });

  it('端口兜底使用异步 PowerShell spawn 并释放句柄', () => {
    killProcessesOnPortWindows(4321);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'resolved-powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        expect.stringContaining('Get-NetTCPConnection -LocalPort $p'),
      ],
      expect.objectContaining({ windowsHide: true, detached: true, stdio: 'ignore' }),
    );
    expect(spawned[0].unref).toHaveBeenCalledTimes(1);
    spawned[0].emit('close', 0);
    expect(console.log).toHaveBeenCalledWith('[shell-kill] 已按端口 4321 终止监听进程');
  });

  it('八任务 dispose 发起终止耗时不线性累积且重复调用幂等', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const manager = new BackgroundTaskManager('D:\\tmp', 'dispose-fast');
    const tasks = (manager as any).tasks as Map<string, unknown>;
    for (let i = 0; i < 8; i++) {
      tasks.set(`task-${i}`, {
        taskId: `task-${i}`,
        status: 'running',
        rootPid: 10_000 + i,
        child: null,
        detectedPort: 4_000 + i,
      });
    }

    const startedAt = performance.now();
    manager.dispose();
    manager.dispose();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(100);
    expect(spawnMock).toHaveBeenCalledTimes(16);
    expect(manager.list()).toEqual([]);
  });

  it('后台任务终态与 dispose 都立即释放 hard-timeout 句柄', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const manager = new BackgroundTaskManager('D:\\tmp', 'timeout-cleanup');

    const first = manager.spawn('echo first', 60_000);
    expect(first.taskId).toBeTruthy();
    expect((manager as any).timeoutTimers.size).toBe(1);
    spawned[0].emit('close', 0);
    expect(manager.getStatus(first.taskId)?.status).toBe('completed');
    expect((manager as any).timeoutTimers.size).toBe(0);

    const second = manager.spawn('echo second', 60_000);
    expect(second.taskId).toBeTruthy();
    expect((manager as any).timeoutTimers.size).toBe(1);
    manager.dispose();
    manager.dispose();
    expect((manager as any).timeoutTimers.size).toBe(0);
  });
});
