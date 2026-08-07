/**
 * shell_exec — 在当前持久 PTY 内执行命令并等待结果。
 *
 * 等价于 write(command + newline) → wait → read；不 spawn 新 shell。
 *
 * @see docs/requirement/shell-交互协管-slash-shell.md §5.5.1
 */

import type { RegisteredTool } from '../types.js';
import {
  getInteractiveShellManagerFor,
  type ShellWaitUntil,
  type ShellWaitResult,
} from '../interactive-shell-manager.js';

const VALID_WAIT_UNTIL = ['idle', 'prompt', 'exit'] as const;
type ShellExecWaitUntil = (typeof VALID_WAIT_UNTIL)[number];

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function isValidWaitUntil(value: string): value is ShellExecWaitUntil {
  return (VALID_WAIT_UNTIL as readonly string[]).includes(value);
}

function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

function formatExecPayload(waitResult: ShellWaitResult, taskId: string) {
  return {
    taskId,
    status: waitResult.status,
    output: waitResult.output,
    cursor: waitResult.cursor,
    totalOutputLines: waitResult.totalOutputLines,
    truncated: waitResult.truncated,
    ...(waitResult.exitCode !== undefined ? { exitCode: waitResult.exitCode } : {}),
    ...(waitResult.promptHint !== undefined ? { promptHint: waitResult.promptHint } : {}),
    ...(waitResult.promptText !== undefined ? { promptText: waitResult.promptText } : {}),
  };
}

/**
 * 创建绑定 session 的 shell_exec 工具实例。
 */
export function createShellExecTool(workDir: string, sessionId: string): RegisteredTool {
  const mgr = getInteractiveShellManagerFor(sessionId, workDir);

  return {
    definition: {
      name: 'shell_exec',
      description:
        'Execute one command inside the current persistent PTY. Never spawns a new local shell. '
        + 'Waits until output is idle, a prompt appears, or the shell exits. '
        + 'When awaiting_input, use interactive_shell write instead.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Active interactive_shell task ID',
          },
          command: {
            type: 'string',
            description: 'Shell command to run inside the current PTY',
          },
          wait_until: {
            type: 'string',
            enum: [...VALID_WAIT_UNTIL],
            description: 'Wait condition: idle (default), prompt, or exit',
          },
          timeout_ms: {
            type: 'number',
            description: 'Max wait time in ms (1000–120000, default 60000)',
          },
        },
        required: ['task_id', 'command'],
      },
    },
    handler: async (args) => {
      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
      if (!taskId) {
        return { success: false, output: '', error: 'task_id is required' };
      }

      const command = typeof args.command === 'string' ? args.command : '';
      if (!command.trim()) {
        return { success: false, output: '', error: 'command is required' };
      }

      const waitUntilRaw = typeof args.wait_until === 'string' ? args.wait_until.trim() : 'idle';
      const waitUntil: ShellWaitUntil = isValidWaitUntil(waitUntilRaw) ? waitUntilRaw : 'idle';
      const timeoutMs = clampTimeout(args.timeout_ms);

      const writeResult = mgr.writeCommand(taskId, command);
      if (!writeResult.ok) {
        return {
          success: false,
          output: JSON.stringify(
            {
              taskId,
              error: writeResult.error,
              hint:
                writeResult.error?.includes('交互输入态')
                  ? 'Use interactive_shell write for passwords and interactive prompts'
                  : undefined,
            },
            null,
            2,
          ),
          error: writeResult.error,
        };
      }

      const waitResult = await mgr.waitFor(taskId, {
        since: writeResult.since ?? 0,
        until: waitUntil,
        timeoutMs,
      });

      if (!waitResult) {
        return {
          success: false,
          output: '',
          error: `Task ${taskId} not found for this session`,
        };
      }

      const payload = formatExecPayload(waitResult, taskId);
      const isTimeout = waitResult.status === 'timeout';

      return {
        success: !isTimeout && waitResult.status !== 'killed',
        output: JSON.stringify(payload, null, 2),
        ...(isTimeout ? { error: 'Command wait timed out; PTY is still running' } : {}),
      };
    },
  };
}
