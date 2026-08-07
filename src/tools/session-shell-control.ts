/**
 * 统一终止会话 / 全局 shell 工作（前台 + 后台 + 协管 PTY）。
 *
 * detached 后台任务（默认）与 harness 解耦：Stop / switch abort 不杀；
 * copilot 协管 PTY（interactive_shell）同理：Stop Agent / model_done 不杀；
 * delete / clear / shutdown 才杀协管 PTY。
 * Shell 协作模式一经进入即固定，旧 `/shell exit` 不再 kill PTY。
 */

import {
  killAllRunningBackgroundTasksForSession,
  killAllRunningBackgroundTasks,
} from './background-task-manager.js';
import {
  killForegroundShellsForSession,
  killAllForegroundShells,
} from './foreground-shell-registry.js';
import {
  killAllRunningInteractiveShellsForSession,
  killAllRunningInteractiveShells,
  disposeInteractiveShellManagerForSession,
  disposeAllInteractiveShellManagers,
} from './interactive-shell-manager.js';

export interface ShellWorkStopResult {
  foreground: number;
  background: number;
  /** lifespan=copilot 的协管 PTY 终止数 */
  interactiveShell: number;
}

export interface ForegroundShellStopResult {
  foreground: number;
}

/** 用户 Stop / switch abort / turn abort：终止前台 shell；仅杀 lifespan=bound 的后台（detached / copilot PTY 保留）。 */
export function stopForegroundShellWorkForSession(
  sessionId: string,
  reason = 'user stop',
): ForegroundShellStopResult & { background: number } {
  const foreground = killForegroundShellsForSession(sessionId);
  const background = killAllRunningBackgroundTasksForSession(sessionId, { lifespan: 'bound' });
  // copilot 协管 PTY  intentionally 不杀（需求 §9 / T6）
  if (foreground > 0 || background > 0) {
    console.log(
      `[shell-control] session=${sessionId} reason=${reason} `
      + `killed foreground=${foreground} background_bound=${background} `
      + `(detached + copilot PTY preserved)`,
    );
  }
  return { foreground, background };
}

/** 删除 / 清空 session / shutdown：终止该会话全部 shell（前台 + 后台 + 协管 PTY）。 */
export function stopAllShellWorkForSession(
  sessionId: string,
  reason = 'user stop',
): ShellWorkStopResult {
  const foreground = killForegroundShellsForSession(sessionId);
  const background = killAllRunningBackgroundTasksForSession(sessionId);
  const interactiveShell = killAllRunningInteractiveShellsForSession(sessionId);
  disposeInteractiveShellManagerForSession(sessionId);
  if (foreground > 0 || background > 0 || interactiveShell > 0) {
    console.log(
      `[shell-control] session=${sessionId} reason=${reason} `
      + `killed foreground=${foreground} background=${background} interactive_shell=${interactiveShell}`,
    );
  }
  return { foreground, background, interactiveShell };
}

/** 显式终止协管 PTY（删 session / 清空会话等）；不再由旧 `/shell exit` 触发。 */
export function killCopilotInteractiveShellsForSession(
  sessionId: string,
  reason = 'session cleanup',
): number {
  const count = killAllRunningInteractiveShellsForSession(sessionId);
  if (count > 0) {
    console.log(
      `[shell-control] session=${sessionId} reason=${reason} killed interactive_shell=${count}`,
    );
  }
  return count;
}

/** 应用退出：终止全部 shell 子进程（不含 MCP，由 mcpManager.shutdown 处理）。 */
export function stopAllShellWork(reason = 'shutdown'): ShellWorkStopResult {
  const foreground = killAllForegroundShells();
  const background = killAllRunningBackgroundTasks();
  const interactiveShell = killAllRunningInteractiveShells();
  disposeAllInteractiveShellManagers();
  if (foreground > 0 || background > 0 || interactiveShell > 0) {
    console.log(
      `[shell-control] reason=${reason} killed foreground=${foreground} `
      + `background=${background} interactive_shell=${interactiveShell}`,
    );
  }
  return { foreground, background, interactiveShell };
}
