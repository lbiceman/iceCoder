/**
 * 任务切换只看本轮用户原文。失败证据、自检不能把正在做的事判成无关新任务。
 */
import { describe, expect, it } from 'vitest';

import { isSystemInjectedUserContent } from '../../src/harness/harness-message-utils.js';
import {
  buildUnrelatedTaskNotice,
  shouldInjectUnrelatedTaskNotice,
} from '../../src/harness/harness-round-prep.js';

describe('shouldInjectUnrelatedTaskNotice', () => {
  const assistant = '现在用 chrome-devtools MCP 做最后验证。';

  it('续跑短句不注入', () => {
    expect(shouldInjectUnrelatedTaskNotice('继续', assistant)).toBe(false);
  });

  it('失败证据即使和上一条回复毫不相似，也不注入', () => {
    const evidence = '[Failure Evidence — 4 consecutive all-failed rounds]\nAnalyze the evidence below and change strategy.';
    expect(isSystemInjectedUserContent(evidence)).toBe(true);
    expect(shouldInjectUnrelatedTaskNotice(evidence, assistant)).toBe(false);
  });

  it('本轮用户原文和上一条回复几乎无重叠时才注入，并引用原文', () => {
    const user = '你也没写完啊。跟我要的完全不一样！！！重做！';
    expect(shouldInjectUnrelatedTaskNotice(user, assistant)).toBe(true);
    const notice = buildUnrelatedTaskNotice(user);
    expect(notice).toContain(user);
    expect(notice).toContain('Do not invent a different task');
    expect(notice).not.toContain('Completely pause any previous task');
  });

  it('同一话题的后续回复不注入', () => {
    const user = '继续用 chrome-devtools MCP 做最后验证，把菜单和关卡也跑一遍。';
    expect(shouldInjectUnrelatedTaskNotice(user, assistant)).toBe(false);
  });
});
