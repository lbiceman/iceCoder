/**
 * 后台任务工具集。
 *
 * 提供三个工具：
 * - run_background: 后台启动 shell 命令，立即返回 task ID
 * - check_task: 查询后台任务状态和输出
 * - list_tasks: 列出所有后台任务
 *
 * 与 run_command 互补：
 * - 短命令（< 30s）用 run_command（同步等待结果）
 * - 长命令（构建、测试、部署）用 run_background（异步，不阻塞）
 */

import type { RegisteredTool } from '../types.js';
import { getBackgroundTaskManager } from '../background-task-manager.js';

/**
 * 创建后台任务工具集。
 * @param workDir - 命令执行的工作目录
 */
export function createBackgroundTools(workDir: string): RegisteredTool[] {
  // 确保 BackgroundTaskManager 已初始化
  const manager = getBackgroundTaskManager(workDir);

  const runBackground: RegisteredTool = {
    definition: {
      name: 'run_background',
      // 在后台执行 shell 命令，立即返回 task ID。适用于耗时操作（构建、测试、安装依赖、部署）。短命令请用 run_command。
      description: 'Execute shell command in background, returns task ID immediately. For long-running operations (build, test, install, deploy). Use check_task to query progress. For short commands use run_command.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 shell 命令',
          },
          timeout: {
            type: 'number',
            description: '最大执行时间（秒），默认 300（5 分钟）',
            default: 300,
          },
          label: {
            type: 'string',
            description: '任务标签，便于识别（如 "npm test"、"build"）。不填则用命令前 50 字符。',
          },
        },
        required: ['command'],
      },
    },
    handler: async (args) => {
      const command = args.command as string;
      const timeoutSec = (args.timeout as number) || 300;
      const label = (args.label as string) || '';

      if (!command.trim()) {
        return { success: false, output: '', error: '命令不能为空' };
      }

      const result = manager.spawn(command, timeoutSec * 1000, label);

      if (result.error) {
        return { success: false, output: '', error: result.error };
      }

      const status = manager.getStatus(result.taskId);
      return {
        success: true,
        output: JSON.stringify({
          taskId: result.taskId,
          status: 'started',
          label: status?.label || label,
          timeout: `${timeoutSec}s`,
          message: '命令已在后台启动。用 check_task 查询进度。',
        }, null, 2),
      };
    },
  };

  const checkTask: RegisteredTool = {
    definition: {
      name: 'check_task',
      // 查询后台任务的状态和输出。
      description: 'Query background task status and output. Returns whether task is running, completed, or failed, plus recent output.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'run_background 返回的 task ID',
          },
          tail: {
            type: 'number',
            description: '只看最后 N 行输出，默认 50',
            default: 50,
          },
        },
        required: ['taskId'],
      },
    },
    handler: async (args) => {
      const taskId = args.taskId as string;
      const tail = (args.tail as number) || 50;

      const status = manager.getStatus(taskId);
      if (!status) {
        return {
          success: false,
          output: '',
          error: `任务 ${taskId} 不存在（可能已过期或从未启动）`,
        };
      }

      const output = manager.getOutput(taskId, tail);
      const result: Record<string, any> = {
        taskId: status.taskId,
        label: status.label,
        status: status.status,
        elapsed: status.elapsed,
      };

      if (status.exitCode !== null) {
        result.exitCode = status.exitCode;
      }
      if (status.error) {
        result.error = status.error;
      }

      result.output = output || '(无输出)';

      return {
        success: status.status === 'completed',
        output: JSON.stringify(result, null, 2),
        error: status.status === 'failed' || status.status === 'timeout'
          ? status.error || undefined
          : undefined,
      };
    },
  };

  const listTasks: RegisteredTool = {
    definition: {
      name: 'list_tasks',
      // 列出所有后台任务及其状态。
      description: 'List all background tasks and their status. For tracking running tasks.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    handler: async () => {
      const tasks = manager.list();

      if (tasks.length === 0) {
        return {
          success: true,
          output: '当前没有后台任务。',
        };
      }

      const summary = tasks.map(t => ({
        taskId: t.taskId,
        label: t.label,
        status: t.status,
        elapsed: t.elapsed,
        ...(t.exitCode !== null ? { exitCode: t.exitCode } : {}),
      }));

      return {
        success: true,
        output: JSON.stringify(summary, null, 2),
      };
    },
  };

  const stopTask: RegisteredTool = {
    definition: {
      name: 'stop_task',
      // 终止正在运行的后台任务。
      description: 'Stop a running background task. Sends SIGTERM then SIGKILL after 2s. Use list_tasks to find task IDs.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'The task ID returned by run_background',
          },
        },
        required: ['taskId'],
      },
    },
    handler: async (args) => {
      const taskId = args.taskId as string;
      const status = manager.getStatus(taskId);

      if (!status) {
        return { success: false, output: '', error: `Task ${taskId} not found (may have expired or never existed).` };
      }

      if (status.status !== 'running') {
        return { success: false, output: '', error: `Task ${taskId} is not running (status: ${status.status}).` };
      }

      const killed = manager.kill(taskId);
      if (killed) {
        return { success: true, output: `Task ${taskId} (${status.label || 'unlabeled'}) has been terminated.` };
      }
      return { success: false, output: '', error: `Failed to stop task ${taskId}.` };
    },
  };

  return [runBackground, checkTask, listTasks, stopTask];
}
