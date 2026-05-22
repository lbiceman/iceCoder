/**
 * run_command 命令预处理：提取 leading cd、修正 Windows 路径引号等。
 */

import path from 'node:path';

/** 命令开头的 `cd ... &&` / `cd ... ;` */
const LEADING_CD_RE =
  /^\s*cd\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s&;]+))\s*(?:&&|;)\s*(.+)$/s;

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

  const match = LEADING_CD_RE.exec(trimmed);
  if (!match) {
    return { command: trimmed, cwd: workDir, fixes: [] };
  }

  const cdPath = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  const remainder = match[4]?.trim() ?? '';
  if (!cdPath || !remainder) {
    return { command: trimmed, cwd: workDir, fixes: [] };
  }

  const fixes: string[] = [];
  if (match[1] || match[2]) {
    fixes.push('removed quotes from cd path');
  }
  fixes.push(`extracted cd → cwd=${cdPath}`);

  return {
    command: remainder,
    cwd: path.resolve(cdPath),
    fixes,
  };
}

export function formatNormalizedCommandOutput(fixes: string[], output: string): string {
  if (fixes.length === 0) return output;
  return `[auto-fix] ${fixes.join('; ')}\n\n${output}`;
}
