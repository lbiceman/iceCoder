/**
 * Shell 命令执行工具。
 * 提供在受限环境中执行 shell 命令的能力（前台和后台）。
 */

import { spawn } from 'node:child_process';
import type { RegisteredTool, ToolOutputCallback } from '../types.js';
import { getBackgroundTaskManager } from '../background-task-manager.js';
import {
  formatNormalizedCommandOutput,
  normalizeRunCommand,
} from './shell-command-normalizer.js';
import { analyzeInlineScriptCommand } from '../shell-inline-script-advisory.js';
import {
  analyzeShellHostSafety,
  buildShellChildEnv,
  matchesDangerousShellPattern,
} from '../shell-host-guard.js';

/** 命令执行超时（毫秒） */
const DEFAULT_TIMEOUT = 30000;

/** 最大输出大小（字节） */
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

/**
 * 创建 Shell 命令执行工具（含前台和后台任务管理）。
 * @param workDir - 命令执行的工作目录
 */
export function createShellTool(workDir: string): RegisteredTool {
  // 确保 BackgroundTaskManager 已初始化
  const bgManager = getBackgroundTaskManager(workDir);

  return {
    definition: {
      name: 'run_command',
      description:
        'Execute shell commands (foreground or background). Pass command as a top-level argument (not nested in a raw JSON string; alias: cmd). Foreground: waits for result (default 30s timeout). Background: set background:true for long commands, returns task_id immediately. Use task_id + action:"check" to poll status/output. Use action:"list" to list all background tasks. Use task_id + action:"stop" to kill a running background task. Has dangerous command blocklist. Avoid inline `node -e` with long/complex scripts on Windows — write to scripts/*.mjs or scripts/*.cjs and run the file instead. Use immediately for any explicit shell command the user requests.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute. Top-level field; alias: cmd. Not needed for list action' },
          timeout: { type: 'number', description: 'Timeout in ms for foreground (default 30000)', default: 30000 },
          background: { type: 'boolean', description: 'Run command in background, returns task_id immediately', default: false },
          task_id: { type: 'string', description: 'Task ID for checking or stopping a background task' },
          action: { type: 'string', description: 'For background management: "check" (query task status), "stop" (kill task), "list" (list all tasks)' },
          label: { type: 'string', description: 'Optional label for background task' },
        },
        required: [],
      },
    },
    handler: async (args, onOutput?: ToolOutputCallback) => {
      // Normalize: cmd is an accepted alias for command
      if (args.cmd !== undefined && args.command === undefined) args.command = args.cmd;
      const action = (args.action as string) || '';
      const taskId = (args.task_id as string) || '';

      // ── Background task management actions ──
      if (action === 'list') {
        const tasks = bgManager.list();
        if (tasks.length === 0) return { success: true, output: 'No background tasks.' };
        const summary = tasks.map(t => ({
          taskId: t.taskId, label: t.label, status: t.status, elapsed: t.elapsed,
          ...(t.exitCode !== null ? { exitCode: t.exitCode } : {}),
        }));
        return { success: true, output: JSON.stringify(summary, null, 2) };
      }

      if (action === 'check') {
        if (!taskId) return { success: false, output: '', error: 'task_id is required for check action' };
        const status = bgManager.getStatus(taskId);
        if (!status) return { success: false, output: '', error: `Task ${taskId} not found` };
        const output = bgManager.getOutput(taskId, 50);
        const result: Record<string, any> = { taskId: status.taskId, label: status.label, status: status.status, elapsed: status.elapsed };
        if (status.exitCode !== null) result.exitCode = status.exitCode;
        if (status.error) result.error = status.error;
        result.output = output || '(no output)';
        return {
          success: status.status === 'completed',
          output: JSON.stringify(result, null, 2),
          error: status.status === 'failed' || status.status === 'timeout' ? status.error || undefined : undefined,
        };
      }

      if (action === 'stop') {
        if (!taskId) return { success: false, output: '', error: 'task_id is required for stop action' };
        const status = bgManager.getStatus(taskId);
        if (!status) return { success: false, output: '', error: `Task ${taskId} not found` };
        if (status.status !== 'running') return { success: false, output: '', error: `Task ${taskId} is not running (status: ${status.status})` };
        const killed = bgManager.kill(taskId);
        return killed
          ? { success: true, output: `Task ${taskId} (${status.label || 'unlabeled'}) terminated.` }
          : { success: false, output: '', error: `Failed to stop task ${taskId}` };
      }

      // ── Background task start ──
      if (args.background) {
        const command = (args.command as string) || '';
        if (!command.trim()) return { success: false, output: '', error: 'Command cannot be empty' };
        const inlineAdvisory = analyzeInlineScriptCommand(command);
        if (inlineAdvisory?.block) {
          return { success: false, output: '', error: inlineAdvisory.message };
        }
        const bgHostGuard = analyzeShellHostSafety(command, { workDir });
        if (bgHostGuard.blocked) {
          return { success: false, output: '', error: bgHostGuard.message ?? '[HostGuard / Blocked]' };
        }
        const timeoutSec = ((args.timeout as number) || 300000) / 1000;
        const label = (args.label as string) || '';
        const bgResult = bgManager.spawn(command, timeoutSec * 1000, label);
        if (bgResult.error) return { success: false, output: '', error: bgResult.error };
        const bgStatus = bgManager.getStatus(bgResult.taskId);
        return {
          success: true,
          output: JSON.stringify({
            taskId: bgResult.taskId, status: 'started',
            label: bgStatus?.label || label, timeout: `${timeoutSec}s`,
            message: 'Task started in background. Use action:"check" with task_id to poll progress.',
          }, null, 2),
        };
      }

      // ── Foreground execution ──
      const command = (args.command as string) || '';
      if (!command.trim()) return { success: false, output: '', error: 'Command is required for foreground execution' };
      const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;

      const inlineAdvisory = analyzeInlineScriptCommand(command);
      if (inlineAdvisory?.block) {
        return { success: false, output: '', error: inlineAdvisory.message };
      }

      const hostGuard = analyzeShellHostSafety(command, { workDir });
      if (hostGuard.blocked) {
        return { success: false, output: '', error: hostGuard.message ?? '[HostGuard / Blocked]' };
      }

      if (matchesDangerousShellPattern(command)) {
        return { success: false, output: '', error: 'Security check failed: command matches dangerous pattern' };
      }

      const normalized = normalizeRunCommand(command, { workDir });

      return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shellArgs = isWindows ? ['/c', normalized.command] : ['-c', normalized.command];

        const child = spawn(shell, shellArgs, {
          cwd: normalized.cwd,
          env: buildShellChildEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let totalSize = 0;
        let killed = false;

        const timer = setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
        }, timeout);

        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          totalSize += data.length;
          if (totalSize <= MAX_OUTPUT_SIZE) { stdout += chunk; if (onOutput) onOutput(chunk); }
        });

        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          totalSize += data.length;
          if (totalSize <= MAX_OUTPUT_SIZE) { stderr += chunk; if (onOutput) onOutput('[stderr] ' + chunk); }
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + stderr;
          output = formatNormalizedCommandOutput(normalized.fixes, output);
          if (inlineAdvisory && !inlineAdvisory.block) {
            output = `${inlineAdvisory.message}\n\n${output}`;
          }

          if (killed) { resolve({ success: false, output, error: `Command timed out (${timeout}ms)` }); return; }
          if (code === 0) { resolve({ success: true, output: output || 'Command succeeded (no output)' }); }
          else { resolve({ success: false, output, error: `Command failed (exit code: ${code})` }); }
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ success: false, output: '', error: `Command failed to start: ${err.message}` });
        });
      });
    },
  };
}
