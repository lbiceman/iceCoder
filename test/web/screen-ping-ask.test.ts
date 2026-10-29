import { describe, expect, it } from 'vitest';
import type { LLMAdapterInterface, LLMResponse, UnifiedMessage } from '../../src/llm/types.js';
import {
  answerScreenPing,
  buildScreenPingMessages,
  ScreenPingAskError,
} from '../../src/web/screen-ping-ask.js';

function fakeLlm(reply: string, seen: { messages?: UnifiedMessage[] }): LLMAdapterInterface {
  return {
    async chat(messages) {
      seen.messages = messages;
      return {
        content: reply,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, provider: 'test' },
        finishReason: 'stop',
      } satisfies LLMResponse;
    },
    stream() { throw new Error('unused'); },
    countTokens: async () => 0,
  };
}

describe('屏幕问号提问', () => {
  it('把落点锚点和截图一起交给模型', async () => {
    const seen: { messages?: UnifiedMessage[] } = {};
    const result = await answerScreenPing(fakeLlm('这是发送按钮。', seen), {
      image: 'data:image/png;base64,aaaa',
      anchorX: 100,
      anchorY: 80,
      width: 200,
      height: 200,
    });
    expect(result.text).toBe('这是发送按钮。');
    const messages = buildScreenPingMessages({
      imageDataUrl: 'data:image/png;base64,aaaa',
      anchorX: 100,
      anchorY: 80,
      width: 200,
      height: 200,
    });
    expect(seen.messages).toEqual(messages);
    const user = messages[1];
    expect(Array.isArray(user.content) && user.content.some((block) => block.type === 'image')).toBe(true);
    expect(JSON.stringify(user.content)).toContain('(100, 80)');
    expect(JSON.stringify(user.content)).toContain('200×200');
  });

  it('没有截图时直接拒绝', async () => {
    await expect(answerScreenPing(fakeLlm('x', {}), {})).rejects.toBeInstanceOf(ScreenPingAskError);
  });

  it('空回答当成失败', async () => {
    await expect(answerScreenPing(fakeLlm('   ', {}), {
      image: 'data:image/png;base64,aaaa',
    })).rejects.toMatchObject({ status: 502 });
  });
});
