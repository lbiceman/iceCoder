import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { CheckpointEngine } from '../../src/harness/checkpoint-engine.js';
import {
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

describe('CheckpointEngine - save', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await makeTempDir(); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('首次 save 时生成完整 V3 与 resilience 扩展', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({ trigger: 'tool_failed' });

    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.version).toBe(3);
    expect(raw.extensions.runtimeResilience.lastTrigger).toBe('tool_failed');
    expect(raw.extensions.runtimeResilience.runtimeVersion).toBe(2);
  });

  it('已有 v1 checkpoint 时迁移为完整 V3 并保留任务字段', async () => {
    const v1 = buildV1Checkpoint();
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await fs.writeFile(engine.checkpointPath, JSON.stringify(v1, null, 2), 'utf-8');

    await engine.save({
      trigger: 'step_completed',
    });

    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.version).toBe(3);
    expect(raw.identity.checkpointId).toBe('task-1');
    expect(raw.execution.taskState.filesChanged).toEqual(['a.ts']);
    expect(raw.extensions.runtimeResilience).not.toHaveProperty('verificationPending');
    const backup = JSON.parse(
      await fs.readFile(`${engine.checkpointPath}.legacy.backup.json`, 'utf-8'),
    );
    expect(backup.taskId).toBe('task-1');
    expect(backup.version).toBe(1);
  });

  it('不再写入写次数、执行档与 recovery signal', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({
      trigger: 'tool_failed',
      appendFailure: { signature: 'run_command:npm test', count: 1, at: 1 },
    });

    const resilience = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'))
      .extensions.runtimeResilience;
    expect(resilience).not.toHaveProperty('branchBudget');
    expect(resilience).not.toHaveProperty('executionModeState');
    expect(resilience).not.toHaveProperty('recoverySignals');
    expect(resilience.recentFailures).toHaveLength(1);
  });

  it('只有失败 / 验收失败 / 压缩 / 收尾触发器单独落盘', () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    expect(engine.shouldPersistOnTrigger('tool_failed')).toBe(true);
    expect(engine.shouldPersistOnTrigger('verification_failed')).toBe(true);
    expect(engine.shouldPersistOnTrigger('compaction')).toBe(true);
    expect(engine.shouldPersistOnTrigger('final_draft')).toBe(true);
    expect(engine.shouldPersistOnTrigger('step_completed')).toBe(false);
    expect(engine.shouldPersistOnTrigger('verification_started')).toBe(false);
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
    expect(raw.extensions.runtimeResilience.recentTools.length).toBeLessThanOrEqual(20);
    // 保留最新的
    const last = raw.extensions.runtimeResilience.recentTools[
      raw.extensions.runtimeResilience.recentTools.length - 1
    ];
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
    expect(raw.extensions.runtimeResilience.recentFailures.length).toBe(1);
    expect(raw.extensions.runtimeResilience.recentFailures[0].count).toBe(2);
    expect(raw.extensions.runtimeResilience.recentFailures[0].lastError).toBe('boom2');
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

    await engine.save({
      trigger: 'step_completed',
      currentStepId: 'step-02',
      currentStepTitle: '编辑文件',
      appendTool: { toolName: 'edit_file', success: true, signature: 'sig-1', at: 10 },
    });

    const engine2 = new CheckpointEngine(tmp, 'sess-1');
    const v2 = await engine2.loadV2();
    expect(v2).not.toBeNull();
    const r = v2 as RuntimeCheckpointV2;
    expect(r.currentStepId).toBe('step-02');
    expect(r.verificationPending).toBe(false);
    expect(r.recentTools[0].toolName).toBe('edit_file');
  });

  it('旧 runtimeV2 带写次数 / 执行档 / recovery signal 仍可打开，并丢弃这些字段', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await fs.writeFile(engine.checkpointPath, JSON.stringify({
      ...buildV1Checkpoint(),
      runtimeV2: {
        runtimeVersion: 2,
        branchBudget: { fileEdits: { 'x.ts': 3 }, commandRetries: { ls: 2 }, errorRepeats: {}, recoverTriggers: 1 },
        recentTools: [{ toolName: 'edit_file', success: true, signature: 'sig-1', at: 10 }],
        recentFailures: [],
        recoverySignals: [{ source: 'branch_budget', message: 'switch strategy', at: 11, consumed: false }],
        verificationPending: false,
        executionModeState: { executionMode: 'forced', executionModeEnteredBy: ['tool_failure'] },
        rebuildEscalationInjections: 2,
        parallelBudgetBlockHintInjected: true,
        lastTrigger: 'tool_failed',
        v2UpdatedAt: '2026-01-01T00:00:00.000Z',
      },
    }, null, 2), 'utf-8');

    const restored = await new CheckpointEngine(tmp, 'sess-1').loadV2();

    expect(restored?.recentTools[0]?.signature).toBe('sig-1');
    expect(restored).not.toHaveProperty('branchBudget');
    expect(restored).not.toHaveProperty('executionModeState');
    expect(restored).not.toHaveProperty('recoverySignals');
    expect(restored).not.toHaveProperty('rebuildEscalationInjections');
  });

  it('旧 V3 文件里的 runtimeResilience 带写次数时仍可打开', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({ trigger: 'tool_failed' });
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    raw.extensions.runtimeResilience.branchBudget = {
      fileEdits: { 'a.ts': 3 }, commandRetries: {}, errorRepeats: {}, recoverTriggers: 0,
    };
    raw.extensions.runtimeResilience.executionModeState = { executionMode: 'forced' };
    raw.execution.resumable = {
      branchBudget: { fileEdits: { 'a.ts': 3 }, commandRetries: {}, errorRepeats: {}, recoverTriggers: 0 },
    };
    await fs.writeFile(engine.checkpointPath, JSON.stringify(raw), 'utf-8');

    const restored = await new CheckpointEngine(tmp, 'sess-1').loadV2();
    expect(restored?.lastTrigger).toBe('tool_failed');
    expect(restored).not.toHaveProperty('branchBudget');
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

describe('CheckpointEngine - memory', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await makeTempDir(); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('resetMemory 清空内存状态但不影响磁盘文件', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    await engine.save({
      trigger: 'tool_failed',
      appendTool: { toolName: 'run_command', success: false, signature: 'x', at: 1 },
    });
    engine.resetMemory();
    expect(engine.getV2State().recentTools).toEqual([]);
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.extensions.runtimeResilience.recentTools.length).toBe(1);
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

  it('stage accumulates tools until the next durable save', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-1');
    engine.stage({
      trigger: 'step_completed',
      appendTool: { toolName: 'read_file', success: true, signature: 'a', at: 1 },
    });
    engine.stage({
      trigger: 'step_completed',
      appendTool: { toolName: 'read_file', success: true, signature: 'b', at: 2 },
    });
    await expect(fs.access(engine.checkpointPath)).rejects.toMatchObject({ code: 'ENOENT' });

    await engine.save({ trigger: 'final_draft' });
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, 'utf-8'));
    expect(raw.extensions.runtimeResilience.recentTools.map((tool: { signature: string }) => tool.signature))
      .toEqual(['a', 'b']);
  });
});
