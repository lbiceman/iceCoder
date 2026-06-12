import { describe, expect, it } from 'vitest';

import {
  getLatestRealUserText,
  hasAssistantToolCallAfterLatestRealUser,
  isActionableToolRequest,
} from '../../src/harness/harness-message-utils.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('resume no-tool recovery prerequisites', () => {
  const existingMessages: UnifiedMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '之前的问题' },
    { role: 'assistant', content: '之前已经调用过工具', toolCalls: [{ id: 'old', name: 'run_command', arguments: {} }] },
    { role: 'tool', content: 'ok', toolCallId: 'old' },
    { role: 'assistant', content: '之前完成' },
    { role: 'user', content: '运行测试' },
  ];

  it('latest user is 运行测试 and no assistant tools after it', () => {
    expect(getLatestRealUserText(existingMessages, '')).toBe('运行测试');
    expect(hasAssistantToolCallAfterLatestRealUser(existingMessages)).toBe(false);
    expect(isActionableToolRequest('运行测试')).toBe(true);
  });
});
