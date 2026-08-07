/**
 * Shell 沙箱 — 运行时拦截（不进系统提示词）。
 * 1. 防自杀：误杀 iceCoder 宿主 node 进程
 * 2. 黑名单：config.json 可配的 shell 命令模式
 */

import { readFileSync } from 'node:fs';
import { analyzeShellHostSafety } from './shell-host-guard.js';
import { collectExpandedShellCommands } from './shell-command-parser.js';
import { resolveMainConfigPath } from '../config/main-config-supervisor-mode.js';
import type { IceCoderConfigFile } from '../web/types.js';

/** 内置黑名单（字符串正则，不含首尾斜杠）；与 data/config.example.json 保持一致 */
export const DEFAULT_SHELL_BLACKLIST_PATTERNS: string[] = [
  'rm\\s+-rf',
  'rm\\s+-fr',
  'rmdir\\s+/s',
  'rd\\s+/s',
  'format\\s+[a-z]:',
  '\\bmkfs\\b',
  'dd\\s+if=',
  ':>\\s*/etc/',
  '\\bshutdown\\b',
  '\\breboot\\b',
  '\\bhalt\\b',
  '\\bpoweroff\\b',
  'git\\s+push\\s+.*(-f|--force)',
  'git\\s+reset\\s+--hard',
  'git\\s+clean\\s+.*-f',
  '\\bdel\\s+/[fq]',
  '\\berase\\s+/[fq]',
  '\\bdiskpart\\b',
  '\\bfdisk\\b',
  '\\bdropdb\\b',
  'DROP\\s+(TABLE|DATABASE)',
];

/**
 * 不受 shellBlacklist 配置影响的灾难性命令。
 *
 * 这里只放“任何场景都不应由协管 PTY 执行”的最小集合；其余高风险命令由
 * shellMandatoryConfirm 处理。模式允许 sudo、组合短参数及 `--` 参数终止符。
 */
export const SHELL_HARD_BLOCK_PATTERNS: ReadonlyArray<{
  label: string;
  re: RegExp;
}> = [
  {
    label: 'rm_recursive_force_root',
    re: /(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+(?=[^;&|\r\n]*?(?:-(?!-)[^\s;&|]*r[^\s;&|]*|--recursive)(?:\s|$))(?=[^;&|\r\n]*?(?:-(?!-)[^\s;&|]*f[^\s;&|]*|--force)(?:\s|$))(?:--?[^\s;&|]+\s+)*(?:--\s+)?["']?\/(?:\*+)?["']?(?=\s*(?:$|[;&|\r\n]))/i,
  },
  {
    label: 'format_drive',
    re: /(?:^|[;&|]\s*)format(?:\.com)?\s+[a-z]:(?:\s|$)/i,
  },
];

export interface ShellSandboxResult {
  blocked: boolean;
  message?: string;
  matchLabel?: string;
  reason?: 'hard_block' | 'host_kill' | 'blacklist';
}

let cachedPatterns: RegExp[] | null = null;
let cachedConfigPath: string | null = null;

function compileShellBlacklistPatterns(raw: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of raw) {
    if (!pattern.trim()) continue;
    try {
      compiled.push(new RegExp(pattern, 'i'));
    } catch {
      // 无效正则跳过
    }
  }
  return compiled;
}

export function resolveShellBlacklistPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SHELL_BLACKLIST_PATTERNS];
  if (value.length === 0) return [];
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  return strings.length > 0 ? strings : [...DEFAULT_SHELL_BLACKLIST_PATTERNS];
}

/** 校验 shell 黑名单正则；首个无效项返回错误文案，全部合法返回 null。 */
export function validateShellBlacklistPatterns(patterns: string[]): string | null {
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    try {
      new RegExp(trimmed, 'i');
    } catch {
      return `无效的正则表达式：${trimmed}`;
    }
  }
  return null;
}

export function readShellBlacklistPatternsSync(
  configPath: string = resolveMainConfigPath(),
): RegExp[] {
  if (cachedPatterns && cachedConfigPath === configPath) {
    return cachedPatterns;
  }
  let patterns = DEFAULT_SHELL_BLACKLIST_PATTERNS;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as IceCoderConfigFile;
    patterns = resolveShellBlacklistPatterns(parsed.shellBlacklist);
  } catch {
    // 缺失或不可读 → 内置默认
  }
  cachedPatterns = compileShellBlacklistPatterns(patterns);
  cachedConfigPath = configPath;
  return cachedPatterns;
}

/** 测试或配置热更新后重置缓存 */
export function resetShellBlacklistCache(): void {
  cachedPatterns = null;
  cachedConfigPath = null;
}

export function findShellBlacklistMatch(
  command: string,
  configPath?: string,
): { matched: boolean; pattern?: string } {
  const patterns = readShellBlacklistPatternsSync(configPath ?? resolveMainConfigPath());
  for (const segment of collectExpandedShellCommands(command)) {
    for (const re of patterns) {
      if (re.test(segment)) {
        return { matched: true, pattern: re.source };
      }
    }
  }
  return { matched: false };
}

/** 去掉成对分组括号，避免 `(rm -rf /)` 一类包装绕过锚定 hard block。 */
function unwrapShellGrouping(segment: string): string {
  let current = segment.trim();
  for (let i = 0; i < 4; i++) {
    if (
      (current.startsWith('(') && current.endsWith(')'))
      || (current.startsWith('{') && current.endsWith('}'))
      || (current.startsWith('[') && current.endsWith(']'))
    ) {
      current = current.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return current.replace(/^[(\[{]+\s*/, '');
}

export function findShellHardBlockMatch(
  command: string,
): { matched: boolean; label?: string } {
  for (const segment of collectExpandedShellCommands(command)) {
    const candidates = [segment, unwrapShellGrouping(segment)];
    for (const candidate of candidates) {
      for (const pattern of SHELL_HARD_BLOCK_PATTERNS) {
        if (pattern.re.test(candidate)) {
          return { matched: true, label: pattern.label };
        }
      }
    }
  }
  return { matched: false };
}

/**
 * 分析 run_command 是否应被沙箱拦截。
 */
export function analyzeShellSandbox(
  command: string,
  options?: { workDir?: string; configPath?: string; includeBlacklist?: boolean },
): ShellSandboxResult {
  const trimmed = command.trim();
  if (!trimmed) return { blocked: false };

  // hard block 必须先于可配置黑名单，且不能被 shellBlacklist: [] 关闭。
  const hardBlock = findShellHardBlockMatch(trimmed);
  if (hardBlock.matched) {
    return {
      blocked: true,
      reason: 'hard_block',
      matchLabel: hardBlock.label,
      message: `[Sandbox / Hard Block] Catastrophic command rejected (${hardBlock.label}).`,
    };
  }

  for (const segment of collectExpandedShellCommands(trimmed)) {
    const hostResult = analyzeShellHostSafety(segment, { workDir: options?.workDir });
    if (hostResult.blocked) {
      return {
        blocked: true,
        reason: 'host_kill',
        matchLabel: hostResult.matchLabel,
        message: hostResult.message,
      };
    }
  }

  if (options?.includeBlacklist !== false) {
    const blacklist = findShellBlacklistMatch(trimmed, options?.configPath);
    if (blacklist.matched) {
      return {
        blocked: true,
        reason: 'blacklist',
        matchLabel: blacklist.pattern,
        message: `[Sandbox / Blocked] Command matches shell blacklist (${blacklist.pattern}).`,
      };
    }
  }

  return { blocked: false };
}
