import { describe, expect, it } from 'vitest';
import type { LLMResponse } from '../../src/llm/types.js';
import {
  OUTPUT_LIMIT_RESUME_PROMPT,
  OUTPUT_LIMIT_SMALL_BATCH_PROMPT,
  decideOutputLimitRecovery,
  resumableOutputLimitText,
} from '../../src/harness/output-limit-recovery.js';

function length(content: string, reasoningContent?: string): LLMResponse {
  return {
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    usage: { inputTokens: 1, outputTokens: 16384, totalTokens: 16385, provider: 'test' },
    finishReason: 'length',
  };
}

describe('decideOutputLimitRecovery', () => {
  it('有正文时先续写，并留下这段正文', () => {
    const decision = decideOutputLimitRecovery(length('先放曲轴。'), 0);
    expect(decision.type).toBe('resume');
    if (decision.type !== 'resume') return;
    expect(decision.prompt).toBe(OUTPUT_LIMIT_RESUME_PROMPT);
    expect(decision.keepAssistant).toBe(true);
    expect(resumableOutputLimitText('先放曲轴。')).toBe('先放曲轴。');
  });

  it('正文再次顶满后改要一小批工具', () => {
    const decision = decideOutputLimitRecovery(length('接着写活塞。'), 1);
    expect(decision).toMatchObject({
      type: 'small_batch',
      prompt: OUTPUT_LIMIT_SMALL_BATCH_PROMPT,
      keepAssistant: true,
    });
  });

  it('没闭合的工具 JSON 不算正文，也不进历史', () => {
    const raw = '{"name":"solid.batch","arguments":{"commands":[';
    expect(resumableOutputLimitText(raw)).toBe('');
    const decision = decideOutputLimitRecovery(length(raw), 0);
    expect(decision).toMatchObject({
      type: 'small_batch',
      keepAssistant: false,
    });
  });

  it('正文后面拖着半截工具调用时，只留下正文', () => {
    const raw = '先放一个气缸。\n{"name":"solid.cylinder","arguments":{"r":';
    expect(resumableOutputLimitText(raw)).toBe('先放一个气缸。');
  });

  it('空回复或只有思考时，两次小批量后停下', () => {
    expect(decideOutputLimitRecovery(length(''), 0).type).toBe('small_batch');
    expect(decideOutputLimitRecovery(length('', 'still thinking'), 1).type).toBe('small_batch');
    const stop = decideOutputLimitRecovery(length(''), 2);
    expect(stop).toEqual({ type: 'stop', content: '' });
  });

  it('有正文的恢复用满 3 次后停下，并留下最后一段正文', () => {
    const stop = decideOutputLimitRecovery(length('最后一段'), 3);
    expect(stop).toEqual({ type: 'stop', content: '最后一段' });
  });
});
