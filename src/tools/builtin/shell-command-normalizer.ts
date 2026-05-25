/**
 * run_command 命令预处理：提取 leading cd、修正 Windows 路径引号等。
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
    return { command: trimmed, cwd: workDir, fixes: [] };
  }

  const fixes: string[] = [];
  if (parsed.quotedPath) {
    fixes.push('removed quotes from cd path');
  }
  fixes.push(`extracted cd → cwd=${parsed.cdPath}`);

  return {
    command: parsed.remainder,
    cwd: path.resolve(parsed.cdPath),
    fixes,
  };
}

export function formatNormalizedCommandOutput(fixes: string[], output: string): string {
  if (fixes.length === 0) return output;
  return `[auto-fix] ${fixes.join('; ')}\n\n${output}`;
}
