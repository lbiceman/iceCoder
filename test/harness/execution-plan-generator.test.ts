import { describe, it, expect } from 'vitest';
import { buildExecutionPlan, calcProgress } from '../../src/harness/execution-plan-generator.js';
import type { TaskStateSnapshot } from '../../src/types/runtime-snapshot.js';

function emptySnapshot(overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    goal: '实现 X',
    intent: 'edit',
    phase: 'intent',
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    verificationRequired: false,
    verificationStatus: 'not_required',
    ...overrides,
  };
}

describe('buildExecutionPlan', () => {
  it('edit 意图返回至少含 context / editing / verification 三类 step', () => {
    const plan = buildExecutionPlan({
      goal: '实现登录功能',
      intent: 'edit',
      now: 1_000,
      planId: 'plan-1',
    });
    expect(plan).not.toBeNull();
    const phases = plan!.steps.map(s => s.phase);
    expect(phases).toContain('context');
    expect(phases).toContain('editing');
    expect(phases).toContain('verification');
    const verification = plan!.steps.find(s => s.isVerification);
    expect(verification?.suggestedTools).toEqual(['run_command']);
  });

  it('question 意图不生成 plan（返回 null）', () => {
    const plan = buildExecutionPlan({ goal: '什么是 Harness', intent: 'question' });
    expect(plan).toBeNull();
  });

  it('空 goal 返回 null', () => {
    expect(buildExecutionPlan({ goal: '   ', intent: 'edit' })).toBeNull();
  });

  it('依据 taskSnapshot.phase 推进初始 status，editing 之前的 step 为 done', () => {
    const plan = buildExecutionPlan({
      goal: '修 bug',
      intent: 'edit',
      taskSnapshot: emptySnapshot({ phase: 'editing' }),
    });
    expect(plan).not.toBeNull();
    const ctxStep = plan!.steps.find(s => s.phase === 'context');
    const editStep = plan!.steps.find(s => s.phase === 'editing');
    expect(ctxStep?.status).toBe('done');
    expect(editStep?.status).toBe('running');
    expect(plan!.activeStepId).toBe(editStep?.id);
  });

  it('verificationStatus=passed 时验证 step 初始为 done', () => {
    const plan = buildExecutionPlan({
      goal: '修 bug',
      intent: 'edit',
      taskSnapshot: emptySnapshot({
        phase: 'verification',
        verificationRequired: true,
        verificationStatus: 'passed',
      }),
    });
    const v = plan!.steps.find(s => s.isVerification);
    expect(v?.status).toBe('done');
  });

  it('progress 公式：done / 总步数', () => {
    const plan = buildExecutionPlan({
      goal: '修 bug',
      intent: 'edit',
      taskSnapshot: emptySnapshot({ phase: 'verification' }),
    });
    // verification 阶段：intent / context / editing → done（3 个），verification → running（1）
    // final → pending（1）；5 步 → 60%
    expect(plan!.progress).toBe(60);
  });

  it('calcProgress 直接计算 step 数组', () => {
    expect(calcProgress([])).toBe(0);
    expect(
      calcProgress([
        { id: 'a', title: 'a', phase: 'intent', requiresTool: false, status: 'done' },
        { id: 'b', title: 'b', phase: 'context', requiresTool: false, status: 'pending' },
      ]),
    ).toBe(50);
  });
});
