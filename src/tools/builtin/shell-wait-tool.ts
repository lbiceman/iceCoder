/**
 * shell_wait — 等待 PTY 异步输出、idle、prompt 或 exit（不写命令）。
 *
 * timeout 为正常结束态，不会 kill PTY。
 *
 * @see docs/requirement/shell-交互协管-slash-shell.md §5.5.2
 */

import type { RegisteredTool } from '../types.js';
import {
  getInteractiveShellManagerFor,
  type ShellWaitUntil,
  type ShellWaitResult,
} from '../interactive-shell-manager.js';

const VALID_WAIT_UNTIL = ['output', 'idle', 'prompt', 'exit'] as const;
type ShellWaitToolUntil = (typeof VALID_WAIT_UNTIL)[number];

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function isValidWaitUntil(value: string): value is ShellWaitToolUntil {
  return (VALID_WAIT_UNTIL as readonly string[]).includes(value);
}

function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

function formatWaitPayload(waitResult: ShellWaitResult, taskId: string) {
  return {
    taskId,
    status: waitResult.status,
    output: waitResult.output,
    cursor: waitResult.cursor,
    ...(waitResult.matched !== undefined ? { matched: waitResult.matched } : {}),
    ...(waitResult.promptHint !== undefined ? { promptHint: waitResult.promptHint } : {}),
    ...(waitResult.promptText !== undefined ? { promptText: waitResult.promptText } : {}),
    ...(waitResult.exitCode !== undefined ? { exitCode: waitResult.exitCode } : {}),
  };
}

/**
 * 创建绑定 session 的 shell_wait 工具实例。
 */
export function createShellWaitTool(workDir: string, sessionId: string): RegisteredTool {
  const mgr = getInteractiveShellManagerFor(sessionId, workDir);

  return {
    definition: {
      name: 'shell_wait',
      description:
        'Wait for async PTY output, idle, interactive prompt, or shell exit without writing a command. '
        + 'Use after long-running commands, installers, or shell_send_keys. '
        + 'Timeout is normal and does not kill the PTY.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Active interactive_shell task ID',
          },
          since: {
            type: 'number',
            description: 'Output cursor from a previous read or exec',
          },
          until: {
            type: 'string',
            enum: [...VALID_WAIT_UNTIL],
            description: 'Wait until: output, idle, prompt, or exit',
          },
          pattern: {
            type: 'string',
            description: 'Optional plain-text substring matcher (not regex)',
          },
          timeout_ms: {
            type: 'number',
            description: 'Max wait time in ms (1000–120000, default 60000)',
          },
        },
        required: ['task_id', 'until'],
      },
    },
    handler: async (args) => {
      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
      if (!taskId) {
        return { success: false, output: '', error: 'task_id is required' };
      }

      const untilRaw = typeof args.until === 'string' ? args.until.trim() : '';
      if (!isValidWaitUntil(untilRaw)) {
        return {
          success: false,
          output: '',
          error: `until is required and must be one of: ${VALID_WAIT_UNTIL.join(', ')}`,
        };
      }

      const since = typeof args.since === 'number' && args.since >= 0 ? args.since : 0;
      const timeoutMs = clampTimeout(args.timeout_ms);
      const pattern = typeof args.pattern === 'string' && args.pattern.length > 0
        ? args.pattern
        : undefined;

      const waitResult = await mgr.waitFor(taskId, {
        since,
        until: untilRaw as ShellWaitUntil,
        timeoutMs,
        pattern,
      });

      if (!waitResult) {
        return {
          success: false,
          output: '',
          error: `Task ${taskId} not found for this session`,
        };
      }

      return {
        success: waitResult.status !== 'killed',
        output: JSON.stringify(formatWaitPayload(waitResult, taskId), null, 2),
      };
    },
  };
}
