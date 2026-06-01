export type ToolTraceStatus = 'pending' | 'success' | 'error' | 'warn' | 'background';

/** 与 shell-runtime-classifier LONG_RUNNING 保持语义一致（浏览器侧轻量副本） */
const LONG_RUNNING_COMMAND: RegExp[] = [
  /^(npm|pnpm|yarn|bun)\s+(test|t\b|run\s+(test|dev|start|serve|preview|watch|build))/,
  /^(vitest|jest|playwright|cypress)\b(?!\s+--?(version|help))/,
  /^tsc\s+(--watch|-w)\b/,
  /^docker\s+(build|run|compose\s+up)\b/,
  /^(pip|poetry|conda)\s+install\b/,
  /^git\s+clone\b/,
  /^curl\s+.*-[oO]\s/,
];

function extractRunCommandText(toolArgs: Record<string, unknown> | undefined): string {
  if (!toolArgs || typeof toolArgs !== 'object') return '';
  const command = typeof toolArgs.command === 'string'
    ? toolArgs.command.trim()
    : typeof toolArgs.cmd === 'string'
      ? toolArgs.cmd.trim()
      : '';
  return command;
}

function isBackgroundManagementAction(toolArgs: Record<string, unknown> | undefined): boolean {
  if (!toolArgs || typeof toolArgs !== 'object') return false;
  const action = typeof toolArgs.action === 'string' ? toolArgs.action.trim() : '';
  return action === 'check' || action === 'stop' || action === 'list';
}

/** tool_call 阶段预判：长命令 / 显式 background 直接显示 →，避免先闪 ⟳ */
export function resolveToolCallInitialStatus(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): ToolTraceStatus {
  if (toolName !== 'run_command') return 'pending';
  if (isBackgroundManagementAction(toolArgs)) return 'pending';
  if (toolArgs?.background === true) return 'background';
  const command = extractRunCommandText(toolArgs);
  if (command && LONG_RUNNING_COMMAND.some((re) => re.test(command))) {
    return 'background';
  }
  return 'pending';
}

export function formatRunCommandToolDetail(toolArgs: Record<string, unknown> | undefined): string {
  if (!toolArgs || typeof toolArgs !== 'object') return '';

  const action = typeof toolArgs.action === 'string' ? toolArgs.action.trim() : '';
  const taskId = typeof toolArgs.task_id === 'string'
    ? toolArgs.task_id.trim()
    : typeof toolArgs.taskId === 'string'
      ? toolArgs.taskId.trim()
      : '';

  if (action === 'check' && taskId) return `check ${taskId}`;
  if (action === 'stop' && taskId) return `stop ${taskId}`;
  if (action === 'list') return 'list background tasks';

  const command = typeof toolArgs.command === 'string'
    ? toolArgs.command.trim()
    : typeof toolArgs.cmd === 'string'
      ? toolArgs.cmd.trim()
      : '';
  if (command) return command;

  const direct = toolArgs.path ?? toolArgs.file ?? toolArgs.query;
  if (typeof direct === 'string' && direct) return direct;

  try {
    const argsStr = JSON.stringify(toolArgs);
    return argsStr.length > 80 ? `${argsStr.substring(0, 80)}…` : argsStr;
  } catch {
    return '';
  }
}

export function formatToolArgsDetailPreview(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): string {
  if (toolName === 'run_command') {
    return formatRunCommandToolDetail(toolArgs);
  }
  if (!toolArgs || typeof toolArgs !== 'object') return '';
  const direct = toolArgs.path ?? toolArgs.file ?? toolArgs.command ?? toolArgs.query;
  if (typeof direct === 'string' && direct) return direct;
  try {
    const argsStr = JSON.stringify(toolArgs);
    return argsStr.length > 80 ? `${argsStr.substring(0, 80)}…` : argsStr;
  } catch {
    return '';
  }
}

export function parseRunCommandResultMode(toolOutput: string | undefined): string | null {
  if (!toolOutput?.trim()) return null;
  try {
    const parsed = JSON.parse(toolOutput) as { mode?: unknown };
    return typeof parsed.mode === 'string' ? parsed.mode : null;
  } catch {
    return null;
  }
}

export function resolveToolTraceResultStatus(
  toolName: string,
  toolSuccess: boolean | undefined,
  toolOutcome: string | undefined,
  toolOutput: string | undefined,
): ToolTraceStatus {
  if (toolOutcome === 'policy_block') return 'warn';
  if (toolName === 'run_command') {
    const mode = parseRunCommandResultMode(toolOutput);
    if (toolSuccess && (mode === 'background' || mode === 'escalated')) {
      return 'background';
    }
  }
  if (toolSuccess) return 'success';
  return 'error';
}

export interface CheckTaskResultInfo {
  taskId: string;
  status: string;
  exitCode?: number;
}

export function parseCheckTaskResult(toolOutput: string | undefined): CheckTaskResultInfo | null {
  if (!toolOutput?.trim()) return null;
  try {
    const parsed = JSON.parse(toolOutput) as {
      mode?: unknown;
      taskId?: unknown;
      status?: unknown;
      exitCode?: unknown;
    };
    if (parsed.mode !== 'check') return null;
    if (typeof parsed.taskId !== 'string' || !parsed.taskId) return null;
    if (typeof parsed.status !== 'string') return null;
    const info: CheckTaskResultInfo = { taskId: parsed.taskId, status: parsed.status };
    if (typeof parsed.exitCode === 'number') info.exitCode = parsed.exitCode;
    return info;
  } catch {
    return null;
  }
}

export function isTerminalBackgroundStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'timeout' || status === 'killed';
}
