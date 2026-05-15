import { describe, it, expect, afterEach } from 'vitest';
import { isExecutionPlanEnabled } from '../../src/harness/execution-plan-config.js';

/** Legacy env name; implementation no longer reads it — kept only to prove it does not flip the flag */
const LEGACY_KEY = 'ICE_ENABLE_EXECUTION_PLAN';

describe('isExecutionPlanEnabled', () => {
  const original = process.env[LEGACY_KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[LEGACY_KEY];
    } else {
      process.env[LEGACY_KEY] = original;
    }
  });

  it('在当前实现中为恒 true（不再读取环境变量）', () => {
    delete process.env[LEGACY_KEY];
    expect(isExecutionPlanEnabled()).toBe(true);
  });

  it('即使设置旧版 ICE_ENABLE_EXECUTION_PLAN 关闭语义值也不影响结果', () => {
    process.env[LEGACY_KEY] = '0';
    expect(isExecutionPlanEnabled()).toBe(true);
  });
});
