import { describe, expect, it } from 'vitest';
import {
  isOpenLegacyCommand,
  isSessionImageApiUrl,
  parseClientMessageId,
  stripReferencePathLinesForWorkspaceLock,
} from '../../src/web/chat-ws-helpers.js';

describe('chat-ws-helpers', () => {
  it('parseClientMessageId 只接受 UUID', () => {
    expect(parseClientMessageId('not-a-uuid')).toBeNull();
    expect(parseClientMessageId(1)).toBeNull();
    expect(parseClientMessageId('  550e8400-e29b-41d4-a716-446655440000  '))
      .toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('isSessionImageApiUrl 识别会话图片 API', () => {
    expect(isSessionImageApiUrl('/api/sessions/abc/images/x.png')).toBe(true);
    expect(isSessionImageApiUrl('https://example.com/x.png')).toBe(false);
  });

  it('isOpenLegacyCommand 识别 ~open', () => {
    expect(isOpenLegacyCommand('~open')).toBe(true);
    expect(isOpenLegacyCommand('~open D:\\work')).toBe(true);
    expect(isOpenLegacyCommand('~open\nD:\\')).toBe(true);
    expect(isOpenLegacyCommand('open')).toBe(false);
  });

  it('stripReferencePathLinesForWorkspaceLock 去掉独立路径行', () => {
    const text = '请看这个文件\nD:\\work\\a.ts\n谢谢';
    expect(stripReferencePathLinesForWorkspaceLock(text, ['D:/work/a.ts']))
      .toBe('请看这个文件\n谢谢');
  });
});
