import { describe, it, expect } from 'vitest';
import {
  buildPlanFence,
  parsePersistedPlan,
  serializePersistedPlan,
  ICECODER_PLAN_FENCE_LANG,
} from '../../src/memory/file-memory/execution-plan-fence.js';

/** Phase 11 后 harness plan 生成器已移除；fence 测试用最小合法 plan fixture。 */
function minimalPersistedPlan(planId = 'plan-fence') {
  return {
    version: 1 as const,
    planId,
    goal: '修 bug',
    intent: 'edit',
    steps: [{
      id: 'ctx',
      title: 'Gather context',
      phase: 'context',
      requiresTool: false,
      status: 'pending' as const,
    }],
    progress: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

describe('execution-plan-fence', () => {
  const plan = minimalPersistedPlan();

  it('buildPlanFence 输出以 fence 包裹的 JSON 字符串', () => {
    const fence = buildPlanFence(plan);
    expect(fence.startsWith('```' + ICECODER_PLAN_FENCE_LANG)).toBe(true);
    expect(fence.trim().endsWith('```')).toBe(true);
    expect(fence).toContain(plan.planId);
  });

  it('parse → build round-trip 等价', () => {
    const fence = buildPlanFence(plan);
    const parsed = parsePersistedPlan(fence);
    expect(parsed).not.toBeNull();
    expect(parsed!.planId).toBe(plan.planId);
    expect(parsed!.steps.length).toBe(plan.steps.length);
    expect(parsed!.steps[0].id).toBe(plan.steps[0].id);
  });

  it('版本不匹配 → null', () => {
    const bad = serializePersistedPlan({ ...plan, version: 99 as 1 });
    const wrapped = '```' + ICECODER_PLAN_FENCE_LANG + '\n' + bad + '\n```';
    expect(parsePersistedPlan(wrapped)).toBeNull();
  });

  it('未知 intent → null', () => {
    const evil = JSON.stringify({ ...plan, intent: 'attack' });
    const wrapped = '```' + ICECODER_PLAN_FENCE_LANG + '\n' + evil + '\n```';
    expect(parsePersistedPlan(wrapped)).toBeNull();
  });

  it('多 fence 取最后一个', () => {
    const old = buildPlanFence({ ...plan, planId: 'old' });
    const fresh = buildPlanFence({ ...plan, planId: 'fresh' });
    const notes = `# Notes\n\n${old}\n\nother\n\n${fresh}\n`;
    const parsed = parsePersistedPlan(notes);
    expect(parsed?.planId).toBe('fresh');
  });

  it('无 fence → null（不抛）', () => {
    expect(parsePersistedPlan('# 普通笔记\n没有 fence')).toBeNull();
    expect(parsePersistedPlan('')).toBeNull();
  });

  it('坏 JSON → null（不抛）', () => {
    const wrapped = '```' + ICECODER_PLAN_FENCE_LANG + '\n{not json}\n```';
    expect(parsePersistedPlan(wrapped)).toBeNull();
  });

  it('activeStepId 指向不存在的 step → null', () => {
    const broken = JSON.stringify({ ...plan, activeStepId: 'no-such' });
    const wrapped = '```' + ICECODER_PLAN_FENCE_LANG + '\n' + broken + '\n```';
    expect(parsePersistedPlan(wrapped)).toBeNull();
  });
});
