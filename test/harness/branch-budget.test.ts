import { describe, it, expect } from 'vitest';
import {
  BranchBudgetTracker,
  DEFAULT_BRANCH_BUDGET,
} from '../../src/harness/branch-budget.js';
import {
  emptyBranchBudgetSnapshot,
  type BranchBudgetSnapshot,
} from '../../src/types/runtime-checkpoint.js';

describe('BranchBudgetTracker - file edit', () => {
  it('记录同一文件的累计编辑次数', () => {
    const t = new BranchBudgetTracker();
    expect(t.recordFileEdit('src/a.ts')).toBe(1);
    expect(t.recordFileEdit('src/a.ts')).toBe(2);
    expect(t.recordFileEdit('src/a.ts')).toBe(3);
    expect(t.inspect().fileEdits['src/a.ts']).toBe(3);
  });

  it('未达到上限时 shouldBranchRecover 不触发', () => {
    const t = new BranchBudgetTracker();
    for (let i = 0; i < DEFAULT_BRANCH_BUDGET.fileEditMax; i++) {
      t.recordFileEdit('src/a.ts');
    }
    expect(t.shouldBranchRecover().triggered).toBe(false);
  });

  it('超过上限触发 file_edit 维度的 recovery', () => {
    const t = new BranchBudgetTracker();
    for (let i = 0; i <= DEFAULT_BRANCH_BUDGET.fileEditMax; i++) {
      t.recordFileEdit('src/a.ts');
    }
    const d = t.shouldBranchRecover();
    expect(d.triggered).toBe(true);
    expect(d.dimension).toBe('file_edit');
    expect(d.key).toBe('src/a.ts');
    expect(d.currentCount).toBe(DEFAULT_BRANCH_BUDGET.fileEditMax + 1);
  });

  it('空 path 不计数', () => {
    const t = new BranchBudgetTracker();
    expect(t.recordFileEdit('')).toBe(0);
    expect(t.recordFileEdit(undefined)).toBe(0);
    expect(t.inspect().fileEdits).toEqual({});
  });
});

describe('BranchBudgetTracker - command retry (仅失败计数)', () => {
  it('记录同一规范化命令的失败累计次数（空白合并）', () => {
    const t = new BranchBudgetTracker();
    t.recordFailedCommandAttempt('npm  test');
    t.recordFailedCommandAttempt('npm test');
    t.recordFailedCommandAttempt('npm   test');
    expect(t.inspect().commandRetries['npm test']).toBe(3);
  });

  it('超过 commandRetryMax 触发 command_retry recovery', () => {
    const t = new BranchBudgetTracker({ commandRetryMax: 2 });
    t.recordFailedCommandAttempt('npm test');
    t.recordFailedCommandAttempt('npm test');
    expect(t.shouldBranchRecover().triggered).toBe(false);
    t.recordFailedCommandAttempt('npm test');
    const d = t.shouldBranchRecover();
    expect(d.triggered).toBe(true);
    expect(d.dimension).toBe('command_retry');
    expect(d.currentCount).toBe(3);
  });
});

describe('BranchBudgetTracker - error repeat', () => {
  it('对错误签名做规范化（去时间戳、去行列号）', () => {
    const t = new BranchBudgetTracker();
    t.recordError('TypeError at src/a.ts:12:5');
    t.recordError('TypeError at src/a.ts:99:88');
    t.recordError('TypeError at src/a.ts:1:1');
    // 三条签名应被归并为同一条
    const errs = t.inspect().errorRepeats;
    const keys = Object.keys(errs);
    expect(keys.length).toBe(1);
    expect(errs[keys[0]]).toBe(3);
  });

  it('超过 errorRepeatMax 触发 error_repeat recovery', () => {
    const t = new BranchBudgetTracker({ errorRepeatMax: 3 });
    for (let i = 0; i < 4; i++) t.recordError('boom');
    const d = t.shouldBranchRecover();
    expect(d.triggered).toBe(true);
    expect(d.dimension).toBe('error_repeat');
  });
});

describe('BranchBudgetTracker - recovery signal', () => {
  it('未触发时 buildRecoverySignal 返回 null', () => {
    const t = new BranchBudgetTracker();
    expect(t.buildRecoverySignal()).toBeNull();
  });

  it('触发时生成 source=branch_budget 的非破坏性 warning', () => {
    const t = new BranchBudgetTracker({ commandRetryMax: 1 });
    t.recordFailedCommandAttempt('npm test');
    t.recordFailedCommandAttempt('npm test');
    const sig = t.buildRecoverySignal();
    expect(sig).not.toBeNull();
    expect(sig!.source).toBe('branch_budget');
    expect(sig!.consumed).toBe(false);
    expect(sig!.message).toMatch(/Current branch exhausted/);
    expect(sig!.message).toMatch(/Switch strategy/i);
    // 不应包含 "abort" 这种硬停止信号
    expect(sig!.message.toLowerCase()).not.toContain('abort');
  });

  it('markRecoveryTriggered 累加计数', () => {
    const t = new BranchBudgetTracker();
    t.markRecoveryTriggered();
    t.markRecoveryTriggered();
    expect(t.recoverTriggerCount).toBe(2);
  });
});

describe('BranchBudgetTracker - snapshot / 恢复', () => {
  it('snapshot 包含三个维度与 recoverTriggers', () => {
    const t = new BranchBudgetTracker();
    t.recordFileEdit('a.ts');
    t.recordFailedCommandAttempt('ls');
    t.recordError('boom');
    t.markRecoveryTriggered();
    const s = t.snapshot();
    expect(s.fileEdits['a.ts']).toBe(1);
    expect(s.commandRetries['ls']).toBe(1);
    expect(Object.values(s.errorRepeats)[0]).toBe(1);
    expect(s.recoverTriggers).toBe(1);
  });

  it('fromSnapshot 完整还原计数', () => {
    const snap: BranchBudgetSnapshot = {
      fileEdits: { 'x.ts': 2 },
      commandRetries: { 'npm test': 3 },
      errorRepeats: { 'boom': 4 },
      recoverTriggers: 5,
    };
    const t = BranchBudgetTracker.fromSnapshot(snap);
    expect(t.inspect().fileEdits['x.ts']).toBe(2);
    expect(t.inspect().commandRetries['npm test']).toBe(3);
    expect(t.inspect().errorRepeats['boom']).toBe(4);
    expect(t.recoverTriggerCount).toBe(5);
  });

  it('applySnapshot 接受 undefined 时安全重置', () => {
    const t = new BranchBudgetTracker();
    t.recordFileEdit('a.ts');
    t.applySnapshot(undefined);
    expect(t.inspect().fileEdits).toEqual({});
  });

  it('reset 清空所有维度', () => {
    const t = new BranchBudgetTracker();
    t.recordFileEdit('a.ts');
    t.recordFailedCommandAttempt('ls');
    t.recordError('boom');
    t.markRecoveryTriggered();
    t.reset();
    expect(t.inspect()).toEqual({ fileEdits: {}, commandRetries: {}, errorRepeats: {} });
    expect(t.recoverTriggerCount).toBe(0);
  });
});

describe('BranchBudgetTracker - 维度优先级', () => {
  it('file_edit 优先于 command_retry', () => {
    const t = new BranchBudgetTracker({ fileEditMax: 1, commandRetryMax: 1 });
    t.recordFileEdit('a.ts');
    t.recordFileEdit('a.ts');
    t.recordFailedCommandAttempt('ls');
    t.recordFailedCommandAttempt('ls');
    const d = t.shouldBranchRecover();
    expect(d.dimension).toBe('file_edit');
  });

  it('command_retry 优先于 error_repeat', () => {
    const t = new BranchBudgetTracker({ commandRetryMax: 1, errorRepeatMax: 1 });
    t.recordFailedCommandAttempt('ls');
    t.recordFailedCommandAttempt('ls');
    t.recordError('boom');
    t.recordError('boom');
    const d = t.shouldBranchRecover();
    expect(d.dimension).toBe('command_retry');
  });
});

describe('BranchBudgetTracker - verification command reset', () => {
  it('resetCommandRetriesForVerificationCommands clears build/test counters only', () => {
    const t = new BranchBudgetTracker({ commandRetryMax: 2 });
    t.recordFailedCommandAttempt('npm run build 2>&1');
    t.recordFailedCommandAttempt('npm test');
    t.recordFailedCommandAttempt('ls');
    t.grantCommandRetryBypass('npm run build 2>&1');

    t.resetCommandRetriesForVerificationCommands();

    expect(t.inspect().commandRetries).toEqual({ ls: 1 });
    expect(t.wouldBlockCommandRetry('npm run build 2>&1')).toBe(false);
    expect(t.wouldBlockCommandRetry('npm test')).toBe(false);
  });
  it('persists pending write/command bypass paths in snapshot', () => {
    const t = new BranchBudgetTracker({ fileEditMax: 2, commandRetryMax: 2 });
    t.recordFileEdit('src/a.ts');
    t.recordFileEdit('src/a.ts');
    t.recordFailedCommandAttempt('npm test');
    t.recordFailedCommandAttempt('npm test');
    t.grantWriteBypass('src/a.ts');
    t.grantCommandRetryBypass('npm test');

    const snap = t.snapshot();
    expect(snap.writeBypassPaths).toEqual(['src/a.ts']);
    expect(snap.commandRetryBypassKeys).toEqual(['npm test']);

    const restored = BranchBudgetTracker.fromSnapshot(snap);
    expect(restored.wouldBlockFileEdit('src/a.ts')).toBe(false);
    expect(restored.wouldBlockCommandRetry('npm test')).toBe(false);
  });
});

describe('emptyBranchBudgetSnapshot', () => {
  it('返回零初始化的 snapshot', () => {
    expect(emptyBranchBudgetSnapshot()).toEqual({
      fileEdits: {},
      commandRetries: {},
      errorRepeats: {},
      recoverTriggers: 0,
    });
  });
});
