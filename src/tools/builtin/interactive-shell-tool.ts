/**
 * interactive_shell — Shell 协作模式下的持久 PTY 工具。
 *
 * 生命周期：start / read / write / check / stop。
 * 仅绑定 session 注入 LLM，不注册进全局 ToolRegistry（见 shell-collab-tools.ts）。
 *
 * @see docs/requirement/shell-交互协管-slash-shell.md §5.1～§5.2
 */

import type { RegisteredTool } from '../types.js';
import {
  getInteractiveShellManagerFor,
  type InteractiveShellReadResult,
} from '../interactive-shell-manager.js';

const VALID_ACTIONS = ['start', 'read', 'write', 'check', 'stop'] as const;
type InteractiveShellAction = (typeof VALID_ACTIONS)[number];

function isValidAction(value: string): value is InteractiveShellAction {
  return (VALID_ACTIONS as readonly string[]).includes(value);
}

function formatReadPayload(action: 'read' | 'check' | 'write', result: InteractiveShellReadResult) {
  return {
    action,
    status: result.status,
    output: result.output,
    cursor: result.cursor,
    totalOutputLines: result.totalOutputLines,
    truncated: result.truncated,
    ...(result.recentOutput !== undefined ? { recentOutput: result.recentOutput } : {}),
    ...(result.promptText !== undefined ? { promptText: result.promptText } : {}),
    ...(result.promptHint !== undefined ? { promptHint: result.promptHint } : {}),
  };
}

/**
 * 创建绑定 session 的 interactive_shell 工具实例。
 */
export function createInteractiveShellTool(workDir: string, sessionId: string): RegisteredTool {
  const mgr = getInteractiveShellManagerFor(sessionId, workDir);

  return {
    definition: {
      name: 'interactive_shell',
      description:
        'Persistent PTY terminal for interactive sessions (SSH, exams, password prompts). '
        + 'Only use in Shell Copilot mode after user sent /shell. '
        + 'Actions: start, read, write, check, stop. '
        + 'Use shell_exec for shell commands; write is only for password/passphrase/yes-no/text prompts.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...VALID_ACTIONS],
            description: 'start | read | write | check | stop',
          },
          command: {
            type: 'string',
            description: 'For start: initial command e.g. ssh user@host',
          },
          input: {
            type: 'string',
            description:
              'For write: password/passphrase/yes-no/text response only. Commands must use shell_exec.',
          },
          task_id: {
            type: 'string',
            description: 'Omit on start; required for read/write/check/stop',
          },
          since: {
            type: 'number',
            description: 'For read/check: output cursor from previous read',
          },
          label: {
            type: 'string',
            description: 'Optional display label for start',
          },
        },
        required: ['action'],
      },
    },
    handler: async (args) => {
      const actionRaw = typeof args.action === 'string' ? args.action.trim() : '';
      if (!isValidAction(actionRaw)) {
        return {
          success: false,
          output: '',
          error: `action is required and must be one of: ${VALID_ACTIONS.join(', ')}`,
        };
      }

      const action = actionRaw;

      if (action === 'start') {
        const command = typeof args.command === 'string' ? args.command : undefined;
        const label = typeof args.label === 'string' ? args.label : undefined;
        const result = mgr.start({ command, label });

        if (result.error) {
          return {
            success: false,
            output: JSON.stringify(
              {
                action: 'start',
                status: result.status,
                taskId: result.taskId || undefined,
                shell: result.shell || undefined,
                cwd: result.cwd,
                error: result.error,
              },
              null,
              2,
            ),
            error: result.error,
          };
        }

        return {
          success: true,
          output: JSON.stringify(
            {
              action: 'start',
              status: result.status,
              taskId: result.taskId,
              shell: result.shell,
              cwd: result.cwd,
            },
            null,
            2,
          ),
        };
      }

      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
      if (!taskId) {
        return {
          success: false,
          output: '',
          error: 'task_id is required for read, write, check, and stop actions',
        };
      }

      if (action === 'stop') {
        const result = mgr.stop(taskId);
        if (result.error) {
          return {
            success: false,
            output: JSON.stringify({ action: 'stop', status: result.status, taskId, error: result.error }, null, 2),
            error: result.error,
          };
        }
        return {
          success: true,
          output: JSON.stringify({ action: 'stop', status: result.status, taskId }, null, 2),
        };
      }

      const since = typeof args.since === 'number' && args.since >= 0 ? args.since : 0;

      if (action === 'read' || action === 'check') {
        const readResult = mgr.check(taskId, since);
        if (!readResult) {
          return {
            success: false,
            output: '',
            error: `Task ${taskId} not found for this session`,
          };
        }
        return {
          success: true,
          output: JSON.stringify(formatReadPayload(action, readResult), null, 2),
        };
      }

      // write
      const input = typeof args.input === 'string' ? args.input : '';
      if (!input) {
        return {
          success: false,
          output: '',
          error: 'input is required for write action',
        };
      }

      const writeResult = mgr.writeInput(taskId, input);
      if (!writeResult.ok) {
        return {
          success: false,
          output: JSON.stringify(
            {
              action: 'write',
              taskId,
              error: writeResult.error,
              hint: 'Use shell_exec for shell commands when not awaiting interactive input',
            },
            null,
            2,
          ),
          error: writeResult.error,
        };
      }

      const readAfterWrite = mgr.read(taskId, since);
      if (!readAfterWrite) {
        return {
          success: true,
          output: JSON.stringify({ action: 'write', status: 'running', taskId }, null, 2),
        };
      }

      return {
        success: true,
        output: JSON.stringify({ ...formatReadPayload('write', readAfterWrite), taskId }, null, 2),
      };
    },
  };
}
