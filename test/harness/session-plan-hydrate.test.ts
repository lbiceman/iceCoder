import { describe, it, expect } from 'vitest';
import {
  shouldAttachPlanFromSessionNotes,
  userMessageAlignsWithPersistedGoal,
  bigramJaccard,
} from '../../src/harness/session-plan-hydrate.js';

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

  it('bigramJaccard 与 harness 阈值配合：完全相同为 1', () => {
    expect(bigramJaccard('abc', 'abc')).toBe(1);
  });
});
