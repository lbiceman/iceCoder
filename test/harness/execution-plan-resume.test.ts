import { describe, it, expect } from 'vitest';
import { TaskCheckpointManager, type TaskCheckpoint } from '../../src/harness/checkpoint.js';
import { buildExecutionPlan } from '../../src/harness/execution-plan-generator.js';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

describe('TaskCheckpointManager + ExecutionPlan', () => {
  it('save 时把 plan 一并落盘；buildResumeMessage 含 Plan Recovery 行', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'icetest-plan-'));
    try {
      const mgr = new TaskCheckpointManager(dir, 'sess1');
      const plan = buildExecutionPlan({
        goal: '修复登录',
        intent: 'edit',
        now: 1_000,
        planId: 'plan-resume',
      })!;
      // 模拟已进入 editing 阶段：把第二个 step 设为 running
      const editing = plan.steps.find(s => s.phase === 'editing')!;
      editing.status = 'running';
      plan.activeStepId = editing.id;

      const saved = await mgr.save({
        status: 'running',
        userGoal: '修复登录',
        taskState: {
          goal: '修复登录',
          intent: 'edit',
          phase: 'editing',
          filesRead: [],
          filesChanged: [],
          commandsRun: [],
          verificationRequired: false,
          verificationStatus: 'not_required',
        },
        repoContext: {
          filesRead: [],
          filesChanged: [],
          commandsRun: [],
          testCommands: [],
          recentDiagnostics: [],
        },
        loopState: {
          currentRound: 1,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          lastInputTokens: 0,
          lastOutputTokens: 0,
          totalToolCalls: 0,
          startTime: Date.now(),
        },
        messages: [],
        plan,
      });
      expect(saved.plan?.planId).toBe('plan-resume');

      const loaded = await mgr.loadActive();
      expect(loaded?.plan?.planId).toBe('plan-resume');

      const msg = mgr.buildResumeMessage(loaded as TaskCheckpoint);
      const text = typeof msg.content === 'string' ? msg.content : '';
      expect(text).toContain('Plan Recovery');
      expect(text).toContain(editing.title);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未带 plan 的 checkpoint，buildResumeMessage 不包含 Plan Recovery（向后兼容）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'icetest-plan-'));
    try {
      const mgr = new TaskCheckpointManager(dir, 'sess2');
      await mgr.save({
        status: 'running',
        userGoal: '随便',
        taskState: {
          goal: '随便',
          intent: 'inspect',
          phase: 'context',
          filesRead: [],
          filesChanged: [],
          commandsRun: [],
          verificationRequired: false,
          verificationStatus: 'not_required',
        },
        repoContext: {
          filesRead: [],
          filesChanged: [],
          commandsRun: [],
          testCommands: [],
          recentDiagnostics: [],
        },
        loopState: {
          currentRound: 1,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          lastInputTokens: 0,
          lastOutputTokens: 0,
          totalToolCalls: 0,
          startTime: Date.now(),
        },
        messages: [],
      });
      const loaded = await mgr.loadActive();
      const msg = mgr.buildResumeMessage(loaded as TaskCheckpoint);
      const text = typeof msg.content === 'string' ? msg.content : '';
      expect(text).not.toContain('Plan Recovery');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
