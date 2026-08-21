import { describe, it, expect } from 'vitest';
import { consumeSseJsonRpc } from '../../src/mcp/mcp-streamable-http.js';

describe('consumeSseJsonRpc', () => {
  it('解析完整 SSE data 事件', () => {
    const raw = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '',
      '',
    ].join('\n');
    const { messages, rest } = consumeSseJsonRpc(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(1);
    expect(messages[0].result).toEqual({ ok: true });
    expect(rest).toBe('');
  });

  it('保留未结束的尾部', () => {
    const { messages, rest } = consumeSseJsonRpc('data: {"jsonrpc":"2.0","id":2');
    expect(messages).toEqual([]);
    expect(rest).toContain('id":2');
  });

  it('忽略 [DONE]', () => {
    const { messages } = consumeSseJsonRpc('data: [DONE]\n\n');
    expect(messages).toEqual([]);
  });
});
