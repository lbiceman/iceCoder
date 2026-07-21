/**
 * 统一终止会话 / 全局 shell 工作（前台 + 后台）。
 *
 * detached 后台任务（默认）与 harness 解耦：Stop / switch abort 不杀；
 * delete / clear / shutdown 仍杀全部。
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

export interface ForegroundShellStopResult {
  foreground: number;
}

/** 用户 Stop / switch abort / turn abort：终止前台 shell；仅杀 lifespan=bound 的后台（detached 保留）。 */
export function stopForegroundShellWorkForSession(
  sessionId: string,
  reason = 'user stop',
): ForegroundShellStopResult & { background: number } {
  const foreground = killForegroundShellsForSession(sessionId);
  const background = killAllRunningBackgroundTasksForSession(sessionId, { lifespan: 'bound' });
  if (foreground > 0 || background > 0) {
    console.log(
      `[shell-control] session=${sessionId} reason=${reason} `
      + `killed foreground=${foreground} background_bound=${background} (detached preserved)`,
    );
  }
  return { foreground, background };
}

/** 删除 / 清空 session / shutdown：终止该会话全部 shell（前台 + 后台）。 */
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
