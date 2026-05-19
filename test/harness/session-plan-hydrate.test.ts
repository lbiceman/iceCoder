import { describe, it, expect } from 'vitest';
import {
  shouldAttachPlanFromSessionNotes,
  shouldAttachPersistedExecutionPlan,
  shouldRefreshTerminalInspectPlan,
  userMessageAlignsWithPersistedGoal,
  bigramJaccard,
} from '../../src/harness/session-plan-hydrate.js';
import type { TaskStateSnapshot } from '../../src/types/runtime-snapshot.js';

describe('session-plan-hydrate', () => {
  it('已 100% 的笔记 plan 不恢复', () => {
    expect(
      shouldAttachPlanFromSessionNotes(
        { goal: '查一下某文件', progress: 100 },
        '实现新功能 xxx',
      ),
    ).toBe(false);
  });

  it('进度未满且 goal 与用户输入一致时恢复', () => {
    expect(
      shouldAttachPlanFromSessionNotes(
        { goal: '修复登录 bug', progress: 40 },
        '修复登录 bug',
      ),
    ).toBe(true);
  });

  it('续跑短指令视为同一任务链', () => {
    expect(userMessageAlignsWithPersistedGoal('任意旧 goal', '继续')).toBe(true);
    expect(userMessageAlignsWithPersistedGoal('任意旧 goal', 'Continue')).toBe(true);
  });

  it('明显新任务与旧 goal 不合并', () => {
    expect(
      shouldAttachPlanFromSessionNotes(
        { goal: '只读查阅项目结构', progress: 50 },
        '在 src/foo.ts 里实现新的 ETL 校验函数并跑 vitest',
      ),
    ).toBe(false);
  });

  it('checkpoint userGoal 与 plan.goal 均可作为对齐依据', () => {
    expect(
      shouldAttachPersistedExecutionPlan(
        { goal: '从笔记拆出的短摘要', progress: 30 },
        '完整用户原话很长包含实现与测试',
        ['完整用户原话很长包含实现与测试'],
      ),
    ).toBe(true);
  });

  it('inspect 已 100% 且快照已进入 editing 时应刷新为多段任务的下一套计划', () => {
    const snap = {
      goal: 'x',
      intent: 'inspect' as const,
      phase: 'editing' as const,
      filesRead: [],
      filesChanged: ['a.ts'],
      commandsRun: [],
      verificationRequired: false,
      verificationStatus: 'not_required' as const,
    } satisfies TaskStateSnapshot;
    expect(
      shouldRefreshTerminalInspectPlan(
        { intent: 'inspect', progress: 100 },
        snap,
        '先只读后实现',
      ),
    ).toBe(true);
  });

  it('inspect 已 100% 且用户原文含实现类动词时也应刷新（尚在列目录阶段）', () => {
    const snap = {
      goal: 'x',
      intent: 'inspect' as const,
      phase: 'context' as const,
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
      verificationRequired: false,
      verificationStatus: 'not_required' as const,
    } satisfies TaskStateSnapshot;
    expect(
      shouldRefreshTerminalInspectPlan(
        { intent: 'inspect', progress: 100 },
        snap,
        'A1 只读；接着在 src 下创建文档文件 foo.md',
      ),
    ).toBe(true);
  });

  it('bigramJaccard 与 harness 阈值配合：完全相同为 1', () => {
    expect(bigramJaccard('abc', 'abc')).toBe(1);
  });
});
