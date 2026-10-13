import { describe, expect, it } from 'vitest';
import { scheduledTaskLlmSucceeded } from '../../src/session/scheduled-task-events.js';

describe('scheduledTaskLlmSucceeded', () => {
  it('有模型正文就算成功，不管停止原因', () => {
    expect(scheduledTaskLlmSucceeded('model_done', '已完成。')).toBe(true);
    expect(scheduledTaskLlmSucceeded('completion_failed', '已完成。写出了总结文件。')).toBe(true);
    expect(scheduledTaskLlmSucceeded('completion_paused', '先停在这里。')).toBe(true);
    expect(scheduledTaskLlmSucceeded('circuit_breaker', '做到这里。')).toBe(true);
    expect(scheduledTaskLlmSucceeded('max_rounds', '已写出文件。')).toBe(true);
  });

  it('没有正文不算成功，正常收口也不例外', () => {
    expect(scheduledTaskLlmSucceeded('model_done', undefined)).toBe(false);
    expect(scheduledTaskLlmSucceeded('model_done', '  ')).toBe(false);
    expect(scheduledTaskLlmSucceeded('completion_paused', undefined)).toBe(false);
    expect(scheduledTaskLlmSucceeded('completion_failed', '  ')).toBe(false);
    expect(scheduledTaskLlmSucceeded('user_checkpoint', undefined)).toBe(false);
    expect(scheduledTaskLlmSucceeded('timeout', undefined)).toBe(false);
  });

  it('调用出错不算成功，即使带了错误文本', () => {
    expect(scheduledTaskLlmSucceeded('error', 'LLM 调用错误: invalid api key')).toBe(false);
    expect(scheduledTaskLlmSucceeded(undefined, '半截回复')).toBe(false);
  });
});
