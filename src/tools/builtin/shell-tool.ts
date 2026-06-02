/**
 * Shell 命令执行工具。
 * 提供在受限环境中执行 shell 命令的能力（前台和后台）。
 */

import { spawn } from 'node:child_process';
import type { RegisteredTool, ToolOutputCallback } from '../types.js';
import { getBackgroundTaskManagerFor } from '../background-task-manager.js';
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
import {
  classifyShellCommand,
  pickBackgroundHardTimeout,
  pickForegroundTimeout,
  HARD_TIMEOUT_LONG_MS,
  SOFT_TIMEOUT_MS,
} from '../shell-runtime-classifier.js';
import { buildVerificationSuccessSummary } from '../../harness/verification-digest.js';
import { isDestructiveCommand } from '../tool-metadata.js';

/** 命令执行超时（毫秒） */
const DEFAULT_TIMEOUT = 30000;

/** 最大输出大小（字节） */
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

/**
 * 创建 Shell 命令执行工具（含前台和后台任务管理）。
 * @param workDir - 命令执行的工作目录
 */
export function createShellTool(workDir: string, sessionId = 'default'): RegisteredTool {
  const bgManager = getBackgroundTaskManagerFor(sessionId, workDir);

  return {
    definition: {
      name: 'run_command',
      description:
        'Execute shell commands (foreground or background). Runtime auto-picks foreground/background by command shape: long jobs (npm test/build/dev, vitest, tsc -w, docker build, git clone) go background and return a task_id immediately; short commands (git status, ls, tsc --noEmit) run foreground with a 10s cap. Force with background:true only if the classifier missed it; never set background:true for destructive commands (rm/del/git push -f). Pass command as a top-level argument (alias: cmd). Use task_id + action:"check" to poll status/output. Use action:"list" to list all background tasks for this session. Use task_id + action:"stop" to kill a running background task. Has dangerous command blocklist. Avoid inline `node -e` with long/complex scripts on Windows — write to scripts/*.mjs or scripts/*.cjs and run the file instead.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute. Top-level field; alias: cmd. Not needed for list action' },
          timeout: { type: 'number', description: 'Timeout in ms for foreground (default 30000)', default: 30000 },
          background: { type: 'boolean', description: 'Run command in background, returns task_id immediately', default: false },
          task_id: { type: 'string', description: 'Task ID for checking or stopping a background task' },
          action: { type: 'string', description: 'For background management: "check" (query task status), "stop" (kill task), "list" (list all tasks)' },
          label: { type: 'string', description: 'Optional label for background task' },
          since: { type: 'number', description: 'For action:"check" — return only new output since this cursor (passed back from the previous check\'s `cursor` field). 0 = full output.' },
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
        if (!status) {
          return {
            success: false,
            output: '',
            error: `Task ${taskId} not found. Background tasks do not survive a server/session restart — run action=list for active tasks, or start the command again with background:true (omit task_id).`,
          };
        }
        const since = typeof args.since === 'number' && args.since >= 0
          ? args.since
          : 0;
        const incremental = bgManager.getOutputSince(taskId, since);
        const tailOutput = bgManager.getOutput(taskId, 100) || '';
        const result: Record<string, any> = {
          mode: 'check',
          taskId: status.taskId,
          label: status.label,
          // P0: 暴露真实 command，让 Acceptance Gate 用命令而非 label 匹配验收项
          command: status.command,
          status: status.status,
          elapsed: status.elapsed,
          cursor: incremental?.cursor ?? 0,
          truncated: incremental?.truncated ?? false,
          hasMore: status.status === 'running',
        };
        if (status.exitCode !== null) result.exitCode = status.exitCode;
        if (status.error) result.error = status.error;
        // P1: completed 且 exit 0 时附上一行成功摘要（即使 output 被截断也能看到结论）
        if (status.status === 'completed' && (status.exitCode === null || status.exitCode === 0)) {
          const summary = buildVerificationSuccessSummary(status.command, tailOutput);
          if (summary) result.summary = summary;
        }
        result.output = (incremental?.output || (since === 0 ? tailOutput : '')) || '(no new output)';
        return {
          success: status.status === 'completed' || status.status === 'running',
          output: JSON.stringify(result, null, 2),
          error: status.status === 'failed' || status.status === 'timeout' ? status.error || undefined : undefined,
        };
      }

      if (action === 'stop') {
        if (!taskId) return { success: false, output: '', error: 'task_id is required for stop action' };
        const status = bgManager.getStatus(taskId);
        if (!status) {
          return {
            success: false,
            output: '',
            error: `Task ${taskId} not found. Background tasks do not survive a server/session restart — run action=list for active tasks, or start the command again with background:true (omit task_id).`,
          };
        }
        if (status.status !== 'running') return { success: false, output: '', error: `Task ${taskId} is not running (status: ${status.status})` };
        const killed = bgManager.kill(taskId);
        return killed
          ? { success: true, output: `Task ${taskId} (${status.label || 'unlabeled'}) terminated.` }
          : { success: false, output: '', error: `Failed to stop task ${taskId}` };
      }

      // ── Classifier decision (runtime-driven foreground/background split) ──
      const rawCommand = (args.command as string) || '';
      const trimmedCommand = rawCommand.trim();
      const shellClass = trimmedCommand ? classifyShellCommand(trimmedCommand) : 'auto';
      const explicitBackground = args.background === true;
      const explicitForeground = args.background === false;

      // destructive 命令拒绝静默后台（包括 classifier 判 long + 显式 background:true）
      const destructive = trimmedCommand ? isDestructiveCommand(trimmedCommand) : false;

      // 决定实际是否走后台：
      // 1) explicit background:true 且非 destructive → background
      // 2) explicit background:false → foreground（永不 background）
      // 3) classifier === 'long' 且非 destructive → background (auto)
      // 4) 否则 → foreground
      const shouldBackground =
        !destructive &&
        !explicitForeground &&
        (explicitBackground || shellClass === 'long');

      // ── Background task start ──
      if (shouldBackground) {
        const command = trimmedCommand;
        if (!command) return { success: false, output: '', error: 'Command cannot be empty' };
        const inlineAdvisory = analyzeInlineScriptCommand(command);
        if (inlineAdvisory?.block) {
          return { success: false, output: '', error: inlineAdvisory.message };
        }
        const bgHostGuard = analyzeShellHostSafety(command, { workDir });
        if (bgHostGuard.blocked) {
          return { success: false, output: '', error: bgHostGuard.message ?? '[HostGuard / Blocked]' };
        }
        const userTimeoutMs = (args.timeout as number) || 0;
        const hardTimeoutMs = userTimeoutMs > 0
          ? userTimeoutMs
          : pickBackgroundHardTimeout(shellClass, { explicitBackground });
        const timeoutSec = hardTimeoutMs / 1000;
        const label = (args.label as string) || '';
        const bgResult = bgManager.spawn(command, hardTimeoutMs, label);
        if (bgResult.error) return { success: false, output: '', error: bgResult.error };
        const bgStatus = bgManager.getStatus(bgResult.taskId);
        return {
          success: true,
          output: JSON.stringify({
            mode: 'background',
            taskId: bgResult.taskId,
            status: 'started',
            label: bgStatus?.label || label,
            timeout: `${timeoutSec}s`,
            classifiedAs: shellClass,
            message: 'Task started in background. Use action:"check" with task_id to poll progress.',
          }, null, 2),
        };
      }

      // ── Foreground execution ──
      const command = trimmedCommand;
      if (!command) return { success: false, output: '', error: 'Command is required for foreground execution' };
      // classifier 收紧 short 命令前台 timeout 上限到 10s
      const timeout = pickForegroundTimeout(
        shellClass,
        args.timeout as number | undefined,
        DEFAULT_TIMEOUT,
      );

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

      // 软超时 escalate 仅在 classifier === 'auto' 且非显式 foreground 时启用。
      // - 'short'：10s 必完成，不需要 escalate
      // - 显式 background:false：用户要求同步等结果，不 escalate
      // - 'long' 已在上面被分流到后台，走不到这里
      const enableEscalate = shellClass === 'auto' && !explicitForeground;

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
        let escalated = false;
        let settled = false;

        const safeResolve = (value: any) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        const hardTimer = setTimeout(() => {
          if (escalated || settled) return;
          killed = true;
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
        }, timeout);

        // Phase 2: 软超时 escalate（仅 'auto' 分支）
        let softTimer: ReturnType<typeof setTimeout> | null = null;
        if (enableEscalate) {
          softTimer = setTimeout(() => {
            if (settled || killed) return;
            escalated = true;
            clearTimeout(hardTimer);

            // 卸载前台 listener，让 bg manager 重新挂
            try { child.stdout?.removeAllListeners('data'); } catch { /* ignore */ }
            try { child.stderr?.removeAllListeners('data'); } catch { /* ignore */ }
            try { child.removeAllListeners('close'); } catch { /* ignore */ }
            try { child.removeAllListeners('error'); } catch { /* ignore */ }

            const prefix = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
            const labelArg = (args.label as string) || command.substring(0, 40);
            const adoptResult = bgManager.adopt(child, {
              command,
              label: labelArg,
              prefixOutput: prefix,
              hardTimeoutMs: HARD_TIMEOUT_LONG_MS,
              reason: 'soft_timeout',
            });

            if (adoptResult.error) {
              // adopt 失败（如并发上限）→ 退回前台 hard timeout 行为
              escalated = false;
              return;
            }

            const partialOutput = prefix.slice(-2000);
            safeResolve({
              success: true,
              output: JSON.stringify({
                mode: 'escalated',
                taskId: adoptResult.taskId,
                reason: 'soft_timeout',
                partialOutput,
                hint: 'Command still running after 8s; moved to background. Do NOT retry. Poll later with action:"check" and the taskId.',
              }, null, 2),
            });
          }, SOFT_TIMEOUT_MS);
        }

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
          if (escalated || settled) return;
          if (softTimer) clearTimeout(softTimer);
          clearTimeout(hardTimer);
          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + stderr;
          output = formatNormalizedCommandOutput(normalized.fixes, output);
          if (inlineAdvisory && !inlineAdvisory.block) {
            output = `${inlineAdvisory.message}\n\n${output}`;
          }

          if (killed) { safeResolve({ success: false, output, error: `Command timed out (${timeout}ms)` }); return; }
          if (code === 0) { safeResolve({ success: true, output: output || 'Command succeeded (no output)' }); }
          else { safeResolve({ success: false, output, error: `Command failed (exit code: ${code})` }); }
        });

        child.on('error', (err) => {
          if (escalated || settled) return;
          if (softTimer) clearTimeout(softTimer);
          clearTimeout(hardTimer);
          safeResolve({ success: false, output: '', error: `Command failed to start: ${err.message}` });
        });
      });
    },
  };
}
