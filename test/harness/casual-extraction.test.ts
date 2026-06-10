import { describe, it, expect } from 'vitest';
import { evaluateCasualMemoryExtraction } from '../../src/harness/casual-mode.js';
import { DEFAULT_CASUAL_EXTRACTION_CONFIG } from '../../src/memory/file-memory/memory-config.js';

const base = {
  turnCount: 5,
  hasSignalWord: false,
  hasContentSignal: false,
  sessionHasToolCalls: false,
  extractionTurnCounter: 1,
  turnThrottle: 1,
  config: { ...DEFAULT_CASUAL_EXTRACTION_CONFIG },
};

describe('evaluateCasualMemoryExtraction', () => {
  it('信号词立即通过', () => {
    expect(evaluateCasualMemoryExtraction({ ...base, hasSignalWord: true })).toBe(true);
  });

  it('无工具且轮次够时默认不提取（深度路径）', () => {
    expect(evaluateCasualMemoryExtraction(base)).toBe(false);
  });

  it('有工具且轮次够时提取', () => {
    expect(
      evaluateCasualMemoryExtraction({ ...base, sessionHasToolCalls: true }),
    ).toBe(true);
  });

  it('技术内容特征在无工具时不再触发（allowContentSignalWithoutTools=false）', () => {
    expect(
      evaluateCasualMemoryExtraction({
        ...base,
        turnCount: 1,
        hasContentSignal: true,
      }),
    ).toBe(false);
  });
});
