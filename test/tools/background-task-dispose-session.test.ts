/**
 * disposeBackgroundTaskManagerForSession 测试（P1-11）。
 *
 * 会话删除时应能单独清理该会话的后台任务管理器（终止后台进程并移出缓存），
 * 不影响其它会话的管理器。
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getBackgroundTaskManagerFor,
  disposeBackgroundTaskManagerForSession,
  __resetBackgroundTaskManagers,
} from '../../src/tools/background-task-manager.js';

afterEach(() => {
  __resetBackgroundTaskManagers();
});

describe('disposeBackgroundTaskManagerForSession', () => {
  it('disposes only the target session manager and returns true', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-bgdispose-'));
    const a = getBackgroundTaskManagerFor('sess-a', workDir);
    const b = getBackgroundTaskManagerFor('sess-b', workDir);

    expect(disposeBackgroundTaskManagerForSession('sess-a')).toBe(true);

    // 重新获取 sess-a 应得到新实例（旧的已被移除）
    const aAgain = getBackgroundTaskManagerFor('sess-a', workDir);
    expect(aAgain).not.toBe(a);
    // sess-b 实例保持不变
    expect(getBackgroundTaskManagerFor('sess-b', workDir)).toBe(b);
  });

  it('returns false for an unknown session', () => {
    expect(disposeBackgroundTaskManagerForSession('nope')).toBe(false);
  });
});
