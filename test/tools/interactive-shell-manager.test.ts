/**
 * InteractiveShellManager 单元测试（任务 1.5）
 *
 * 使用 mock node-pty，不依赖真实 PTY；CI Windows 可稳定运行。
 * 真实 PTY 集成测试见 interactive-shell-manager.integration.test.ts。
 */

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
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
    pid: 10_000 + fakePtyInstances.length,
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
  InteractiveShellManager,
  getInteractiveShellManagerFor,
  __resetInteractiveShellManagers,
} from '../../src/tools/interactive-shell-manager.js';

function resetFakePtyMocks(): void {
  fakePtyInstances.length = 0;
  ptySpawnMock.mockReset();
  ptySpawnMock.mockImplementation(() => {
    const fake = createFakePty();
    fakePtyInstances.push(fake);
    return fake;
  });
}

afterEach(() => {
  __resetInteractiveShellManagers();
});

describe('InteractiveShellManager — unit (mock pty)', () => {
  beforeEach(() => {
    resetFakePtyMocks();
  });

  describe('start', () => {
    it('start 创建 ish_* task 并 spawn PTY', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-start-'));
      const mgr = getInteractiveShellManagerFor('sess-ish-start', workDir);

      const result = mgr.start({ label: 'test shell' });
      expect(result.error).toBeUndefined();
      expect(result.taskId).toMatch(/^ish_/);
      expect(result.status).toBe('started');
      expect(ptySpawnMock).toHaveBeenCalledTimes(1);

      const active = mgr.getActiveTask();
      expect(active?.taskId).toBe(result.taskId);
      expect(active?.lifespan).toBe('copilot');
      expect(active?.awaitingInput).toBe(false);
      expect(active?.status).toBe('running');

      mgr.stop(result.taskId);
    });

    it('同 session 两次 start 复用同一 taskId（T5）', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-reuse-'));
      const mgr = getInteractiveShellManagerFor('sess-ish-reuse', workDir);

      const first = mgr.start({ label: 'test shell' });
      const second = mgr.start({ label: 'another' });

      expect(second.status).toBe('reused');
      expect(second.taskId).toBe(first.taskId);
      expect(ptySpawnMock).toHaveBeenCalledTimes(1);

      mgr.stop(first.taskId);
    });

    it('start 带 blocked 命令时 sandbox 拒绝且不 spawn', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-sandbox-'));
      const mgr = getInteractiveShellManagerFor('sess-ish-sb', workDir);

      const result = mgr.start({
        command: process.platform === 'win32'
          ? 'taskkill /F /IM node.exe'
          : 'killall node',
      });
      expect(result.taskId).toBe('');
      expect(result.error).toMatch(/Sandbox|Blocked|HostGuard/i);
      expect(mgr.getActiveTask()).toBeNull();
      expect(ptySpawnMock).not.toHaveBeenCalled();
    });

    it('start 带 initial command 写入 PTY', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-cmd-'));
      const mgr = new InteractiveShellManager(workDir, 'ish-cmd-test');

      const { taskId } = mgr.start({ command: 'echo hello' });
      expect(taskId).toBeTruthy();
      expect(fakePtyInstances[0].write).toHaveBeenCalled();
      const written = fakePtyInstances[0].write.mock.calls[0][0] as string;
      expect(written).toMatch(/^echo hello/);

      mgr.stop(taskId);
    });

    it('不同 session 隔离 manager 实例', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-iso-'));
      const a = getInteractiveShellManagerFor('sess-a', workDir);
      const b = getInteractiveShellManagerFor('sess-b', workDir);
      expect(a).not.toBe(b);
      expect(getInteractiveShellManagerFor('sess-a', workDir)).toBe(a);
    });
  });

  describe('stop', () => {
    it('getTask / listForSession / stop', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-life-'));
      const mgr = getInteractiveShellManagerFor('sess-ish-life', workDir);

      const { taskId } = mgr.start();
      expect(taskId).toBeTruthy();

      const summary = mgr.getTask(taskId);
      expect(summary?.status).toBe('running');
      expect(summary?.taskId).toBe(taskId);

      const list = mgr.listForSession();
      expect(list).toHaveLength(1);
      expect(list[0].taskId).toBe(taskId);

      const stopped = mgr.stop(taskId);
      expect(stopped.status).toBe('stopped');
      expect(fakePtyInstances[0].kill).toHaveBeenCalled();
      expect(mgr.getTask(taskId)?.status).toBe('killed');
      expect(mgr.getActiveTask()).toBeNull();
    });

    it('stop 不存在的 task 返回 error', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-stop-miss-'));
      const mgr = new InteractiveShellManager(workDir, 'ish-stop-miss');
      const result = mgr.stop('ish_missing');
      expect(result.status).toBe('stopped');
      expect(result.error).toMatch(/不存在/);
    });

    it('PTY onExit 后 read 返回 completed', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-exit-'));
      const mgr = new InteractiveShellManager(workDir, 'ish-exit-test');
      const { taskId } = mgr.start();

      fakePtyInstances[0].emitData('done\n');
      fakePtyInstances[0].emitExit(0);

      expect(mgr.getTask(taskId)?.status).toBe('completed');
      expect(mgr.read(taskId, 0)?.status).toBe('completed');
    });

    it('反复 start/stop 有界保留历史终态且最新终态仍可读取', () => {
      const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-retain-'));
      const mgr = new InteractiveShellManager(workDir, 'ish-retain-test');
      const taskIds: string[] = [];

      for (let i = 0; i < 25; i++) {
        const { taskId } = mgr.start();
        taskIds.push(taskId);
        fakePtyInstances[i].emitData(`task-${i}`);
        mgr.stop(taskId);
      }

      expect(mgr.listForSession()).toHaveLength(20);
      expect(mgr.getTask(taskIds[0])).toBeNull();
      expect(mgr.read(taskIds.at(-1)!, 0)?.output).toContain('task-24');
      expect(mgr.read(taskIds.at(-1)!, 0)?.status).toBe('killed');
    });
  });

  describe('read / cursor', () => {
    let workDir: string;
    let mgr: InteractiveShellManager;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'ice-ish-read-'));
      mgr = new InteractiveShellManager(workDir, 'ish-read-test');
    });

    afterEach(() => {
      mgr.dispose();
    });

    it('read 对不存在 task 返回 null', () => {
      expect(mgr.read('ish_missing', 0)).toBeNull();
    });

    it('since=0 返回全量输出', () => {
      const { taskId } = mgr.start();
      mgr._testInjectOutput(taskId, 'line 1\nline 2\nline 3\nline 4\nline 5\n');

      const result = mgr.read(taskId, 0);
      expect(result).not.toBeNull();
      expect(result!.output).toMatch(/line 1/);
      expect(result!.output).toMatch(/line 5/);
      expect(result!.cursor).toBe('line 1\nline 2\nline 3\nline 4\nline 5\n'.length);
      expect(result!.totalOutputLines).toBe(5);
      expect(result!.cursor).toBeGreaterThan(0);
      expect(result!.truncated).toBe(false);
      expect(result!.status).toBe('running');

      mgr.stop(taskId);
    });

    it('since=cursor 时无新输出且 cursor 不变', () => {
      const { taskId } = mgr.start();
      mgr._testInjectOutput(taskId, 'line 1\nline 2\nline 3\n');

      const first = mgr.read(taskId, 0);
      const second = mgr.read(taskId, first!.cursor);

      expect(second).not.toBeNull();
      expect(second!.output).toBe('');
      expect(second!.cursor).toBe(first!.cursor);
      expect(second!.totalOutputLines).toBe(first!.totalOutputLines);
      expect(second!.truncated).toBe(false);

      mgr.stop(taskId);
    });

    it('连续 read 拼接等于全量输出', () => {
      const { taskId } = mgr.start();
      mgr._testInjectOutput(taskId, 'slow line 1\nslow line 2\n');

      const first = mgr.read(taskId, 0);
      expect(first!.output).toMatch(/slow line 1/);

      mgr._testInjectOutput(taskId, 'slow line 3\nslow line 4\nslow line 5\n');
      const second = mgr.read(taskId, first!.cursor);

      expect(second!.output).toMatch(/slow line 5/);
      expect(second!.cursor).toBeGreaterThan(first!.cursor);
      expect(second!.output).not.toMatch(/slow line 1\b/);

      const full = mgr.read(taskId, 0)!.output;
      const stitched = [first!.output, second!.output].filter(Boolean).join('\n');
      expect(stitched).toMatch(/slow line 1/);
      expect(stitched).toMatch(/slow line 5/);
      expect(full).toMatch(/slow line 1/);
      expect(full).toMatch(/slow line 5/);

      mgr.stop(taskId);
    });

    it('since 早于环形缓冲时 truncated=true', () => {
      const { taskId } = mgr.start();
      for (let i = 1; i <= 600; i++) {
        mgr._testInjectOutput(taskId, `flood ${i} ${'x'.repeat(256)}\n`);
      }

      const result = mgr.read(taskId, 50);
      expect(result).not.toBeNull();
      expect(result!.truncated).toBe(true);
      expect(result!.cursor).toBeGreaterThan(500);

      mgr.stop(taskId);
    });

    it('PTY onData 经 appendOutput 进入 read', () => {
      const { taskId } = mgr.start();
      fakePtyInstances[0].emitData('from-pty\n');

      const result = mgr.read(taskId, 0);
      expect(result!.output).toMatch(/from-pty/);

      mgr.stop(taskId);
    });

    it('无换行、多 chunk 输出按真实偏移增量读取且行数独立', () => {
      const { taskId } = mgr.start();

      mgr._testInjectOutput(taskId, 'wel');
      const first = mgr.read(taskId, 0)!;
      expect(first.output).toBe('wel');
      expect(first.cursor).toBe(3);
      expect(first.totalOutputLines).toBe(1);

      mgr._testInjectOutput(taskId, 'come');
      const second = mgr.read(taskId, first.cursor)!;
      expect(second.output).toBe('come');
      expect(second.cursor).toBe(7);
      expect(second.totalOutputLines).toBe(1);

      mgr._testInjectOutput(taskId, '\nnext');
      const third = mgr.read(taskId, second.cursor)!;
      expect(third.output).toBe('\nnext');
      expect(third.cursor).toBe(12);
      expect(third.totalOutputLines).toBe(2);

      mgr.stop(taskId);
    });
  });

  describe('awaiting_input', () => {
    let workDir: string;
    let mgr: InteractiveShellManager;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'ice-ish-await-'));
      mgr = new InteractiveShellManager(workDir, 'ish-await-test');
    });

    afterEach(() => {
      mgr.dispose();
    });

    it('T3: read -p "请输入密码:" mock → awaiting_input', () => {
      const { taskId } = mgr.start();
      mgr._testInjectOutput(taskId, 'bash$ read -p "请输入密码:" pwd\r\n请输入密码: ');

      const result = mgr.read(taskId, 0);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('awaiting_input');
      expect(result!.promptHint).toBe('password');
      expect(result!.promptText).toMatch(/请输入密码/);
      expect(result!.recentOutput).toMatch(/请输入密码/);
      expect(mgr.getTask(taskId)?.awaitingInput).toBe(true);

      mgr.stop(taskId);
    });

    it('普通输出 read 返回 running', () => {
      const { taskId } = mgr.start();
      mgr._testInjectOutput(taskId, 'hello world\n$ ');

      const result = mgr.read(taskId, 0);
      expect(result!.status).toBe('running');
      expect(result!.promptHint).toBeUndefined();

      mgr.stop(taskId);
    });

    it('writeInput 仅 awaitingInput 时允许并写入 PTY', () => {
      const { taskId } = mgr.start();

      const denied = mgr.writeInput(taskId, 'secret');
      expect(denied.ok).toBe(false);
      expect(denied.error).toMatch(/非交互输入态/);

      mgr._testInjectOutput(taskId, 'Password: ');
      expect(mgr.read(taskId, 0)!.status).toBe('awaiting_input');

      const ok = mgr.writeInput(taskId, 'secret123');
      expect(ok.ok).toBe(true);
      expect(fakePtyInstances[0].write).toHaveBeenCalled();
      const written = fakePtyInstances[0].write.mock.calls.at(-1)![0] as string;
      expect(written).toMatch(/^secret123/);
      expect(mgr.getTask(taskId)?.awaitingInput).toBe(false);
      expect(mgr.read(taskId, 0)!.status).toBe('running');

      mgr.stop(taskId);
    });

    it('异步 password→welcome→command 只扫描输入后的新输出', async () => {
      const { taskId } = mgr.start();
      fakePtyInstances[0].emitData('Password: ');
      expect(mgr.read(taskId, 0)?.status).toBe('awaiting_input');

      expect(mgr.writeInput(taskId, 'secret123').ok).toBe(true);
      await Promise.resolve();
      fakePtyInstances[0].emitData('Welcome');
      expect(mgr.read(taskId, 0)?.status).toBe('running');

      await Promise.resolve();
      fakePtyInstances[0].emitData('!\n$ ');
      expect(mgr.read(taskId, 0)?.status).toBe('running');
      expect(mgr.writeCommand(taskId, 'echo ready').ok).toBe(true);

      mgr.stop(taskId);
    });

    it('check 为 read 别名', () => {
      const { taskId } = mgr.start();
      mgr._testInjectOutput(taskId, '(yes/no): ');
      expect(mgr.check(taskId, 0)?.status).toBe('awaiting_input');
      mgr.stop(taskId);
    });

    it('completed 任务 read 返回 completed', () => {
      const { taskId } = mgr.start();
      mgr._testInjectOutput(taskId, 'done\n');
      const active = mgr.getActiveTask();
      expect(active).not.toBeNull();
      active!.status = 'completed';
      active!.pty = null;
      expect(mgr.read(taskId, 0)?.status).toBe('completed');
      mgr.stop(taskId);
    });
  });

  describe('log file persistence', () => {
    let workDir: string;
    let mgr: InteractiveShellManager;

    beforeEach(() => {
      workDir = mkdtempSync(join(tmpdir(), 'ice-ish-log-'));
      mgr = new InteractiveShellManager(workDir, 'ish-log-test');
    });

    afterEach(() => {
      mgr.dispose();
    });

    it('输出落盘至 data/sessions/{sid}/ish/{tid}.log', async () => {
      const { taskId } = mgr.start();
      const expectedPath = join(workDir, 'data', 'sessions', 'ish-log-test', 'ish', `${taskId}.log`);
      expect(mgr.getActiveTask()?.logPath).toBe(expectedPath);

      fakePtyInstances[0].emitData('hello-ish-log\nerr-ish-log\n');

      await expect.poll(
        () => (existsSync(expectedPath) ? readFileSync(expectedPath, 'utf-8') : ''),
        { timeout: 3000, interval: 25 },
      ).toMatch(/hello-ish-log/);

      const content = readFileSync(expectedPath, 'utf-8');
      expect(content).toMatch(/err-ish-log/);

      mgr.stop(taskId);
    });

    it('T32: password 输入及跨 chunk 回显在 PTY 日志中脱敏', async () => {
      const { taskId } = mgr.start();
      const expectedPath = join(workDir, 'data', 'sessions', 'ish-log-test', 'ish', `${taskId}.log`);
      const password = 'pw-rm -rf /-secret';

      fakePtyInstances[0].emitData('Password: ');
      expect(mgr.writeInput(taskId, password).ok).toBe(true);

      // 模拟异常程序回显密码，且回显横跨两个 onData chunk。
      fakePtyInstances[0].emitData(`unexpected echo: ${password.slice(0, 8)}`);
      fakePtyInstances[0].emitData(`${password.slice(8)}\naccepted\n`);
      mgr.stop(taskId);

      await expect.poll(
        () => (existsSync(expectedPath) ? readFileSync(expectedPath, 'utf-8') : ''),
        { timeout: 3000, interval: 25 },
      ).toContain('[redacted]');

      const content = readFileSync(expectedPath, 'utf-8');
      expect(content).toContain('[interactive input: password] [redacted]');
      expect(content).toContain('accepted');
      expect(content).not.toContain(password);
    });

    it('stop/completed 清理敏感值和日志暂存尾部但保留终态输出', () => {
      const first = mgr.start();
      const stoppedTask = mgr.getActiveTask()!;
      fakePtyInstances[0].emitData('Password: ');
      expect(mgr.writeInput(first.taskId, 'stop-secret').ok).toBe(true);
      fakePtyInstances[0].emitData('stop-sec');
      expect(stoppedTask.sensitiveLogValues).toContain('stop-secret');
      mgr.stop(first.taskId);
      expect(stoppedTask.sensitiveLogValues).toEqual([]);
      expect(stoppedTask.logRedactionTail).toBe('');
      expect(mgr.read(first.taskId, 0)?.status).toBe('killed');

      const second = mgr.start();
      const completedTask = mgr.getActiveTask()!;
      fakePtyInstances[1].emitData('Password: ');
      expect(mgr.writeInput(second.taskId, 'exit-secret').ok).toBe(true);
      fakePtyInstances[1].emitData('welcome\n');
      fakePtyInstances[1].emitExit(0);
      expect(completedTask.sensitiveLogValues).toEqual([]);
      expect(completedTask.logRedactionTail).toBe('');
      expect(mgr.read(second.taskId, 0)?.output).toContain('welcome');
      expect(mgr.read(second.taskId, 0)?.status).toBe('completed');
    });
  });
});
