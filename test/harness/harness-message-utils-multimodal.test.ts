import { describe, expect, it } from 'vitest';

import {
  extractUserMessageText,
  getLatestRealUserText,
} from '../../src/harness/harness-message-utils.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('multimodal user message text', () => {
  it('extractUserMessageText 从 ContentBlock 提取文本', () => {
    const text = extractUserMessageText([
      { type: 'text', text: '这是什么' },
      { type: 'image', imageUrl: 'data:image/png;base64,abc' },
    ]);
    expect(text).toBe('这是什么');
  });

  it('getLatestRealUserText 识别多模态 user 消息', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '旧问题' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请分析图片' },
          { type: 'image', imageUrl: 'data:image/png;base64,abc' },
        ],
      },
    ];
    expect(getLatestRealUserText(messages, '')).toBe('请分析图片');
  });
});
