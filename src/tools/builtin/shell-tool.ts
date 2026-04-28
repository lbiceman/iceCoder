/**
 * Shell 命令执行工具。
 * 提供在受限环境中执行 shell 命令的能力。
 * 支持实时输出流（通过 onOutput 回调推送 stdout/stderr）。
 */

import { spawn } from 'node:child_process';
import type { RegisteredTool, ToolOutputCallback } from '../types.js';

/** 命令执行超时（毫秒） */
const DEFAULT_TIMEOUT = 30000;

/** 最大输出大小（字节） */
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

/** 危险命令黑名单 */
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\/(?!\w)/i,     // rm -rf /
  /\bformat\b/i,                  // format
  /\bmkfs\b/i,                    // mkfs
  /\bdd\s+if=/i,                  // dd if=
  /\b:>\s*\/etc\//i,             // 清空系统文件
  /\bshutdown\b/i,               // shutdown
  /\breboot\b/i,                  // reboot
];

/**
 * 创建 Shell 命令执行工具。
 * @param workDir - 命令执行的工作目录
 */
export function createShellTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'run_command',
      description:
        '在工作目录中执行 shell 命令。返回 stdout 和 stderr。有超时限制和安全检查。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout: {
            type: 'number',
            description: '命令超时（毫秒），默认 30000',
            default: 30000,
          },
        },
        required: ['command'],
      },
    },
    handler: async (args, onOutput?: ToolOutputCallback) => {
      const command = args.command as string;
      const timeout = (args.timeout as number) || DEFAULT_TIMEOUT;

      // 安全检查
      for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(command)) {
          return {
            success: false,
            output: '',
            error: `安全检查失败: 命令包含危险操作模式`,
          };
        }
      }

      return new Promise((resolve) => {
        // 使用 spawn + shell 模式，支持管道和重定向
        const isWindows = process.platform === 'win32';
        const shell = isWindows ? 'cmd.exe' : '/bin/sh';
        const shellArgs = isWindows ? ['/c', command] : ['-c', command];

        const child = spawn(shell, shellArgs, {
          cwd: workDir,
          env: { ...process.env, NODE_ENV: 'production' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let totalSize = 0;
        let killed = false;

        // 超时处理
        const timer = setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
          // 给进程 2 秒优雅退出，否则强杀
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }, 2000);
        }, timeout);

        child.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          totalSize += data.length;
          if (totalSize <= MAX_OUTPUT_SIZE) {
            stdout += chunk;
            // 实时推送 stdout
            if (onOutput) onOutput(chunk);
          }
        });

        child.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          totalSize += data.length;
          if (totalSize <= MAX_OUTPUT_SIZE) {
            stderr += chunk;
            // 实时推送 stderr
            if (onOutput) onOutput('[stderr] ' + chunk);
          }
        });

        child.on('close', (code) => {
          clearTimeout(timer);

          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + stderr;

          if (killed) {
            resolve({
              success: false,
              output,
              error: `命令执行超时 (${timeout}ms)`,
            });
            return;
          }

          if (code === 0) {
            resolve({
              success: true,
              output: output || '命令执行成功（无输出）',
            });
          } else {
            resolve({
              success: false,
              output,
              error: `命令执行失败 (exit code: ${code})`,
            });
          }
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({
            success: false,
            output: '',
            error: `命令启动失败: ${err.message}`,
          });
        });
      });
    },
  };
}
