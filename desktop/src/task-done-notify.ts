/**
 * task-done-notify.ts — 任务完成通知的纯决策逻辑（无 Electron 运行时依赖，可单测）。
 *
 * 渲染层（chat-pet-bridge.maybeNotifyTaskDone）仅在配置开启、且主窗不处于前台时，
 * 通过 IPC 上报 { success, summary }；主进程据此构造系统通知。
 */

export interface TaskDoneNotifyPayload {
  success?: unknown;
  summary?: unknown;
  sessionId?: unknown;
}

/** 主窗口状态的最小接口（main.ts 的 BrowserWindow 满足）。 */
export interface MainWindowLike {
  isDestroyed(): boolean;
  isFocused(): boolean;
}

/**
 * 摘要最长字符数。渲染层 summarizeUserPrompt() 已按 30 字截断，
 * 此处为防御性兜底截断（正常路径幂等），防止其他调用方传入超长摘要。
 */
export const SUMMARY_MAX_CHARS = 30;

export interface TaskDoneNotifyDecision {
  /** true 表示不弹通知（非法载荷 / R10 主窗在前台）。 */
  skip: boolean;
  title: string;
  body: string;
  summary: string;
  sessionId?: string;
}

export function resolveTaskDoneNotification(
  payload: unknown,
  mainWindow: MainWindowLike | null,
  appName: string,
): TaskDoneNotifyDecision {
  if (!payload || typeof payload !== 'object') {
    return { skip: true, title: '', body: '', summary: '' };
  }
  const p = payload as TaskDoneNotifyPayload;
  const success = p.success === true;
  const rawSummary = typeof p.summary === 'string' ? p.summary : '';
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
  const summary =
    rawSummary.length > SUMMARY_MAX_CHARS
      ? `${rawSummary.slice(0, SUMMARY_MAX_CHARS)}…`
      : rawSummary;

  // R10：仅后台弹通知——主窗在前台时不打扰；最小化/隐藏属于后台，仍会通知
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
    return { skip: true, title: '', body: '', summary, ...(sessionId ? { sessionId } : {}) };
  }

  const title = success ? `${appName} 任务完成` : `${appName} 任务失败`;
  const body = success
    ? summary
      ? `用户任务【${summary}】已完成。请确认。`
      : '用户任务已完成。请确认。'
    : summary || '任务执行出错';
  return { skip: false, title, body, summary, ...(sessionId ? { sessionId } : {}) };
}
