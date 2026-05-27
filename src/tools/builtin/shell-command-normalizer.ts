/**
 * run_command 命令预处理：提取 leading cd、修正 Windows 路径引号、Unix→Windows 命令映射。
 */

import path from 'node:path';

import { parseLeadingCdCommand } from '../shell-cd-parser.js';

export interface NormalizeRunCommandOptions {
  workDir: string;
}

export interface NormalizedRunCommand {
  command: string;
  cwd: string;
  fixes: string[];
}

/** Windows cmd 下常见 Unix 命令 → 可执行替代。 */
function rewriteUnixCommandsForWindows(command: string): { command: string; fixes: string[] } {
  const fixes: string[] = [];
  let out = command;

  if (/^\s*ls\b/i.test(out)) {
    out = out.replace(/^\s*ls\b/i, 'dir');
    fixes.push('ls→dir');
  }

  if (/\bgrep\s+-r\b/i.test(out)) {
    out = out.replace(/\bgrep\s+-r\b/gi, 'findstr /s /i');
    fixes.push('grep -r→findstr /s /i');
  } else if (/\bgrep\b/i.test(out)) {
    out = out.replace(/\bgrep\b/gi, 'findstr /i');
    fixes.push('grep→findstr /i');
  }

  if (/^\s*rm\s+-rf\b/i.test(out)) {
    out = out.replace(/^\s*rm\s+-rf\b/i, 'rmdir /s /q');
    fixes.push('rm -rf→rmdir /s /q');
  }

  return { command: out, fixes };
}

export function normalizeRunCommand(
  rawCommand: string,
  options: NormalizeRunCommandOptions,
): NormalizedRunCommand {
  const workDir = path.resolve(options.workDir);
  const trimmed = rawCommand.trim();
  if (!trimmed) {
    return { command: trimmed, cwd: workDir, fixes: [] };
  }

  const parsed = parseLeadingCdCommand(trimmed);
  if (!parsed) {
    if (process.platform === 'win32') {
      const win = rewriteUnixCommandsForWindows(trimmed);
      return { command: win.command, cwd: workDir, fixes: win.fixes };
    }
    return { command: trimmed, cwd: workDir, fixes: [] };
  }

  const fixes: string[] = [];
  if (parsed.quotedPath) {
    fixes.push('removed quotes from cd path');
  }
  fixes.push(`extracted cd → cwd=${parsed.cdPath}`);

  let remainder = parsed.remainder;
  if (process.platform === 'win32') {
    const win = rewriteUnixCommandsForWindows(remainder);
    remainder = win.command;
    fixes.push(...win.fixes);
  }

  return {
    command: remainder,
    cwd: path.resolve(parsed.cdPath),
    fixes,
  };
}

export function formatNormalizedCommandOutput(fixes: string[], output: string): string {
  if (fixes.length === 0) return output;
  return `[auto-fix] ${fixes.join('; ')}\n\n${output}`;
}
