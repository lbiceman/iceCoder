import { describe, it, expect, afterEach } from 'vitest';
import { isExecutionPlanEnabled } from '../../src/harness/execution-plan-config.js';

const KEY = 'ICE_ENABLE_EXECUTION_PLAN';

describe('isExecutionPlanEnabled', () => {
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  });

  it('未设置时关闭', () => {
    delete process.env[KEY];
    expect(isExecutionPlanEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'TRUE', 'yes', ' YES '])('启用值：%s', (v) => {
    process.env[KEY] = v;
    expect(isExecutionPlanEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'no', ''])('关闭值：%s', (v) => {
    process.env[KEY] = v;
    expect(isExecutionPlanEnabled()).toBe(false);
  });
});
