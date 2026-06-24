/**
 * Shell 沙箱 — 运行时拦截（不进系统提示词）。
 * 1. 防自杀：误杀 iceCoder 宿主 node 进程
 * 2. 黑名单：config.json 可配的 shell 命令模式
 */

import { readFileSync } from 'node:fs';
import { analyzeShellHostSafety } from './shell-host-guard.js';
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

export interface ShellSandboxResult {
  blocked: boolean;
  message?: string;
  matchLabel?: string;
  reason?: 'host_kill' | 'blacklist';
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
  for (const re of patterns) {
    if (re.test(command)) {
      return { matched: true, pattern: re.source };
    }
  }
  return { matched: false };
}

/**
 * 分析 run_command 是否应被沙箱拦截。
 */
export function analyzeShellSandbox(
  command: string,
  options?: { workDir?: string; configPath?: string },
): ShellSandboxResult {
  const trimmed = command.trim();
  if (!trimmed) return { blocked: false };

  const hostResult = analyzeShellHostSafety(trimmed, { workDir: options?.workDir });
  if (hostResult.blocked) {
    return {
      blocked: true,
      reason: 'host_kill',
      matchLabel: hostResult.matchLabel,
      message: hostResult.message,
    };
  }

  const blacklist = findShellBlacklistMatch(trimmed, options?.configPath);
  if (blacklist.matched) {
    return {
      blocked: true,
      reason: 'blacklist',
      matchLabel: blacklist.pattern,
      message: `[Sandbox / Blocked] Command matches shell blacklist (${blacklist.pattern}).`,
    };
  }

  return { blocked: false };
}
