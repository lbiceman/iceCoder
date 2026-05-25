import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { CheckpointEngine, isResilienceV2Enabled } from '../../src/harness/checkpoint-engine.js';
import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import {
  RUNTIME_CHECKPOINT_VERSION,
  isRuntimeCheckpointV2,
  type RuntimeCheckpointV2,
} from '../../src/types/runtime-checkpoint.js';
import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'icecoder-ce-'));
}

function buildV1Checkpoint(): TaskCheckpoint {
  return {
    version: 1,
    taskId: 'task-1',
    status: 'running',
    userGoal: 'demo',
    phase: 'editing',
    taskState: {
      goal: 'demo',
      intent: 'edit',
      phase: 'editing',
      filesRead: ['a.ts'],
      filesChanged: ['a.ts'],
      commandsRun: [],
      verificationRequired: false,
      verificationStatus: 'not_required',
    },
    repoContext: {
      filesRead: ['a.ts'],
      filesChanged: ['a.ts'],
      commandsRun: [],
      testCommands: [],
      recentDiagnostics: [],
    },
    failedToolCalls: [],
    messageCount: 5,
    loop: {
      currentRound: 3,
      totalToolCalls: 4,
      totalInputTokens: 100,
      totalOutputTokens: 50,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('isResilienceV2Enabled', () => {
  it('硬编码为始终开启（不再读取 ICE_ENABLE_RESILIENCE_V2）', () => {
    expect(isResilienceV2Enabled()).toBe(true);
  });
});

describe('CheckpointEngine - save', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await makeTempDir(); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('首次 save 时若文件不存在则生成最小 v1 壳 + v2 字段', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({ trigger: 'tool_failed' });

    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(isRuntimeCheckpointV2(raw.runtimeV2)).toBe(true);
    expect(raw.runtimeV2.lastTrigger).toBe('tool_failed');
    expect(raw.runtimeV2.runtimeVersion).toBe(RUNTIME_CHECKPOINT_VERSION);
  });

  it('已有 v1 checkpoint 时只追加 runtimeV2，不破坏 v1 字段', async () => {
    const v1 = buildV1Checkpoint();
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await fs.writeFile(engine.checkpointPath, JSON.stringify(v1, null, 2), 'utf-8');

    await engine.save({
      trigger: 'step_completed',
      verificationPending: true,
    });

    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.taskId).toBe('task-1');
    expect(raw.taskState.filesChanged).toEqual(['a.ts']);
    expect(raw.runtimeV2.verificationPending).toBe(true);
  });

  it('合并 branchBudget 快照', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    const budget = new BranchBudgetTracker();
    budget.recordFileEdit('a.ts');
    budget.recordFileEdit('a.ts');
    budget.recordFailedCommandAttempt('npm test');
    budget.markRecoveryTriggered();

    await engine.save({ trigger: 'tool_failed', branchBudget: budget });
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.runtimeV2.branchBudget.fileEdits['a.ts']).toBe(2);
    expect(raw.runtimeV2.branchBudget.commandRetries['npm test']).toBe(1);
    expect(raw.runtimeV2.branchBudget.recoverTriggers).toBe(1);
  });

  it('保存调用方提供的 supervisor execution-mode 状态', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');

    await engine.save({
      trigger: 'step_completed',
      supervisorState: {
        executionMode: 'forced',
        executionModeLockRemaining: 1,
        executionModeEnteredBy: ['checkpoint_resumed', 'pending_steps'],
        executionModeEnteredByPrimary: 'checkpoint_resumed',
        executionModeEnteredAtRound: 7,
        pendingModeSignals: ['tool_failure'],
        forcedTaskBearingRoundsSinceEntry: 1,
      },
    });

    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.runtimeV2.supervisorState).toMatchObject({
      executionMode: 'forced',
      executionModeLockRemaining: 1,
      executionModeEnteredBy: ['checkpoint_resumed', 'pending_steps'],
      executionModeEnteredByPrimary: 'checkpoint_resumed',
      executionModeEnteredAtRound: 7,
      pendingModeSignals: ['tool_failure'],
      forcedTaskBearingRoundsSinceEntry: 1,
    });
  });

  it('多次 appendTool 累积并限制最大条数', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    for (let i = 0; i < 30; i++) {
      await engine.save({
        trigger: 'step_completed',
        appendTool: { toolName: 'read_file', success: true, signature: `sig-${i}`, at: i },
      });
    }
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.runtimeV2.recentTools.length).toBeLessThanOrEqual(20);
    // 保留最新的
    const last = raw.runtimeV2.recentTools[raw.runtimeV2.recentTools.length - 1];
    expect(last.signature).toBe('sig-29');
  });

  it('appendFailure 同签名累加 count，不重复入列', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({
      trigger: 'tool_failed',
      appendFailure: { signature: 'edit_file:x', count: 1, lastError: 'boom', at: 1 },
    });
    await engine.save({
      trigger: 'tool_failed',
      appendFailure: { signature: 'edit_file:x', count: 2, lastError: 'boom2', at: 2 },
    });
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.runtimeV2.recentFailures.length).toBe(1);
    expect(raw.runtimeV2.recentFailures[0].count).toBe(2);
    expect(raw.runtimeV2.recentFailures[0].lastError).toBe('boom2');
  });

  it('persists verificationOutputTail across save and loadV2', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    const tail = [
      { command: 'npm run build 2>&1', outputBody: 'error TS2304', at: 100 },
      { command: 'npm run test:e2e', outputBody: 'e2e timeout', at: 200 },
    ];

    await engine.save({ trigger: 'verification_failed', verificationOutputTail: tail });

    const loaded = await engine.loadV2();
    expect(loaded?.verificationOutputTail).toEqual(tail);
  });
});

describe('CheckpointEngine - restore', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await makeTempDir(); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('loadV2 返回 null 当文件不存在', async () => {
    const engine = new CheckpointEngine(tmp, 'missing');
    expect(await engine.loadV2()).toBeNull();
  });

  it('loadV2 返回 null 当文件只有 v1 字段（向后兼容）', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await fs.writeFile(engine.checkpointPath, JSON.stringify(buildV1Checkpoint(), null, 2), 'utf-8');
    expect(await engine.loadV2()).toBeNull();
  });

  it('save → loadV2 完整往返保留状态', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    const budget = new BranchBudgetTracker();
    budget.recordFileEdit('x.ts');
    budget.recordFailedCommandAttempt('ls');
    budget.markRecoveryTriggered();

    await engine.save({
      trigger: 'step_completed',
      branchBudget: budget,
      currentStepId: 'step-02',
      currentStepTitle: '编辑文件',
      verificationPending: true,
      appendTool: { toolName: 'edit_file', success: true, signature: 'sig-1', at: 10 },
      appendRecoverySignal: {
        source: 'branch_budget',
        message: 'switch strategy',
        at: 11,
        consumed: false,
      },
    });

    const engine2 = new CheckpointEngine(tmp, 'sess-1');
    const v2 = await engine2.loadV2();
    expect(v2).not.toBeNull();
    const r = v2 as RuntimeCheckpointV2;
    expect(r.currentStepId).toBe('step-02');
    expect(r.verificationPending).toBe(true);
    expect(r.branchBudget.fileEdits['x.ts']).toBe(1);
    expect(r.branchBudget.commandRetries['ls']).toBe(1);
    expect(r.branchBudget.recoverTriggers).toBe(1);
    expect(r.recentTools[0].toolName).toBe('edit_file');
    expect(r.recoverySignals[0].message).toBe('switch strategy');
  });

  it('save → loadV2 保留 supervisor execution-mode 扩展字段', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');

    const saved = await engine.save({ trigger: 'manual' });
    saved.supervisorState = {
      executionMode: 'forced',
      executionModeLockRemaining: 2,
      executionModeEnteredBy: ['checkpoint_resumed'],
      executionModeEnteredByPrimary: 'checkpoint_resumed',
      executionModeEnteredAtRound: 4,
      pendingModeSignals: ['tool_failure'],
      forcedTaskBearingRoundsSinceEntry: 1,
    };
    await fs.writeFile(engine.checkpointPath, JSON.stringify({
      ...buildV1Checkpoint(),
      runtimeV2: saved,
    }, null, 2), 'utf-8');

    const restored = await new CheckpointEngine(tmp, 'sess-1').loadV2();

    expect(restored?.supervisorState).toMatchObject({
      executionMode: 'forced',
      executionModeLockRemaining: 2,
      executionModeEnteredBy: ['checkpoint_resumed'],
      pendingModeSignals: ['tool_failure'],
      forcedTaskBearingRoundsSinceEntry: 1,
    });
  });

  it('部分 supervisorState 字段缺失时仍可 loadV2 并补安全默认值', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    const saved = await engine.save({ trigger: 'manual' });
    saved.supervisorState = {
      executionMode: 'forced',
    } as any;
    await fs.writeFile(engine.checkpointPath, JSON.stringify({
      ...buildV1Checkpoint(),
      runtimeV2: saved,
    }, null, 2), 'utf-8');

    const restored = await new CheckpointEngine(tmp, 'sess-1').loadV2();

    expect(restored?.supervisorState).toMatchObject({
      executionMode: 'forced',
      executionModeLockRemaining: 0,
      executionModeEnteredBy: [],
      executionModeEnteredAtRound: null,
      pendingModeSignals: [],
      forcedTaskBearingRoundsSinceEntry: 0,
    });
  });

  it('损坏的 JSON → loadV2 返回 null 而不抛', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await fs.writeFile(engine.checkpointPath, '{not valid json', 'utf-8');
    expect(await engine.loadV2()).toBeNull();
  });

  it('runtimeV2 schema 版本错误（不是 2） → loadV2 返回 null', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    const bad: any = {
      ...buildV1Checkpoint(),
      runtimeV2: {
        runtimeVersion: 99,
        branchBudget: { fileEdits: {}, commandRetries: {}, errorRepeats: {}, recoverTriggers: 0 },
        recentTools: [],
        recentFailures: [],
        recoverySignals: [],
        verificationPending: false,
        lastTrigger: 'manual',
        v2UpdatedAt: '2026-01-01',
      },
    };
    await fs.writeFile(engine.checkpointPath, JSON.stringify(bad, null, 2), 'utf-8');
    expect(await engine.loadV2()).toBeNull();
  });
});

describe('CheckpointEngine - recovery signals', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await makeTempDir(); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('pendingRecoverySignals 仅返回未消费的', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({
      trigger: 'tool_failed',
      appendRecoverySignal: { source: 'branch_budget', message: 'a', at: 1, consumed: false },
    });
    await engine.save({
      trigger: 'tool_failed',
      appendRecoverySignal: { source: 'branch_budget', message: 'b', at: 2, consumed: false },
    });
    expect(engine.pendingRecoverySignals().length).toBe(2);

    engine.markRecoverySignalsConsumed(s => s.message === 'a');
    expect(engine.pendingRecoverySignals().map(s => s.message)).toEqual(['b']);
  });

  it('resetMemory 清空内存状态但不影响磁盘文件', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({
      trigger: 'tool_failed',
      appendRecoverySignal: { source: 'branch_budget', message: 'x', at: 1, consumed: false },
    });
    engine.resetMemory();
    expect(engine.getV2State().recoverySignals).toEqual([]);
    // 磁盘文件保留
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.runtimeV2.recoverySignals.length).toBe(1);
  });
});

describe('CheckpointEngine - 写入原子性', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await makeTempDir(); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('写入是先 tmp + rename，不会留下半写入的 tmp 文件', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({ trigger: 'manual' });
    const files = await fs.readdir(tmp);
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
    expect(files.length).toBe(1);
  });
});
