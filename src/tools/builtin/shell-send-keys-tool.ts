/**
 * shell_send_keys — 向 PTY 发送固定控制键序列。
 *
 * 不接受 raw bytes / 任意 ANSI；不经命令 sandbox 分类（CTRL_C 等不触发 mandatory confirm）。
 *
 * @see docs/requirement/shell-交互协管-slash-shell.md §5.5.3、§8.1.1
 */

import type { RegisteredTool } from '../types.js';
import { getInteractiveShellManagerFor } from '../interactive-shell-manager.js';

export const SHELL_SEND_KEY_NAMES = [
  'CTRL_C',
  'CTRL_D',
  'CTRL_Z',
  'ENTER',
  'TAB',
  'ESC',
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
] as const;

export type ShellSendKeyName = (typeof SHELL_SEND_KEY_NAMES)[number];

/** 枚举 → 固定 PTY 字节序列 */
export const SHELL_SEND_KEY_BYTES: Record<ShellSendKeyName, string> = {
  CTRL_C: '\x03',
  CTRL_D: '\x04',
  CTRL_Z: '\x1a',
  ENTER: '\r',
  TAB: '\t',
  ESC: '\x1b',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  LEFT: '\x1b[D',
  RIGHT: '\x1b[C',
};

function isShellSendKeyName(value: string): value is ShellSendKeyName {
  return (SHELL_SEND_KEY_NAMES as readonly string[]).includes(value);
}

function normalizeKeysArg(raw: unknown): ShellSendKeyName[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const keys: ShellSendKeyName[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !isShellSendKeyName(item)) return null;
    keys.push(item);
  }
  return keys;
}

/**
 * 创建绑定 session 的 shell_send_keys 工具实例。
 */
export function createShellSendKeysTool(workDir: string, sessionId: string): RegisteredTool {
  const mgr = getInteractiveShellManagerFor(sessionId, workDir);

  return {
    definition: {
      name: 'shell_send_keys',
      description:
        'Send fixed control keys to the current PTY (Ctrl-C, Ctrl-D, Tab, arrows, etc.). '
        + 'Does not spawn a shell or run shell commands. '
        + 'Follow with shell_wait or interactive_shell read to inspect the result.',
      parameters: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'Active interactive_shell task ID',
          },
          keys: {
            type: 'array',
            items: { type: 'string', enum: [...SHELL_SEND_KEY_NAMES] },
            description: 'Control keys to send in order',
          },
        },
        required: ['task_id', 'keys'],
      },
    },
    handler: async (args) => {
      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
      if (!taskId) {
        return { success: false, output: '', error: 'task_id is required' };
      }

      const keys = normalizeKeysArg(args.keys);
      if (!keys) {
        return {
          success: false,
          output: '',
          error: `keys must be a non-empty array of: ${SHELL_SEND_KEY_NAMES.join(', ')}`,
        };
      }

      const sent: ShellSendKeyName[] = [];
      let cursor: number | undefined;

      for (const key of keys) {
        const bytes = SHELL_SEND_KEY_BYTES[key];
        const result = mgr.writeRaw(taskId, bytes);
        if (!result.ok) {
          return {
            success: false,
            output: JSON.stringify({ taskId, sent, error: result.error }, null, 2),
            error: result.error,
          };
        }
        sent.push(key);
        cursor = result.cursor;
      }

      const task = mgr.getTask(taskId);
      const status = task?.status === 'completed'
        ? 'completed'
        : task?.status === 'killed'
          ? 'killed'
          : 'running';

      return {
        success: status !== 'killed',
        output: JSON.stringify({ taskId, status, sent, cursor }, null, 2),
      };
    },
  };
}
