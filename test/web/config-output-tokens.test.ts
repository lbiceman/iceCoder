import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  getModelMaxOutputTokens,
} from '../../src/web/routes/config.js';

describe('getModelMaxOutputTokens', () => {
  it('未知模型使用 Agent 默认输出上限', () => {
    expect(getModelMaxOutputTokens('MiniMax-M2.7')).toBe(DEFAULT_AGENT_MAX_OUTPUT_TOKENS);
    expect(getModelMaxOutputTokens('some-new-model')).toBe(8192);
  });

  it('已知老模型仍保留保守上限', () => {
    expect(getModelMaxOutputTokens('gpt-3.5-turbo')).toBe(4096);
    expect(getModelMaxOutputTokens('gpt-4o')).toBe(16384);
  });
});
