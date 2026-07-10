/**
 * 统一终止会话 / 全局 shell 工作（前台 + 后台）。
 */

import {
  killAllRunningBackgroundTasksForSession,
  killAllRunningBackgroundTasks,
} from './background-task-manager.js';
import {
  killForegroundShellsForSession,
  killAllForegroundShells,
} from './foreground-shell-registry.js';

export interface ShellWorkStopResult {
  foreground: number;
  background: number;
}

/** 用户 Stop / 会话切换 abort：终止该会话全部 shell 子进程。 */
export function stopAllShellWorkForSession(
  sessionId: string,
  reason = 'user stop',
): ShellWorkStopResult {
  const foreground = killForegroundShellsForSession(sessionId);
  const background = killAllRunningBackgroundTasksForSession(sessionId);
  if (foreground > 0 || background > 0) {
    console.log(
      `[shell-control] session=${sessionId} reason=${reason} `
      + `killed foreground=${foreground} background=${background}`,
    );
  }
  return { foreground, background };
}

/** 应用退出：终止全部 shell 子进程（不含 MCP，由 mcpManager.shutdown 处理）。 */
export function stopAllShellWork(reason = 'shutdown'): ShellWorkStopResult {
  const foreground = killAllForegroundShells();
  const background = killAllRunningBackgroundTasks();
  if (foreground > 0 || background > 0) {
    console.log(
      `[shell-control] reason=${reason} killed foreground=${foreground} background=${background}`,
    );
  }
  return { foreground, background };
}
