/**
 * Harness 审计 P1（#24–#33）回归测试。见 docs/harness/Harness-审计修复清单.md。
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkMissingFilePreflight } from '../../src/harness/harness-tool-preflight.js';
import {
  loadSessionWorkspace,
  saveSessionWorkspace,
} from '../../src/harness/session-workspace-store.js';
import { ProjectCheckpointStore } from '../../src/harness/project-checkpoint-store.js';
import { saveTaskCheckpoint, type CheckpointDeps } from '../../src/harness/harness-checkpoint.js';
import { RuntimeTelemetry } from '../../src/harness/runtime-telemetry.js';
import { TaskCheckpointManager } from '../../src/harness/checkpoint.js';
import { captureIntentCheckpoint } from '../../src/harness/intent-checkpoint-capture.js';
import {
  getCheckpointIndexLockCount,
  loadCheckpointIndex,
  loadSessionTouchedPaths,
  setCheckpointCursor,
  touchSessionTouchedPaths,
} from '../../src/harness/intent-checkpoint-store.js';
import {
  beginIntentCheckpointTurn,
  capturePreTurnWriteSnapshot,
  clearIntentCheckpointTurnsForSession,
  finalizeIntentCheckpointTurn,
} from '../../src/harness/intent-checkpoint-turn-snapshot.js';
import { RuntimeRestoreCoordinator } from '../../src/harness/runtime-restore-coordinator.js';
import { resetHarnessRuntimeRegistry } from '../../src/harness/harness-runtime-registry.js';
import { resetSessionContextWriteEpoch } from '../../src/harness/session-context-write-gate.js';
import {
  applyWorkspaceFileSnapshot,
  RestoreFailedError,
} from '../../src/harness/workspace-snapshot.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import type { UnifiedMessage } from '../../src/llm/types.js';
import type { ProjectCheckpointV3 } from '../../src/types/runtime-checkpoint.js';

const isWin = process.platform === 'win32';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-audit-p1-persist-'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

async function captureTurn(
  sessionId: string,
  messageId: string,
  workspaceRoot: string,
  userMessageTime: number,
): Promise<void> {
  await captureIntentCheckpoint({
    sessionDir: tmp,
    sessionId,
    messageId,
    userMessageTime,
    workspaceRoot,
    workspaceState: { referenceReads: [], changeCount: 0, lockedRoot: workspaceRoot },
    structuredMessages: [{ role: 'user', content: '请处理任务' }],
    uiMessages: [{ role: 'user', content: '请处理任务', id: messageId, sentAt: userMessageTime }],
  });
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil timed out');
}

function validCheckpoint(sessionId: string): ProjectCheckpointV3 {
  return {
    version: 3,
    identity: { checkpointId: 'cp-1', projectId: 'project-1', sessionId },
    execution: {
      taskState: {
        goal: 'goal',
        intent: 'edit',
        phase: 'editing',
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
      },
      loopState: {
        currentRound: 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        lastInputTokens: 0,
        lastOutputTokens: 0,
        totalToolCalls: 0,
        startTime: 1,
      },
    },
    completion: { conditions: [], operationOutcomes: [] },
    conversation: { messages: [{ role: 'user', content: 'hi' }] },
    workspace: {
      root: tmp,
      repoContext: {
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
    },
    memory: {},
    snapshotMeta: { capturedAt: '2026-10-13T00:00:00.000Z', trigger: 'manual' },
    extensions: {},
    migration: null,
  };
}

async function corruptFiles(dir: string, baseName: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.startsWith(`${baseName}.corrupt.`));
}

describe('#24 missing-file 键大小写与绝对路径', () => {
  it.runIf(isWin)('Windows 上大小写不同的缺失路径累计到同一个 missing-file 计数', () => {
    const attempts = new Map<string, number>();
    const first = checkMissingFilePreflight({
      toolName: 'edit_file',
      path: 'Src/missing.ts',
      workspaceRoot: tmp,
      lockedWorkspaceRoot: tmp,
      missingFileAttempts: attempts,
    });
    const second = checkMissingFilePreflight({
      toolName: 'edit_file',
      path: 'src/MISSING.ts',
      workspaceRoot: tmp,
      lockedWorkspaceRoot: tmp,
      missingFileAttempts: attempts,
    });

    expect(first.reason).toBe('missing_file');
    expect(second.reason).toBe('missing_file_repeat');
  });

  it('执行器按原始相对路径记下的 ENOENT 计数，对绝对路径写法同样生效', () => {
    const attempts = new Map<string, number>([['src/missing.ts', 1]]);
    const decision = checkMissingFilePreflight({
      toolName: 'read_file',
      path: path.join(tmp, 'src', 'missing.ts'),
      workspaceRoot: tmp,
      lockedWorkspaceRoot: tmp,
      missingFileAttempts: attempts,
    });

    expect(decision.blocked).toBe(true);
    expect(decision.reason).toBe('missing_file_repeat');
  });
});

describe('#25 workspace.json 原子写与损坏保留', () => {
  it('目标文件只读时仍能保存（tmp + rename，而不是原地覆盖）', async () => {
    const file = path.join(tmp, 's1.workspace.json');
    await fs.writeFile(file, JSON.stringify({ referenceReads: [], changeCount: 0 }), 'utf-8');
    await fs.chmod(file, 0o444);

    await saveSessionWorkspace(tmp, 's1', { referenceReads: [], changeCount: 3 });

    expect(JSON.parse(await fs.readFile(file, 'utf-8')).changeCount).toBe(3);
    expect((await fs.readdir(tmp)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('解析失败时保留 .corrupt 副本并 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const file = path.join(tmp, 's1.workspace.json');
    await fs.writeFile(file, '{"lockedRoot": "C:/proj"', 'utf-8');

    const state = await loadSessionWorkspace(tmp, 's1');

    expect(state.lockedRoot).toBeUndefined();
    expect(await fs.readFile(`${file}.corrupt`, 'utf-8')).toBe('{"lockedRoot": "C:/proj"');
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(warn).toHaveBeenCalled();
  });
});

describe('#26 损坏 / schema 不合法的 checkpoint 不再静默当作「没有」', () => {
  it('ENOENT：返回 null，不 warn，不产生 .corrupt 文件', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new ProjectCheckpointStore({ sessionDir: tmp, sessionId: 's-missing' });

    expect(await store.load()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(await corruptFiles(tmp, path.basename(store.checkpointPath))).toEqual([]);
  });

  it('损坏 JSON：移至 .corrupt.<ts> 并 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new ProjectCheckpointStore({ sessionDir: tmp, sessionId: 's-corrupt' });
    await fs.writeFile(store.checkpointPath, '{broken', 'utf-8');

    expect(await store.load()).toBeNull();

    const moved = await corruptFiles(tmp, path.basename(store.checkpointPath));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/\.corrupt\.\d+$/);
    expect(await fs.readFile(path.join(tmp, moved[0]), 'utf-8')).toBe('{broken');
    expect(await store.hasDurableFile()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt JSON'));
  });

  it('v3 schema 校验失败：同样移走并 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new ProjectCheckpointStore({ sessionDir: tmp, sessionId: 's-schema' });
    const invalid = JSON.stringify({ version: 3, identity: 'not-an-object' });
    await fs.writeFile(store.checkpointPath, invalid, 'utf-8');

    expect(await store.load()).toBeNull();

    const moved = await corruptFiles(tmp, path.basename(store.checkpointPath));
    expect(moved).toHaveLength(1);
    expect(await fs.readFile(path.join(tmp, moved[0]), 'utf-8')).toBe(invalid);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('schema'));
  });

  it('legacy backup 已存在时，直接 save 覆盖坏文件前仍另存一份 .corrupt.<ts>', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new ProjectCheckpointStore({ sessionDir: tmp, sessionId: 's-second' });
    await fs.writeFile(store.legacyBackupPath, '{"first":"backup"}', 'utf-8');
    await fs.writeFile(store.checkpointPath, '{second broken', 'utf-8');

    await store.save(validCheckpoint('s-second'));

    expect(await fs.readFile(store.legacyBackupPath, 'utf-8')).toBe('{"first":"backup"}');
    const copies = await corruptFiles(tmp, path.basename(store.checkpointPath));
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(tmp, copies[0]), 'utf-8')).toBe('{second broken');
    expect(JSON.parse(await fs.readFile(store.checkpointPath, 'utf-8')).version).toBe(3);
  });

  it('saveTaskCheckpoint 落盘失败以 warn 级别记录', async () => {
    const prevRuntimeDir = process.env.ICE_RUNTIME_DIR;
    delete process.env.ICE_RUNTIME_DIR;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sessionDir = path.join(tmp, 'sessions');
    const deps = {
      checkpointManager: { save: async () => { throw new Error('disk full'); } },
      loopController: { getState: () => ({}) },
      enqueueCheckpointPersist: <T>(task: () => Promise<T>) => task(),
      runtimeTelemetry: new RuntimeTelemetry(sessionDir, 's-fail'),
    } as unknown as CheckpointDeps;
    const runtimeState = {
      taskState: new TaskState('goal'),
      repoContext: new RepoContext(),
      failedToolCallSignatures: new Map<string, number>(),
    };

    try {
      await saveTaskCheckpoint(deps, 'running', 'goal', [], runtimeState as never);

      expect(warn).toHaveBeenCalledWith('[harness] checkpoint save failed:', 'disk full');
      const raw = await fs.readFile(path.join(sessionDir, 's-fail.telemetry.jsonl'), 'utf8');
      expect(JSON.parse(raw)).toMatchObject({
        type: 'failure',
        sessionId: 's-fail',
        source: 'checkpoint_save',
        message: 'disk full',
      });
    } finally {
      if (prevRuntimeDir === undefined) delete process.env.ICE_RUNTIME_DIR;
      else process.env.ICE_RUNTIME_DIR = prevRuntimeDir;
    }
  });
});

describe('#27 intent 回合 finalize 不移动 cursor', () => {
  afterEach(() => clearIntentCheckpointTurnsForSession('s-cursor'));

  it('补录较早回合的写前快照后，cursor 仍停在最新检查点', async () => {
    const sessionId = 's-cursor';
    await fs.writeFile(path.join(tmp, 'a.txt'), 'before', 'utf-8');
    await captureTurn(sessionId, 'm1', tmp, 1000);
    await captureTurn(sessionId, 'm2', tmp, 2000);
    await setCheckpointCursor(tmp, sessionId, 'm2');

    beginIntentCheckpointTurn(sessionId, 'm1', tmp);
    await capturePreTurnWriteSnapshot(sessionId, tmp, 'a.txt');
    await finalizeIntentCheckpointTurn(tmp, sessionId, 'm1');

    const index = await loadCheckpointIndex(tmp, sessionId);
    expect(index.cursorMessageId).toBe('m2');
    expect(index.cursorRestored).toBe(true);
    expect(index.entries.map((e) => e.messageId)).toEqual(['m1', 'm2']);
  });
});

describe('#28 lastCompletedStep / nextSuggestedStep 持久化往返', () => {
  it('save 后重新 loadActive 仍能拿到推断出的步骤', async () => {
    const manager = new TaskCheckpointManager(tmp, 's-steps');
    const saved = await manager.save({
      status: 'running',
      userGoal: 'Fix build',
      taskState: new TaskState('Fix build').snapshot(),
      repoContext: { ...new RepoContext().snapshot(), testCommands: ['npm test'] },
      loopState: {
        currentRound: 1,
        totalToolCalls: 1,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        stopReason: undefined,
        executionMode: 'free',
      },
      messages: [{ role: 'user', content: 'Fix build' }] as UnifiedMessage[],
    });
    expect(saved.lastCompletedStep).toBe('Ran verification command: npm test');

    const restored = await new TaskCheckpointManager(tmp, 's-steps').loadActive();

    expect(restored?.lastCompletedStep).toBe(saved.lastCompletedStep);
    expect(restored?.nextSuggestedStep).toBe(saved.nextSuggestedStep);
  });
});

describe('#29 checkpoint 文件锁：PID 存活检测与心跳', () => {
  it('持有进程已退出的锁立即回收，不必等 30s 过期', async () => {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(child.pid).toBeGreaterThan(0);
    const store = new ProjectCheckpointStore({ sessionDir: tmp, sessionId: 's-dead-lock' });
    await fs.writeFile(store.lockPath, JSON.stringify({ pid: child.pid, acquiredAt: Date.now() }), 'utf-8');

    const started = Date.now();
    expect(await store.load()).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(fs.access(store.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('持有锁期间刷新 mtime，长操作不会被当成过期锁', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = new ProjectCheckpointStore({ sessionDir: tmp, sessionId: 's-heartbeat' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const realReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === store.checkpointPath) await gate;
      return realReadFile(...args);
    }) as typeof fs.readFile);

    const loading = store.load();
    await waitUntil(async () => fs.access(store.lockPath).then(() => true, () => false));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(store.lockPath, old, old);

    vi.advanceTimersByTime(5_000);
    await waitUntil(async () => (await fs.stat(store.lockPath)).mtimeMs > old.getTime() + 30_000);

    release();
    expect(await loading).toBeNull();
    await expect(fs.access(store.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('#30 intent 索引 / 归档统一走 writeFileAtomic', () => {
  it('索引文件只读（Windows rename EPERM）时仍能更新', async () => {
    const sessionId = 's-ro-index';
    await captureTurn(sessionId, 'm1', tmp, 1000);
    const index = path.join(tmp, `${sessionId}.checkpoint-index.json`);
    await fs.chmod(index, 0o444);

    await touchSessionTouchedPaths(tmp, sessionId, ['a.txt']);

    expect(await loadSessionTouchedPaths(tmp, sessionId)).toEqual(['a.txt']);
  });
});

describe('#31 intent 索引锁键规范化', () => {
  it('同一索引文件的不同路径写法共用一条写链，不丢更新', async () => {
    const sessionId = 's-lock-key';
    const before = getCheckpointIndexLockCount();
    const variant = isWin ? `${tmp.toUpperCase()}${path.sep}.` : `${tmp}${path.sep}.`;

    const first = touchSessionTouchedPaths(tmp, sessionId, ['a.txt']);
    const second = touchSessionTouchedPaths(variant, sessionId, ['b.txt']);
    expect(getCheckpointIndexLockCount() - before).toBe(1);
    await Promise.all([first, second]);

    expect((await loadSessionTouchedPaths(tmp, sessionId)).sort()).toEqual(['a.txt', 'b.txt']);
  });
});

describe('#32 restore 使用归档里的 workspaceRoot', () => {
  const sessionId = 's-restore-root';

  beforeEach(() => {
    resetHarnessRuntimeRegistry();
    resetSessionContextWriteEpoch(sessionId);
  });

  afterEach(() => clearIntentCheckpointTurnsForSession(sessionId));

  it('会话之后切换了 lockedRoot，文件仍写回捕获时的根', async () => {
    const rootA = path.join(tmp, 'rootA');
    const rootB = path.join(tmp, 'rootB');
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });
    await fs.writeFile(path.join(rootA, 'a.txt'), 'A-old', 'utf-8');
    await fs.writeFile(path.join(rootB, 'a.txt'), 'B-content', 'utf-8');

    await captureTurn(sessionId, 'm1', rootA, 1000);
    beginIntentCheckpointTurn(sessionId, 'm1', rootA);
    await capturePreTurnWriteSnapshot(sessionId, rootA, 'a.txt');
    await fs.writeFile(path.join(rootA, 'a.txt'), 'A-new', 'utf-8');
    await finalizeIntentCheckpointTurn(tmp, sessionId, 'm1');

    await saveSessionWorkspace(tmp, sessionId, { referenceReads: [], changeCount: 1, lockedRoot: rootB });

    await new RuntimeRestoreCoordinator().restore({
      sessionDir: tmp,
      sessionId,
      messageId: 'm1',
      defaultWorkDir: rootB,
    });

    expect(await fs.readFile(path.join(rootA, 'a.txt'), 'utf-8')).toBe('A-old');
    expect(await fs.readFile(path.join(rootB, 'a.txt'), 'utf-8')).toBe('B-content');
    const workspace = await loadSessionWorkspace(tmp, sessionId);
    expect(path.resolve(workspace.lockedRoot ?? '')).toBe(path.resolve(rootA));
  });
});

describe('#33 工作区快照写回：逐文件原子写 + RestoreFailedError', () => {
  it('单个文件失败时其余文件照常写回，最后抛 RestoreFailedError', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fs.writeFile(path.join(tmp, 'blocker.txt'), 'file, not dir', 'utf-8');

    const err = await applyWorkspaceFileSnapshot(tmp, {
      'blocker.txt/child.txt': 'cannot write',
      'ok.txt': 'restored',
      '../outside.txt': 'must be skipped',
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(RestoreFailedError);
    expect((err as Error).message).toContain('blocker.txt/child.txt');
    expect(await fs.readFile(path.join(tmp, 'ok.txt'), 'utf-8')).toBe('restored');
    await expect(fs.access(path.join(path.dirname(tmp), 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(tmp)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('只读目标文件也能被替换（tmp + rename）', async () => {
    const file = path.join(tmp, 'ro.txt');
    await fs.writeFile(file, 'current', 'utf-8');
    await fs.chmod(file, 0o444);

    await applyWorkspaceFileSnapshot(tmp, { 'ro.txt': 'restored' });

    expect(await fs.readFile(file, 'utf-8')).toBe('restored');
  });
});
