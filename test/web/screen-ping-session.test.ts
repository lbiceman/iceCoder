import { describe, expect, it } from 'vitest';
import { chooseScreenPingSession, SCREEN_PING_SESSION_TITLE } from '../../src/web/screen-ping-session.js';

describe('屏幕问号写入哪个会话', () => {
  const sessions = [
    { id: 'task-1', title: '定时任务：日报', scheduledTaskId: 't1' },
    { id: 'chat-1', title: '改样式', scheduledTaskId: undefined },
    { id: 'ping-1', title: SCREEN_PING_SESSION_TITLE },
  ];

  it('不论当前选中哪一个，都写进已有的屏幕问号会话', () => {
    expect(chooseScreenPingSession(sessions)).toEqual({ id: 'ping-1' });
  });

  it('还没有屏幕问号会话时新建', () => {
    expect(chooseScreenPingSession([sessions[0], sessions[1]])).toEqual({ create: true });
  });
});
