// @ts-nocheck
/**
 * 工具条 detail / status 格式化（run_command 后台、check 等）。
 * 与 src/web/tool-trace-format.ts 保持语义一致。
 */

const LONG_RUNNING_COMMAND = [
  /^tsc\s+(--watch|-w)\b/,
  /^docker\s+(build|run|compose\s+up)\b/,
  /^(pip|poetry|conda)\s+install\b/,
  /^git\s+clone\b/,
  /^curl\s+.*-[oO]\s/,
];

function extractRunCommandText(toolArgs) {
  if (!toolArgs || typeof toolArgs !== 'object') return '';
  const command = typeof toolArgs.command === 'string'
    ? toolArgs.command.trim()
    : typeof toolArgs.cmd === 'string'
      ? toolArgs.cmd.trim()
      : '';
  return command;
}

function isBackgroundManagementAction(toolArgs) {
  if (!toolArgs || typeof toolArgs !== 'object') return false;
  const action = typeof toolArgs.action === 'string' ? toolArgs.action.trim() : '';
  return action === 'check' || action === 'stop' || action === 'list';
}

function resolveToolCallInitialStatus(toolName, toolArgs) {
  if (toolName !== 'run_command') return 'pending';
  if (isBackgroundManagementAction(toolArgs)) return 'pending';
  if (toolArgs && toolArgs.background === true) return 'background';
  const command = extractRunCommandText(toolArgs);
  if (command) {
    for (let i = 0; i < LONG_RUNNING_COMMAND.length; i++) {
      if (LONG_RUNNING_COMMAND[i].test(command)) return 'background';
    }
  }
  return 'pending';
}

function formatRunCommandToolDetail(toolArgs) {
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

  const direct = toolArgs.path || toolArgs.file || toolArgs.query;
  if (typeof direct === 'string' && direct) return direct;

  try {
    const argsStr = JSON.stringify(toolArgs);
    return argsStr.length > 80 ? `${argsStr.substring(0, 80)}…` : argsStr;
  } catch (_e) {
    return '';
  }
}

function formatToolArgsDetailPreview(toolName, toolArgs) {
  if (toolName === 'run_command') {
    return formatRunCommandToolDetail(toolArgs);
  }
  if (!toolArgs || typeof toolArgs !== 'object') return '';
  const direct = toolArgs.path || toolArgs.file || toolArgs.command || toolArgs.query;
  if (typeof direct === 'string' && direct) return direct;
  try {
    const argsStr = JSON.stringify(toolArgs);
    return argsStr.length > 80 ? `${argsStr.substring(0, 80)}…` : argsStr;
  } catch (_e) {
    return '';
  }
}

function parseRunCommandResultMode(toolOutput) {
  if (!toolOutput || !String(toolOutput).trim()) return null;
  try {
    const parsed = JSON.parse(toolOutput);
    return typeof parsed.mode === 'string' ? parsed.mode : null;
  } catch (_e) {
    return null;
  }
}

function resolveToolTraceResultStatus(toolName, toolSuccess, toolOutcome, toolOutput) {
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

function parseCheckTaskResult(toolOutput) {
  if (!toolOutput || !String(toolOutput).trim()) return null;
  try {
    const parsed = JSON.parse(toolOutput);
    if (parsed.mode !== 'check') return null;
    if (typeof parsed.taskId !== 'string' || !parsed.taskId) return null;
    if (typeof parsed.status !== 'string') return null;
    const info = { taskId: parsed.taskId, status: parsed.status };
    if (typeof parsed.exitCode === 'number') info.exitCode = parsed.exitCode;
    return info;
  } catch (_e) {
    return null;
  }
}

function isTerminalBackgroundStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'timeout' || status === 'killed';
}

const ToolTraceFormat = {
  formatRunCommandToolDetail,
  formatToolArgsDetailPreview,
  resolveToolCallInitialStatus,
  resolveToolTraceResultStatus,
  parseCheckTaskResult,
  isTerminalBackgroundStatus,
};

if (typeof window !== 'undefined') {
  window.ToolTraceFormat = ToolTraceFormat;
}

export {
  formatRunCommandToolDetail,
  formatToolArgsDetailPreview,
  resolveToolCallInitialStatus,
  resolveToolTraceResultStatus,
  parseCheckTaskResult,
  isTerminalBackgroundStatus,
  ToolTraceFormat,
};
