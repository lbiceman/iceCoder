/**
 * 记忆层「最近用户话」判定 — 须跳过压缩/恢复注入，避免召回 query 跑偏。
 */

import { describe, it, expect } from 'vitest';
import { isEligibleLatestUserMessageContent } from '../../src/harness/harness-memory.js';

describe('isEligibleLatestUserMessageContent', () => {
  it('拒绝摘要、记忆 reminder、压缩锚点与恢复块', () => {
    expect(isEligibleLatestUserMessageContent('<context-summary>\nx\n</context-summary>')).toBe(false);
    expect(isEligibleLatestUserMessageContent('<system-reminder>\nRecalled\n</system-reminder>')).toBe(false);
    expect(isEligibleLatestUserMessageContent('<compact_boundary>\nmeta\n</compact_boundary>')).toBe(false);
    expect(isEligibleLatestUserMessageContent('<recent-dialogue-focus>\nx\n</recent-dialogue-focus>')).toBe(false);
    expect(isEligibleLatestUserMessageContent('<runtime-recovery-context>\n{}\n</runtime-recovery-context>')).toBe(false);
    expect(isEligibleLatestUserMessageContent('<recent-file-contents>\n### a.ts\n</recent-file-contents>')).toBe(false);
    expect(isEligibleLatestUserMessageContent('<system-context>\nx')).toBe(false);
    expect(isEligibleLatestUserMessageContent('<session-notes>\nx')).toBe(false);
    expect(isEligibleLatestUserMessageContent('[System notice]')).toBe(false);
  });

  it('接受真实用户句', () => {
    expect(isEligibleLatestUserMessageContent('修一下登录 bug')).toBe(true);
    expect(isEligibleLatestUserMessageContent(' 继续跑测试 ')).toBe(true);
  });
});
