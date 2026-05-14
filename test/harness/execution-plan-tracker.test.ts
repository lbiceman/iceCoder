import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionPlanTracker } from '../../src/harness/execution-plan-tracker.js';
import { buildExecutionPlan } from '../../src/harness/execution-plan-generator.js';
import type { ExecutionPlan, ExecutionPlanEvent } from '../../src/types/execution-plan.js';
import type { TaskStateSnapshot, RepoContextSnapshot } from '../../src/types/runtime-snapshot.js';
import type { ToolCall } from '../../src/llm/types.js';

function makePlan(): ExecutionPlan {
  return buildExecutionPlan({
    goal: '修 bug',
    intent: 'edit',
    now: 1_000,
    planId: 'plan-test',
  })!;
}

function makeTask(overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    goal: '修 bug',
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

function makeRepo(overrides: Partial<RepoContextSnapshot> = {}): RepoContextSnapshot {
  return {
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    testCommands: [],
    recentDiagnostics: [],
    ...overrides,
  };
}

function recordingEmitter() {
  const events: ExecutionPlanEvent[] = [];
  const emit = (e: ExecutionPlanEvent) => events.push(e);
  return { events, emit };
}

describe('ExecutionPlanTracker', () => {
  let now = 2_000;
  beforeEach(() => { now = 2_000; });

  it('构造时立即发出 execution_plan_init', () => {
    const { events, emit } = recordingEmitter();
    new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('execution_plan_init');
  });

  it('emitInit:false 时不发 init', () => {
    const { events, emit } = recordingEmitter();
    new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now, emitInit: false });
    expect(events.length).toBe(0);
  });

  it('phase 顺次推进 → 当前 step running，跳级时把前置 step 自动 done', () => {
    const { events, emit } = recordingEmitter();
    const tracker = new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    events.length = 0;

    // 跳到 editing 阶段（context 应被自动补 done）
    tracker.onPhaseAdvance('editing');

    const updateEvent = events[events.length - 1];
    expect(updateEvent.type).toBe('execution_plan_update');
    const plan = tracker.getPlan();
    expect(plan.steps.find(s => s.phase === 'intent')?.status).toBe('done');
    expect(plan.steps.find(s => s.phase === 'context')?.status).toBe('done');
    expect(plan.steps.find(s => s.phase === 'editing')?.status).toBe('running');
    expect(plan.activeStepId).toBe(plan.steps.find(s => s.phase === 'editing')?.id);
  });

  it('成功 tool_result 把路径写到 active step 的 evidence', () => {
    const { events, emit } = recordingEmitter();
    const tracker = new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    events.length = 0;

    const tc: ToolCall = { id: 't1', name: 'read_file', arguments: { path: 'src/foo.ts' } };
    tracker.onToolResult(
      tc,
      { success: true, output: 'ok' },
      makeTask({ phase: 'context' }),
      makeRepo({ filesRead: ['src/foo.ts'] }),
    );

    const active = tracker.getPlan().steps.find(s => s.id === tracker.getPlan().activeStepId);
    expect(active?.evidence).toBe('src/foo.ts');
  });

  it('同签名连续失败 ≥ 阈值时把当前 step 标记为 failed', () => {
    const { events, emit } = recordingEmitter();
    const tracker = new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    events.length = 0;

    const tc: ToolCall = { id: 't1', name: 'read_file', arguments: { path: 'missing.ts' } };

    // 把 plan 推进到 context（让 active step 存在）
    tracker.onPhaseAdvance('context');
    events.length = 0;

    tracker.onToolResult(tc, { success: false, output: '', error: 'ENOENT' }, makeTask({ phase: 'context' }), makeRepo());
    let plan = tracker.getPlan();
    let ctxStep = plan.steps.find(s => s.phase === 'context')!;
    expect(ctxStep.status).toBe('running');

    tracker.onToolResult(tc, { success: false, output: '', error: 'ENOENT' }, makeTask({ phase: 'context' }), makeRepo());
    plan = tracker.getPlan();
    ctxStep = plan.steps.find(s => s.phase === 'context')!;
    expect(ctxStep.status).toBe('failed');
    expect(ctxStep.error).toContain('ENOENT');
  });

  it('verificationStatus=passed 时把验证 step 推到 done', () => {
    const { events, emit } = recordingEmitter();
    const tracker = new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    events.length = 0;

    const tc: ToolCall = { id: 't2', name: 'run_command', arguments: { command: 'npm test' } };
    tracker.onToolResult(
      tc,
      { success: true, output: 'pass' },
      makeTask({
        phase: 'verification',
        verificationRequired: true,
        verificationStatus: 'passed',
      }),
      makeRepo({ testCommands: ['npm test'] }),
    );

    const v = tracker.getPlan().steps.find(s => s.isVerification);
    expect(v?.status).toBe('done');
  });

  it('onFinal(model_done) 把余下 pending 全部标记 skipped，progress=100', () => {
    const { events, emit } = recordingEmitter();
    const tracker = new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    events.length = 0;

    tracker.onFinal('model_done');

    const plan = tracker.getPlan();
    expect(plan.progress).toBe(100);
    expect(plan.steps.every(s => s.status === 'done' || s.status === 'skipped')).toBe(true);
  });

  it('onFinal(error) 保留 running 状态供下次恢复', () => {
    const { events, emit } = recordingEmitter();
    const tracker = new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    events.length = 0;
    tracker.onPhaseAdvance('editing');
    events.length = 0;

    tracker.onFinal('error');

    const plan = tracker.getPlan();
    expect(plan.steps.find(s => s.phase === 'editing')?.status).toBe('running');
  });

  it('空 patch 不发事件（事件去抖）', () => {
    const { events, emit } = recordingEmitter();
    const tracker = new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    events.length = 0;

    // 重复推进到当前阶段：不应产生 update
    tracker.onPhaseAdvance('intent');
    expect(events.length).toBe(0);
  });

  it('resetPlan 切换到新 plan 且重新发 init', () => {
    const { events, emit } = recordingEmitter();
    const tracker = new ExecutionPlanTracker({ plan: makePlan(), emit, now: () => now });
    events.length = 0;

    const next = buildExecutionPlan({
      goal: '另一任务',
      intent: 'debug',
      now: 3_000,
      planId: 'plan-2',
    })!;
    tracker.resetPlan(next);

    expect(events[0].type).toBe('execution_plan_init');
    expect(tracker.getPlan().planId).toBe('plan-2');
  });
});
