/**
 * Mock 考试 shell 协作路径单元测试（Wave 8.1）
 *
 * 使用 mock node-pty 模拟：password prompt → 登录 → 题面 → df/du。
 * 不依赖真实 PTY，CI / Windows 可稳定运行。
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

import {
  InteractiveShellManager,
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

/** 绑定 mock PTY：password → 题面 → exam$ → df/du 响应 */
function bindMockExamShellResponses(fake: FakePty): void {
  fake.write.mockImplementation((input: string) => {
    const trimmed = input.replace(/\r?\n$/, '');
    if (trimmed === 'mock-password' || trimmed === 'secret') {
      fake.emitData('\nWelcome to Exam Shell (mock)\n');
      fake.emitData('题目：日志与磁盘处理\n');
      fake.emitData('exam$ ');
      return;
    }
    if (trimmed.startsWith('df')) {
      fake.emitData('Filesystem      Size  Used Avail Use% Mounted on\n');
      fake.emitData('/dev/mock0       20G   15G  4.0G  79% /\n');
      return;
    }
    if (trimmed.startsWith('du')) {
      fake.emitData('120M\t/var/log/syslog\n');
      fake.emitData('80M\t/var/log/app.log\n');
    }
  });
}

afterEach(() => {
  __resetInteractiveShellManagers();
});

describe('mock-exam-shell — SSH/考试协作路径 (Wave 8.1, mock pty)', () => {
  beforeEach(() => {
    resetFakePtyMocks();
  });

  it('password prompt → writeInput → 题面「日志与磁盘处理」', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-mock-exam-'));
    const mgr = new InteractiveShellManager(workDir, 'mock-exam');
    const { taskId } = mgr.start({ command: 'node mock-exam-shell.mjs' });
    expect(taskId).toBeTruthy();

    const fake = fakePtyInstances[0]!;
    bindMockExamShellResponses(fake);
    fake.emitData("exam@mock-host's password: ");

    expect(mgr.read(taskId!, 0)?.status).toBe('awaiting_input');

    const writeResult = mgr.writeInput(taskId!, 'mock-password');
    expect(writeResult.ok).toBe(true);

    const full = mgr.read(taskId!, 0)?.output ?? '';
    expect(full).toMatch(/题目：日志与磁盘处理/);
    expect(full).toMatch(/Welcome to Exam Shell/);
  });

  it('登录后 writeCommand 执行 df（shell_exec 路径，同一 PTY）', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-mock-exam-cmd-'));
    const mgr = new InteractiveShellManager(workDir, 'mock-exam-cmd');
    const { taskId } = mgr.start({ command: 'node mock-exam-shell.mjs' });
    const fake = fakePtyInstances[0]!;
    bindMockExamShellResponses(fake);

    fake.emitData("exam@mock-host's password: ");
    mgr.writeInput(taskId!, 'secret');

    const sinceDf = mgr.read(taskId!, 0)?.cursor ?? 0;
    const dfWrite = mgr.writeCommand(taskId!, 'df -h');
    expect(dfWrite.ok).toBe(true);
    const dfOut = mgr.read(taskId!, sinceDf)?.output ?? '';
    expect(dfOut).toMatch(/\/dev\/mock0/);
  });
});
