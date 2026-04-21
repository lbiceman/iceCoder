/**
 * Shell 命令执行工具。
 * 提供在受限环境中执行 shell 命令的能力。
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RegisteredTool } from '../types.js';

const execAsync = promisify(exec);

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
    handler: async (args) => {
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

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workDir,
          timeout,
          maxBuffer: MAX_OUTPUT_SIZE,
          env: { ...process.env, NODE_ENV: 'production' },
        });

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + stderr;

        return {
          success: true,
          output: output || '命令执行成功（无输出）',
        };
      } catch (error: any) {
        const message = error.message || String(error);
        const stdout = error.stdout || '';
        const stderr = error.stderr || '';

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n\n[stderr]\n' : '[stderr]\n') + stderr;

        if (error.killed) {
          return {
            success: false,
            output,
            error: `命令执行超时 (${timeout}ms)`,
          };
        }

        return {
          success: false,
          output,
          error: `命令执行失败 (exit code: ${error.code}): ${message}`,
        };
      }
    },
  };
}
