/**
 * Git 操作工具。
 * 提供常用 Git 操作的结构化接口，比通过 run_command 调用更易用。
 * 支持：status、diff、log、add、commit、branch、checkout、stash 等。
 *
 * 参数按引号拆成 argv，再用 execFile 直接启动 git，不经过 cmd.exe / sh。
 * 因此 args 里的 & | > < 不会变成另一条命令。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { augmentPathForShellSpawn, standardWindowsUserToolDirs } from '../shell-spawn-env.js';
import type { RegisteredTool, ToolResult } from '../types.js';

/** 命令执行超时 */
const GIT_TIMEOUT = 30000;

/** 最大输出大小 */
const MAX_OUTPUT = 512 * 1024; // 512KB

const GIT_SUBCOMMANDS = [
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
] as const;

const GIT_SUBCOMMAND_SET = new Set<string>(GIT_SUBCOMMANDS);

export class GitArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitArgParseError';
  }
}

let cachedGitExecutable: string | undefined;

/**
 * 解析 git 可执行文件。
 * Windows 上优先 git.exe。execFile 不能启动 git.cmd，否则会退回 shell。
 */
export function resolveGitExecutable(): string {
  if (cachedGitExecutable) return cachedGitExecutable;
  if (process.platform !== 'win32') {
    cachedGitExecutable = 'git';
    return cachedGitExecutable;
  }

  const dirs = [
    ...augmentPathForShellSpawn(process.env.PATH).split(';'),
    ...standardWindowsUserToolDirs(),
  ];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, 'git.exe');
    if (existsSync(candidate)) {
      cachedGitExecutable = candidate;
      return candidate;
    }
  }

  cachedGitExecutable = 'git';
  return cachedGitExecutable;
}

/**
 * 把工具参数字符串拆成 argv。
 * 支持单引号、双引号，以及双引号内的 \"。
 * 反斜杠其余情况保持原样，避免 Windows 路径被吃掉。
 * 不识别 & | > < ` $() 为语法，它们只是参数内容。
 */
export function splitGitArgs(input: string): string[] {
  if (input.includes('\0')) {
    throw new GitArgParseError('git 参数包含非法空字符');
  }

  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let inToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && input[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inToken) {
        argv.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (quote) {
    throw new GitArgParseError('git 参数引号未闭合');
  }
  if (inToken) argv.push(current);
  return argv;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

/**
 * 直接执行 git，不经过 shell。
 */
function runGit(workDir: string, args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile(resolveGitExecutable(), ['--no-pager', ...args], {
      cwd: workDir,
      timeout: GIT_TIMEOUT,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      encoding: 'utf8',
      shell: false,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_MERGE_AUTOEDIT: 'no',
        LC_ALL: 'C.UTF-8',
      },
    }, (error, stdout, stderr) => {
      const out = text(stdout);
      const errText = text(stderr);
      if (error) {
        resolve({
          success: false,
          output: out,
          error: errText || error.message,
        });
        return;
      }

      let output = out;
      if (errText && !errText.includes('warning:')) {
        output += (output ? '\n' : '') + errText;
      }
      resolve({ success: true, output: output || '(无输出)' });
    });
  });
}

function withDefaultArgs(subcommand: string, args: string): string {
  if (args) return args;
  switch (subcommand) {
    case 'log':
      return '--oneline -20';
    case 'diff':
      return '--no-color';
    case 'status':
      return '--short --branch';
    case 'branch':
      return '-a';
    default:
      return '';
  }
}

/**
 * 创建 Git 操作工具。
 */
export function createGitTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'git',
      // Git 操作。比 run_command 更安全（禁止交互式、force push；参数不经过 shell）。
      description:
        'Execute Git operations. Safer than run_command (blocks interactive prompts and force push; arguments are not passed through a shell). Common subcommands: status, diff, log, add, commit, branch, checkout, stash, push, pull, reset, show. Default `diff` returns unified diff (use args e.g. `--stat` for summary only).',
      parameters: {
        type: 'object',
        properties: {
          subcommand: {
            type: 'string',
            description: 'Git subcommand',
            enum: [...GIT_SUBCOMMANDS],
          },
          args: {
            type: 'string',
            description: 'Subcommand arguments, such as a path for diff or --oneline -10 for log',
            default: '',
          },
        },
        required: ['subcommand'],
      },
    },
    handler: async (handlerArgs) => {
      const subcommand = typeof handlerArgs.subcommand === 'string'
        ? handlerArgs.subcommand.trim()
        : '';
      if (!GIT_SUBCOMMAND_SET.has(subcommand)) {
        const shown = subcommand.replace(/\s+/g, ' ').slice(0, 80);
        return {
          success: false,
          output: '',
          error: `不支持的 git 子命令: ${shown || '(empty)'}`,
        };
      }

      if (handlerArgs.args != null && typeof handlerArgs.args !== 'string') {
        return { success: false, output: '', error: 'args 必须是字符串' };
      }
      const args = typeof handlerArgs.args === 'string' ? handlerArgs.args.trim() : '';

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

      const finalArgs = withDefaultArgs(subcommand, args);
      let argv: string[];
      try {
        argv = [subcommand, ...splitGitArgs(finalArgs)];
      } catch (error) {
        if (error instanceof GitArgParseError) {
          return { success: false, output: '', error: error.message };
        }
        throw error;
      }

      const result = await runGit(workDir, argv);

      // 为输出添加上下文信息
      if (result.success) {
        result.output = `[git ${subcommand}]\n${result.output}`;
      }

      return result;
    },
  };
}
