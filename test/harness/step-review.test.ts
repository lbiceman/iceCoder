import { describe, it, expect, vi } from 'vitest';
import { reviewStep, type ReviewToolTrace } from '../../src/harness/step-review.js';
import type { ChatFunction } from '../../src/harness/types.js';
import type { TaskStateSnapshot } from '../../src/types/runtime-snapshot.js';

function trace(toolName: string, signature: string, success: boolean, error?: string): ReviewToolTrace {
  return { toolName, signature, success, error };
}

function snapshot(overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    goal: '修复 bug',
    intent: 'edit',
    phase: 'editing',
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    verificationRequired: false,
    verificationStatus: 'not_required',
    ...overrides,
  };
}

describe('reviewStep — heuristic 重复检测', () => {
  it('同签名连续失败 ≥ 2 次 → repeatedPattern + fallback', async () => {
    const r = await reviewStep({
      goal: '修 bug',
      currentStep: '编辑',
      recentTools: [
        trace('edit_file', 'edit_file:{"path":"a.ts"}', false, 'ENOENT'),
        trace('edit_file', 'edit_file:{"path":"a.ts"}', false, 'ENOENT'),
      ],
      lastErrors: ['ENOENT'],
      trigger: 'tool_failure',
    });
    expect(r.repeatedPattern).toBe(true);
    expect(r.fallbackSuggested).toBe(true);
    expect(r.progressMade).toBe(false);
    expect(r.source).toBe('heuristic');
  });

  it('最近全部失败但签名不同 → 不重复但建议 fallback', async () => {
    const r = await reviewStep({
      goal: '修 bug',
      recentTools: [
        trace('edit_file', 'edit_file:{"path":"a.ts"}', false, 'X'),
        trace('run_command', 'run_command:{"command":"ls"}', false, 'Y'),
      ],
      lastErrors: ['X', 'Y'],
      trigger: 'tool_failure',
    });
    expect(r.repeatedPattern).toBe(false);
    expect(r.fallbackSuggested).toBe(true);
    expect(r.progressMade).toBe(false);
  });
});

describe('reviewStep — heuristic 进展检测', () => {
  it('verification 已通过 → progressMade=true', async () => {
    const r = await reviewStep({
      goal: 'test',
      recentTools: [
        trace('run_command', 'run_command:{"command":"npm test"}', true),
      ],
      lastErrors: [],
      trigger: 'step_transition',
      taskSnapshot: snapshot({
        verificationRequired: true,
        verificationStatus: 'passed',
      }),
    });
    expect(r.progressMade).toBe(true);
    expect(r.fallbackSuggested).toBe(false);
  });

  it('已修改文件且有成功调用 → progressMade=true', async () => {
    const r = await reviewStep({
      goal: 'edit',
      recentTools: [trace('edit_file', 'sig', true)],
      lastErrors: [],
      trigger: 'step_transition',
      taskSnapshot: snapshot({ filesChanged: ['a.ts'] }),
    });
    expect(r.progressMade).toBe(true);
    expect(r.fallbackSuggested).toBe(false);
  });
});

describe('reviewStep — verification_failure 触发', () => {
  it('verification_failure 触发器 → 强制 fallback 建议', async () => {
    const r = await reviewStep({
      goal: 'test',
      recentTools: [
        trace('run_command', 'run_command:{"command":"npm test"}', false, 'failed'),
      ],
      lastErrors: ['failed'],
      trigger: 'verification_failure',
    });
    expect(r.fallbackSuggested).toBe(true);
    expect(r.progressMade).toBe(false);
    expect(r.source).toBe('heuristic');
  });

  it('verification_failure 且≥2条全败时仍为验证专用文案（不被「全部失败」抢先）', async () => {
    const r = await reviewStep({
      goal: 'test',
      recentTools: [
        trace('edit_file', 'edit_file:{"path":"a.ts"}', false, 'X'),
        trace('run_command', 'run_command:{"command":"npm test"}', false, 'Y'),
      ],
      lastErrors: ['X', 'Y'],
      trigger: 'verification_failure',
    });
    expect(r.reason).toContain('验证');
    expect(r.reason).not.toMatch(/工具调用全部失败/);
  });

  it('同轨迹在 tool_failure 下走「全部失败」泛化理由', async () => {
    const r = await reviewStep({
      goal: 'test',
      recentTools: [
        trace('edit_file', 'edit_file:{"path":"a.ts"}', false, 'X'),
        trace('run_command', 'run_command:{"command":"npm test"}', false, 'Y'),
      ],
      lastErrors: ['X', 'Y'],
      trigger: 'tool_failure',
    });
    expect(r.reason).toMatch(/全部失败|检查环境/);
  });
});

describe('reviewStep — 验证失败后不高估进展', () => {
  it('verificationStatus=failed 时不走「改过文件即有进展」确信分支', async () => {
    const r = await reviewStep({
      goal: 'edit',
      recentTools: [trace('edit_file', 'edit_file:{}', true)],
      lastErrors: [],
      trigger: 'tool_failure',
      taskSnapshot: snapshot({
        filesChanged: ['a.ts'],
        verificationRequired: true,
        verificationStatus: 'failed',
      }),
    });
    expect(r.progressMade).toBe(false);  });

  it('verificationStatus=failed 且成败混合时不标 progressMade', async () => {
    const r = await reviewStep({
      goal: 'edit',
      recentTools: [
        trace('edit_file', 'e', true),
        trace('run_command', 'npm test', false),
      ],
      lastErrors: ['fail'],
      trigger: 'tool_failure',
      taskSnapshot: snapshot({
        filesChanged: ['a.ts'],
        verificationRequired: true,
        verificationStatus: 'failed',
      }),
    });
    expect(r.progressMade).toBe(false);
    expect(r.reason).toContain('验证未通过');
  });
});

describe('reviewStep — LLM fallback', () => {
  it('启发式给出确定结论时不调用 LLM', async () => {
    const chatFn = vi.fn() as unknown as ChatFunction;
    await reviewStep({
      goal: '修 bug',
      recentTools: [
        trace('edit_file', 'edit_file:{"path":"a.ts"}', false),
        trace('edit_file', 'edit_file:{"path":"a.ts"}', false),
      ],
      lastErrors: [],
      trigger: 'tool_failure',
    }, chatFn);
    expect((chatFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('启发式无定论且有 chatFn 时调用 LLM 一次', async () => {
    const chatFn = vi.fn().mockResolvedValue({
      content: '{"progressMade":false,"repeatedPattern":false,"fallbackSuggested":true,"reason":"need fallback"}',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'test' },
      finishReason: 'stop',
    });
    const r = await reviewStep({
      goal: 'unknown',
      recentTools: [],
      lastErrors: [],
      trigger: 'step_transition',
    }, chatFn as unknown as ChatFunction);
    expect((chatFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(r.source).toBe('llm');
    expect(r.fallbackSuggested).toBe(true);
    expect(r.reason).toBe('need fallback');
  });

  it('LLM 返回非法 JSON 时优雅降级到启发式', async () => {
    const chatFn = vi.fn().mockResolvedValue({
      content: 'I do not know, sorry.',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'test' },
      finishReason: 'stop',
    });
    const r = await reviewStep({
      goal: 'unknown',
      recentTools: [],
      lastErrors: [],
      trigger: 'step_transition',
    }, chatFn as unknown as ChatFunction);
    expect(r.source).toBe('heuristic');
  });

  it('LLM 抛错时不冒泡，降级到启发式', async () => {
    const chatFn = vi.fn().mockRejectedValue(new Error('llm down'));
    const r = await reviewStep({
      goal: 'unknown',
      recentTools: [],
      lastErrors: [],
      trigger: 'step_transition',
    }, chatFn as unknown as ChatFunction);
    expect(r.source).toBe('heuristic');
  });

  it('LLM 返回 markdown 包裹的 JSON 仍可解析', async () => {
    const chatFn = vi.fn().mockResolvedValue({
      content: '```json\n{"progressMade":true,"repeatedPattern":false,"fallbackSuggested":false,"reason":"ok"}\n```',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'test' },
      finishReason: 'stop',
    });
    const r = await reviewStep({
      goal: 'unknown',
      recentTools: [],
      lastErrors: [],
      trigger: 'step_transition',
    }, chatFn as unknown as ChatFunction);
    expect(r.source).toBe('llm');
    expect(r.progressMade).toBe(true);
  });
});

describe('reviewStep — bounded 上下文', () => {
  it('recentTools 超过 5 条被裁剪后仍能给出结论', async () => {
    const many: ReviewToolTrace[] = [];
    for (let i = 0; i < 20; i++) {
      many.push(trace('edit_file', `edit_file:{"path":"a${i}.ts"}`, false));
    }
    const r = await reviewStep({
      goal: 'edit',
      recentTools: many,
      lastErrors: Array(20).fill('boom'),
      trigger: 'tool_failure',
    });
    // 不抛、结果合法
    expect(typeof r.progressMade).toBe('boolean');
    expect(typeof r.fallbackSuggested).toBe('boolean');
  });
});
