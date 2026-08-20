import { describe, expect, it } from 'vitest';
import {
  resolveTaskDoneNotification,
  SUMMARY_MAX_CHARS,
} from '../../desktop/src/task-done-notify.js';

const APP = 'iceCoder';

function win(focused: boolean, destroyed = false) {
  return { isDestroyed: () => destroyed, isFocused: () => focused };
}

describe('resolveTaskDoneNotification（主进程通知决策）', () => {
  it('非法载荷（null / 非对象）→ skip', () => {
    expect(resolveTaskDoneNotification(null, null, APP).skip).toBe(true);
    expect(resolveTaskDoneNotification(42, null, APP).skip).toBe(true);
  });

  it('成功 + 后台 → 标题/正文正确', () => {
    const d = resolveTaskDoneNotification(
      { success: true, summary: '写脚本' },
      win(false),
      APP,
    );
    expect(d.skip).toBe(false);
    expect(d.title).toBe('iceCoder 任务完成');
    expect(d.body).toBe('用户任务【写脚本】已完成。请确认。');
  });

  it('成功 + 无摘要 → 默认正文', () => {
    const d = resolveTaskDoneNotification({ success: true }, win(false), APP);
    expect(d.body).toBe('用户任务已完成。请确认。');
  });

  it('成功 + 超长摘要 → 30 字防御性截断', () => {
    const long = '这是一段非常长的用户提示词，超过了三十个字符的限制，需要被截断显示省略号';
    const d = resolveTaskDoneNotification({ success: true, summary: long }, win(false), APP);
    expect(d.summary.length).toBe(SUMMARY_MAX_CHARS + 1);
    expect(d.summary.endsWith('…')).toBe(true);
  });

  it('失败分支 → 任务失败标题与正文', () => {
    const d = resolveTaskDoneNotification({ success: false, summary: '' }, win(false), APP);
    expect(d.title).toBe('iceCoder 任务失败');
    expect(d.body).toBe('任务执行出错');
  });

  it('主窗在前台 → skip（R10）', () => {
    const d = resolveTaskDoneNotification({ success: true, summary: 'x' }, win(true), APP);
    expect(d.skip).toBe(true);
  });

  it('主窗最小化（非前台）→ 仍通知（R10 仅防前台打扰）', () => {
    const d = resolveTaskDoneNotification({ success: true, summary: 'x' }, win(false), APP);
    expect(d.skip).toBe(false);
  });

  it('主窗已销毁或不存在 → 仍通知', () => {
    expect(resolveTaskDoneNotification({ success: true, summary: 'x' }, win(false, true), APP).skip).toBe(false);
    expect(resolveTaskDoneNotification({ success: true, summary: 'x' }, null, APP).skip).toBe(false);
  });

  it('透传 sessionId 供点击通知后切会话', () => {
    const d = resolveTaskDoneNotification(
      { success: true, summary: '写脚本', sessionId: 'sess-a' },
      win(false),
      APP,
    );
    expect(d.skip).toBe(false);
    expect(d.sessionId).toBe('sess-a');
  });
});
