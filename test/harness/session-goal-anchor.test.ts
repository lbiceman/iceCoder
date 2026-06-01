import { describe, expect, it } from 'vitest';

import type { UnifiedMessage } from '../../src/llm/types.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import {
  isFreshQueryMessage,
  syncHydratedTaskState,
} from '../../src/harness/resume-task-state.js';
import { TaskState } from '../../src/harness/task-state.js';
import {
  isPoisonedGoal,
  resolveCheckpointUserGoal,
  resolveSessionGoalAnchor,
} from '../../src/harness/session-goal-anchor.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';

describe('session-goal-anchor', () => {
  it('treats short continuation text as poisoned', () => {
    expect(isPoisonedGoal('江西v')).toBe(true);
    expect(isPoisonedGoal('继续')).toBe(true);
  });

  it('resolveSessionGoalAnchor prefers substantial persisted goal', () => {
    const anchor = resolveSessionGoalAnchor(
      '继续',
      [{ role: 'user', content: 'implement-spellbrigade-survivor: build a Phaser game with npm run build verification and e2e tests covering all scenes' }],
      'implement-spellbrigade-survivor: build a Phaser game with npm run build verification and e2e tests covering all scenes',
    );
    expect(anchor).toMatch(/implement-spellbrigade-survivor/);
  });

  it('treats placeholder checkpoint goals as poisoned', () => {
    expect(isPoisonedGoal('(checkpoint goal unavailable)')).toBe(true);
    expect(isPoisonedGoal('(task goal unavailable)')).toBe(true);
  });

  it('resolveSessionGoalAnchor does not accept placeholder persisted goals', () => {
    const substantial = 'implement-spellbrigade-survivor-second: npm ci, npm run build, npm run test:e2e must exit 0';
    const anchor = resolveSessionGoalAnchor(
      '继续',
      [{ role: 'user', content: substantial }],
      '(checkpoint goal unavailable)',
    );
    expect(anchor).toBe(substantial);
  });

  it('resolveSessionGoalAnchor scans history when persisted goal is poisoned', () => {
    const substantial = 'implement-spellbrigade-survivor-second: complete all scenes, npm ci, npm run build, npm run test:e2e must exit 0';
    const anchor = resolveSessionGoalAnchor(
      '江西v',
      [{ role: 'user', content: substantial }],
      '江西v',
    );
    expect(anchor).toBe(substantial);
  });

  it('resolveCheckpointUserGoal uses sessionGoalAnchor over fallback', () => {
    const taskState = new TaskState('江西v');
    const state = {
      sessionGoalAnchor: 'implement benchmark goal with npm run build verification',
      taskState,
    } as HarnessRunState;
    expect(resolveCheckpointUserGoal(state, '江西v')).toMatch(/implement benchmark goal/);
  });

  it('syncHydratedTaskState rebinds when sessionGoalAnchor is poisoned but history is substantial', () => {
    const substantial = 'implement-spellbrigade-survivor-second: npm ci, npm run build, npm run test:e2e must exit 0';
    const taskState = new TaskState('江西v');
    const repoContext = new RepoContext();
    const messages: UnifiedMessage[] = [
      { role: 'user', content: substantial },
      { role: 'user', content: '继续' },
    ];
    const anchor = syncHydratedTaskState(
      '继续',
      messages,
      taskState,
      repoContext,
      '江西v',
    );
    expect(anchor).toBe(substantial);
    expect(taskState.snapshot().goal).toBe(substantial);
    expect(isPoisonedGoal(taskState.snapshot().goal)).toBe(false);
  });
});

describe('isFreshQueryMessage / sticky-state isolation on topic switch', () => {
  const editGoal =
    'implement-spellbrigade-survivor: build a Phaser game with npm run build verification and e2e tests';

  it('flags an unrelated casual query as fresh', () => {
    expect(isFreshQueryMessage('使用 git diff 分析刚才的变动', editGoal)).toBe(true);
    expect(isFreshQueryMessage('为什么我今天这么困', editGoal)).toBe(true);
  });

  it('does not flag resume continuation as fresh', () => {
    expect(isFreshQueryMessage('继续', editGoal)).toBe(false);
    expect(isFreshQueryMessage('continue', editGoal)).toBe(false);
  });

  it('does not flag follow-up edit requests as fresh', () => {
    expect(isFreshQueryMessage('再实现一下 Boss 关卡', editGoal)).toBe(false);
  });

  it('syncHydratedTaskState drops stale filesChanged on topic switch', () => {
    const taskState = new TaskState(editGoal);
    const repoContext = new RepoContext();
    // 模拟上一轮 hydrate 后的 sticky 状态
    taskState.applySnapshot({
      ...taskState.snapshot(),
      filesChanged: ['src/foo.ts', 'src/bar.ts'],
      verificationRequired: true,
      verificationStatus: 'required',
    });

    const newMsg = '使用 git diff 分析刚才的变动';
    syncHydratedTaskState(newMsg, [], taskState, repoContext, editGoal);

    const snap = taskState.snapshot();
    expect(snap.goal).toBe(newMsg);
    expect(snap.intent === 'question' || snap.intent === 'inspect').toBe(true);
    expect(snap.filesChanged).toEqual([]);
    expect(snap.verificationStatus).toBe('not_required');
    expect(taskState.isVerificationBlockingFinalAfterSync(false)).toBe(false);
  });

  it('syncHydratedTaskState keeps sticky state when resume continuation', () => {
    const taskState = new TaskState(editGoal);
    const repoContext = new RepoContext();
    taskState.applySnapshot({
      ...taskState.snapshot(),
      filesChanged: ['src/foo.ts'],
      verificationRequired: true,
      verificationStatus: 'required',
    });

    syncHydratedTaskState('继续', [], taskState, repoContext, editGoal);

    expect(taskState.snapshot().filesChanged).toContain('src/foo.ts');
    expect(taskState.snapshot().verificationStatus).toBe('required');
  });
});
