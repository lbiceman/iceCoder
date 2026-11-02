/**
 * Shell 命令执行工具。
 * 提供在受限环境中执行 shell 命令的能力（前台和后台）。
 */

import { spawn } from 'node:child_process';
import type { RegisteredTool, ToolOutputCallback } from '../types.js';
import { getBackgroundTaskManagerFor } from '../background-task-manager.js';
import { registerForegroundShell, unregisterForegroundShell } from '../foreground-shell-registry.js';
import { killShellProcessTree } from '../shell-process-kill.js';
import {
  formatNormalizedCommandOutput,
  normalizeRunCommand,
} from './shell-command-normalizer.js';
import { analyzeInlineScriptCommand } from '../shell-inline-script-advisory.js';
import { checkOsSchedulerCommand } from '../shell-os-scheduler-guard.js';
import { analyzeShellSandbox } from '../shell-sandbox.js';
import { buildShellChildEnv } from '../shell-host-guard.js';
import { resolveShellExecutable } from '../shell-spawn-env.js';
import {
  classifyShellCommand,
  clampCommandYieldMs,
  pickBackgroundHardTimeout,
  pickForegroundTimeout,
  shellSoftEscalateEnabled,
  FOREGROUND_DEFAULT_TIMEOUT_MS,
  HARD_TIMEOUT_NONE,
  MAX_COMMAND_YIELD_MS,
  SOFT_TIMEOUT_MS,
} from '../shell-runtime-classifier.js';
import { buildVerificationSuccessSummary } from '../../harness/verification-digest.js';
import {
  assertAgentMemoryShellCommandAllowed,
  recordShellMemoryWriteSuccess,
  shellCommandTargetsMemoryWrite,
} from '../../memory/file-memory/memory-write-pipeline.js';
import { HeadTailCharBuffer } from '../head-tail-truncate.js';

/** 命令执行超时（毫秒）— 前台一次性命令单次最多 5 分钟 */
const DEFAULT_TIMEOUT = FOREGROUND_DEFAULT_TIMEOUT_MS;

/** 最大输出大小（字符；超限后保留头+尾，避免测试失败栈被丢掉） */
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB 量级

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
        'Execute shell commands (foreground or background). One blocking wait is at most 300000 ms (5 min) and returns as soon as the process exits. Short commands (e.g. git status, ls) run foreground with a 10s cap. Other commands wait in the foreground until exit or 5 minutes. If still running, the process is moved to the background and kept alive (not killed); the result includes a taskId. Watchers/installs/docker classified as long, or background:true, start in the background and return a taskId immediately — that start is not a completed run. Wait with task_id + action:"check": omit timeout to block up to 5 minutes, or pass timeout between 5000 and 300000. Do not poll every few seconds and do not start the command again. Use action:"list" to list background tasks. Use task_id + action:"stop" to kill a running background task. Pass command as a top-level argument (alias: cmd). Avoid inline one-liners with long/complex scripts on Windows — write a script file and run it instead.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute. Top-level field; alias: cmd. Not needed for list action' },
          timeout: { type: 'number', description: 'How long this call blocks, in ms. Foreground default and maximum are 300000 (5 min). For action:"check", omit to wait the full 5 minutes; values below 5000 are raised to 5000 and values above 300000 are cut to 300000. The wait ends early when the process exits. A foreground command still running at the end of the wait keeps running under the returned taskId. When background:true AND timeout is set, that value is a hard kill deadline for the background process and is not capped at 5 minutes.' },
          background: { type: 'boolean', description: 'Run command in background, returns task_id immediately', default: false },
          task_id: { type: 'string', description: 'Task ID for checking or stopping a background task' },
          action: { type: 'string', description: 'For background management: "check" (block until the task exits or timeout, max 5 min), "stop" (kill task), "list" (list all tasks)' },
          label: { type: 'string', description: 'Optional label for background task' },
          since: { type: 'number', description: 'For action:"check" — return only new output since this cursor (passed back from the previous check\'s `cursor` field). 0 = full output.' },
        },
        required: [],
      },
    },
    handler: async (args, onOutput?: ToolOutputCallback, signal?: AbortSignal) => {
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
        let status = bgManager.getStatus(taskId);
        if (!status) {
          return {
            success: false,
            output: '',
            error: `Task ${taskId} not found. Background tasks do not survive a server/session restart — run action=list for active tasks, or start the command again with background:true (omit task_id).`,
          };
        }
        let yieldMs: number | undefined;
        if (status.status === 'running') {
          yieldMs = clampCommandYieldMs(args.timeout, MAX_COMMAND_YIELD_MS);
          const waited = await bgManager.waitUntilTerminal(taskId, yieldMs, signal);
          if (waited === 'aborted') {
            return {
              success: false,
              output: '',
              error: `Wait for task ${taskId} was aborted. The process is still running; call action:"check" again.`,
            };
          }
          status = bgManager.getStatus(taskId) ?? status;
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
        if (yieldMs !== undefined && status.status === 'running') {
          result.yieldMs = yieldMs;
          result.hint = `Still running after this ${yieldMs}ms wait (single wait max ${MAX_COMMAND_YIELD_MS / 1000}s). The process was not killed. Call action:"check" again to wait up to another 5 minutes; it returns as soon as the process exits. Do not poll more often and do not start the command again.`;
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

      const shouldBackground =
        !explicitForeground &&
        (explicitBackground || shellClass === 'long');

      // ── Background task start ──
      if (shouldBackground) {
        const command = trimmedCommand;
        if (!command) return { success: false, output: '', error: 'Command cannot be empty' };
        const memoryShellErr = assertAgentMemoryShellCommandAllowed(command, sessionId);
        if (memoryShellErr) return { success: false, output: '', error: memoryShellErr };
        const osSchedulerErr = checkOsSchedulerCommand(command, sessionId);
        if (osSchedulerErr) return { success: false, output: '', error: osSchedulerErr };
        const inlineAdvisory = analyzeInlineScriptCommand(command);
        if (inlineAdvisory?.block) {
          return { success: false, output: '', error: inlineAdvisory.message };
        }
        const sandbox = analyzeShellSandbox(command, { workDir, includeBlacklist: false });
        if (sandbox.blocked) {
          return { success: false, output: '', error: sandbox.message ?? '[Sandbox / Blocked]' };
        }
        const explicitTimeoutMs = typeof args.timeout === 'number' && args.timeout > 0
          ? args.timeout
          : 0;
        const hardTimeoutMs = explicitBackground && explicitTimeoutMs > 0
          ? explicitTimeoutMs
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
            timeout: hardTimeoutMs > 0 ? `${timeoutSec}s` : 'unlimited',
            classifiedAs: shellClass,
            message: 'Task started in background. This is not a completed run. Call action:"check" with this task_id to wait until it exits (one call waits at most 5 minutes and returns earlier if it exits). Do not poll every few seconds and do not start the command again.',
          }, null, 2),
        };
      }

      // ── Foreground execution ──
      const command = trimmedCommand;
      if (!command) return { success: false, output: '', error: 'Command is required for foreground execution' };
      const memoryShellErr = assertAgentMemoryShellCommandAllowed(command, sessionId);
      if (memoryShellErr) return { success: false, output: '', error: memoryShellErr };
      const osSchedulerErr = checkOsSchedulerCommand(command, sessionId);
      if (osSchedulerErr) return { success: false, output: '', error: osSchedulerErr };
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

      const sandbox = analyzeShellSandbox(command, { workDir, includeBlacklist: false });
      if (sandbox.blocked) {
        return { success: false, output: '', error: sandbox.message ?? '[Sandbox / Blocked]' };
      }

      const normalized = normalizeRunCommand(command, { workDir });

      // auto 在本次等待内前台等到 exit（单次最多 5 分钟）。到点仍在跑则转入后台且不杀进程。
      // 8s escalate 会把 npm test 变成「启动成功」+ 额外一轮 check。
      // ICE_SHELL_SOFT_ESCALATE=1 可恢复旧行为。
      const enableEscalate = shellClass === 'auto'
        && !explicitForeground
        && shellSoftEscalateEnabled();

      return new Promise((resolve) => {
        const isWindows = process.platform === 'win32';
        const shell = resolveShellExecutable();
        const shellArgs = isWindows ? ['/c', normalized.command] : ['-c', normalized.command];

        const child = spawn(shell, shellArgs, {
          cwd: normalized.cwd,
          env: buildShellChildEnv(sessionId),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !isWindows,
          windowsHide: true,
        });
        registerForegroundShell(sessionId, child, command);

        const stdoutCap = new HeadTailCharBuffer(Math.floor(MAX_OUTPUT_SIZE / 2));
        const stderrCap = new HeadTailCharBuffer(Math.floor(MAX_OUTPUT_SIZE / 2));
        let killed = false;
        let escalated = false;
        let settled = false;

        const onAbort = () => {
          if (escalated || settled) return;
          killed = true;
          killShellProcessTree(child.pid ?? null, child);
        };
        const safeResolve = (value: any) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };

        let hardTimer: ReturnType<typeof setTimeout> | undefined;
        let softTimer: ReturnType<typeof setTimeout> | null = null;

        const handOffToBackground = (reason: 'soft_timeout' | 'yield_cap') => {
          if (settled || killed) return;
          escalated = true;
          if (hardTimer) clearTimeout(hardTimer);
          if (softTimer) clearTimeout(softTimer);

          // 卸载前台 listener，让 bg manager 重新挂
          try { child.stdout?.removeAllListeners('data'); } catch { /* ignore */ }
          try { child.stderr?.removeAllListeners('data'); } catch { /* ignore */ }
          try { child.removeAllListeners('close'); } catch { /* ignore */ }
          try { child.removeAllListeners('error'); } catch { /* ignore */ }

          const prefix = stdoutCap.toString() + (stderrCap.toString() ? `\n[stderr]\n${stderrCap.toString()}` : '');
          const labelArg = (args.label as string) || command.substring(0, 40);
          const adoptResult = bgManager.adopt(child, {
            command,
            label: labelArg,
            prefixOutput: prefix,
            hardTimeoutMs: HARD_TIMEOUT_NONE,
            reason,
          });
          unregisterForegroundShell(child);

          if (adoptResult.error) {
            // adopt 失败（如并发上限）：前台 listener 已卸载，无法干净回退。
            // 直接终止，避免子进程变成无人收割的孤儿。
            killed = true;
            killShellProcessTree(child.pid ?? null, child);
            const failedPartial = prefix.slice(-2000);
            const why = reason === 'soft_timeout'
              ? `命令运行超过 ${SOFT_TIMEOUT_MS}ms 且无法转入后台（${adoptResult.error}），已终止进程。`
              : `命令在本次等待（${timeout}ms）后仍在运行，且无法转入后台（${adoptResult.error}），已终止进程。`;
            safeResolve({
              success: false,
              output: failedPartial,
              error: why,
            });
            return;
          }

          const partialOutput = prefix.slice(-2000);
          const yielded = reason === 'yield_cap';
          safeResolve({
            success: true,
            output: JSON.stringify({
              mode: yielded ? 'yielded' : 'escalated',
              taskId: adoptResult.taskId,
              status: 'running',
              reason,
              partialOutput,
              hint: yielded
                ? `Still running after ${timeout}ms. A single wait is capped at ${MAX_COMMAND_YIELD_MS / 1000}s and the process was not killed. Call action:"check" with this taskId; that call waits up to 5 minutes and returns as soon as the process exits. Do not poll faster and do not run the command again.`
                : `Command still running after ${SOFT_TIMEOUT_MS / 1000}s; moved to background. Do NOT retry. Wait with action:"check" and the taskId (one check waits at most 5 minutes).`,
            }, null, 2),
          });
        };

        hardTimer = setTimeout(() => {
          if (escalated || settled) return;
          // auto 到点转入后台，进程继续跑。短命令和显式 background:false 仍按超时杀掉。
          if (shellClass === 'auto' && !explicitForeground) {
            handOffToBackground('yield_cap');
            return;
          }
          killed = true;
          killShellProcessTree(child.pid ?? null, child);
        }, timeout);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });

        // 软超时 escalate：仅 ICE_SHELL_SOFT_ESCALATE=1 的 auto 命令
        if (enableEscalate) {
          softTimer = setTimeout(() => {
            if (settled || killed) return;
            handOffToBackground('soft_timeout');
          }, SOFT_TIMEOUT_MS);
        }

        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          const alreadyTruncated = stdoutCap.truncated;
          stdoutCap.push(chunk);
          if (!alreadyTruncated && onOutput) onOutput(chunk);
        });

        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          const alreadyTruncated = stderrCap.truncated;
          stderrCap.push(chunk);
          if (!alreadyTruncated && onOutput) onOutput('[stderr] ' + chunk);
        });

        child.on('close', (code) => {
          if (escalated || settled) return;
          if (softTimer) clearTimeout(softTimer);
          clearTimeout(hardTimer);
          const stdout = stdoutCap.toString();
          const stderr = stderrCap.toString();
          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + stderr;
          output = formatNormalizedCommandOutput(normalized.fixes, output);
          if (inlineAdvisory && !inlineAdvisory.block) {
            output = `${inlineAdvisory.message}\n\n${output}`;
          }

          if (killed) { safeResolve({ success: false, output, error: `Command timed out (${timeout}ms)` }); return; }
          if (code === 0) {
            if (shellCommandTargetsMemoryWrite(command)) {
              recordShellMemoryWriteSuccess(sessionId, command);
            }
            safeResolve({ success: true, output: output || 'Command succeeded (no output)' });
          }
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
