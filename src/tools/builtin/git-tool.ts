/**
 * Git 操作工具。
 * 提供常用 Git 操作的结构化接口，比通过 run_command 调用更易用。
 * 支持：status、diff、log、add、commit、branch、checkout、stash 等。
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RegisteredTool } from '../types.js';

const execAsync = promisify(exec);

/** 命令执行超时 */
const GIT_TIMEOUT = 30000;

/** 最大输出大小 */
const MAX_OUTPUT = 512 * 1024; // 512KB

/**
 * 执行 git 命令的辅助函数。
 */
async function runGit(
  workDir: string,
  args: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const { stdout, stderr } = await execAsync(`git ${args}`, {
      cwd: workDir,
      timeout: GIT_TIMEOUT,
      maxBuffer: MAX_OUTPUT,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // 禁止交互式提示
        LC_ALL: 'C.UTF-8',
      },
    });

    let output = stdout || '';
    if (stderr && !stderr.includes('warning:')) {
      output += (output ? '\n' : '') + stderr;
    }

    return { success: true, output: output || '(无输出)' };
  } catch (error: any) {
    const stderr = error.stderr || '';
    const stdout = error.stdout || '';
    const message = error.message || String(error);

    return {
      success: false,
      output: stdout,
      error: stderr || message,
    };
  }
}

/**
 * 创建 Git 操作工具。
 */
export function createGitTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'git',
      description:
        '执行 Git 操作。支持常用子命令：status、diff、log、add、commit、branch、checkout、stash、push、pull、reset、show 等。比 run_command 更安全（禁止交互式操作）。',
      parameters: {
        type: 'object',
        properties: {
          subcommand: {
            type: 'string',
            description: 'Git 子命令',
            enum: [
              'status',
              'diff',
              'log',
              'add',
              'commit',
              'branch',
              'checkout',
              'switch',
              'stash',
              'push',
              'pull',
              'fetch',
              'reset',
              'show',
              'blame',
              'tag',
              'remote',
              'merge',
              'rebase',
              'cherry-pick',
              'rev-parse',
              'config',
            ],
          },
          args: {
            type: 'string',
            description: '子命令的参数（如 diff 的文件路径、log 的 --oneline -10 等）',
            default: '',
          },
        },
        required: ['subcommand'],
      },
    },
    handler: async (handlerArgs) => {
      const subcommand = handlerArgs.subcommand as string;
      const args = (handlerArgs.args as string) || '';

      // 安全检查：禁止危险操作
      const fullCmd = `${subcommand} ${args}`.toLowerCase();

      // 禁止交互式操作
      if (fullCmd.includes('-i') && (subcommand === 'rebase' || subcommand === 'add')) {
        return {
          success: false,
          output: '',
          error: '不支持交互式操作（-i 参数）。请使用非交互式方式。',
        };
      }

      // 禁止 force push（除非明确指定）
      if (subcommand === 'push' && (args.includes('--force') || args.includes('-f')) && !args.includes('--force-with-lease')) {
        return {
          success: false,
          output: '',
          error: '禁止 force push。如需强制推送，请使用 --force-with-lease 代替。',
        };
      }

      // 为常用命令添加默认参数
      let finalArgs = args;
      if (subcommand === 'log' && !args) {
        finalArgs = '--oneline -20';
      } else if (subcommand === 'diff' && !args) {
        finalArgs = '--stat';
      } else if (subcommand === 'status' && !args) {
        finalArgs = '--short --branch';
      } else if (subcommand === 'branch' && !args) {
        finalArgs = '-a';
      }

      const result = await runGit(workDir, `${subcommand} ${finalArgs}`.trim());

      // 为输出添加上下文信息
      if (result.success) {
        result.output = `[git ${subcommand}]\n${result.output}`;
      }

      return result;
    },
  };
}
