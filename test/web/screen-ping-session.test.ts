import { describe, expect, it } from 'vitest';
import { chooseScreenPingSession, SCREEN_PING_SESSION_TITLE } from '../../src/web/screen-ping-session.js';

describe('屏幕问号写入哪个会话', () => {
  const sessions = [
    { id: 'task-1', title: '定时任务：日报', scheduledTaskId: 't1' },
    { id: 'chat-1', title: '改样式', scheduledTaskId: undefined },
    { id: 'ping-1', title: SCREEN_PING_SESSION_TITLE },
  ];

  it('当前是普通会话时写进当前会话', () => {
    expect(chooseScreenPingSession(sessions, 'chat-1')).toEqual({ id: 'chat-1' });
  });

  it('当前是任务会话时改去已有的屏幕问号会话', () => {
    expect(chooseScreenPingSession(sessions, 'task-1')).toEqual({ id: 'ping-1' });
  });

  it('没有普通会话可写时新建', () => {
    expect(chooseScreenPingSession([sessions[0]], 'task-1')).toEqual({ create: true });
  });
});