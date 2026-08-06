/**
 * Shell 协作模式 — 可配置敏感命令分类与组合/嵌套解析。
 *
 * 命中设置 shellBlacklist 正则 → shellMandatoryConfirm；未命中返回 null。
 * hard block / 宿主保护由 shell-sandbox 独立处理。
 *
 * @see docs/requirement/shell-交互协管-slash-shell.md §8.1.2
 */

import { createHash } from 'node:crypto';
import {
  readShellBlacklistPatternsSync,
  resetShellBlacklistCache,
  resolveShellBlacklistPatterns,
} from './shell-sandbox.js';
import {
  collectExpandedShellCommands,
  splitShellCommandSegments,
} from './shell-command-parser.js';

export type ShellCollabCommandRiskLevel = 'mandatory_confirm';

export interface ShellCollabCommandRisk {
  risk: ShellCollabCommandRiskLevel;
  category: string;
  normalized: string;
  matchedPattern: string;
  impact: string;
}

const CATEGORY_BY_PATTERN_PREFIX: ReadonlyArray<{
  test: (source: string) => boolean;
  category: string;
  impact: string;
}> = [
  {
    test: s => /rm\\s|rmdir|del\\s|erase\\s/i.test(s),
    category: '递归/强制删除',
    impact: '可能不可逆地删除大量文件或目录',
  },
  {
    test: s => /shutdown|reboot|halt|poweroff/i.test(s),
    category: '系统电源',
    impact: '可能中断整机与当前 Shell 会话',
  },
  {
    test: s => /mkfs|dd\\s|diskpart|fdisk|format/i.test(s),
    category: '磁盘/文件系统',
    impact: '可能破坏磁盘或分区，数据通常难以恢复',
  },
  {
    test: s => /git\\s/i.test(s),
    category: 'Git 破坏性操作',
    impact: '可能覆盖远端历史或删除本地未提交更改',
  },
  {
    test: s => /dropdb|DROP\\s/i.test(s),
    category: '数据库破坏性操作',
    impact: '可能不可逆地删除数据库或表',
  },
];

const DEFAULT_CATEGORY = 'Shell 强制确认规则';
const DEFAULT_IMPACT = '该命令可能产生高风险或不可逆影响，执行前需人工确认';

function inferCategory(matchedPattern: string): { category: string; impact: string } {
  for (const entry of CATEGORY_BY_PATTERN_PREFIX) {
    if (entry.test(matchedPattern)) {
      return { category: entry.category, impact: entry.impact };
    }
  }
  return { category: DEFAULT_CATEGORY, impact: DEFAULT_IMPACT };
}

/** 归一化空白与大小写，用于哈希与匹配辅助。 */
export function normalizeShellCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** normalizedCommandHash（sessionId + taskId + 此值 单次授权）。 */
export function hashNormalizedShellCommand(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/**
 * 兼容旧调用名；实现由共享 shell-command-parser 提供。
 */
export function splitCompoundShellCommands(input: string): string[] {
  return splitShellCommandSegments(input);
}

/** 从 `bash -c` / `cmd /c` / `powershell -Command` 提取内层命令并递归展开。 */
export function extractNestedShellCommands(segment: string): string[] {
  return collectShellCommandSegments(segment);
}

/** 组合拆分 + 嵌套展开（BFS），返回待匹配的子命令列表。 */
export function collectShellCommandSegments(command: string): string[] {
  return collectExpandedShellCommands(command);
}

function matchConfigurablePattern(
  segment: string,
  patterns: RegExp[],
): { matchedPattern: string } | null {
  for (const re of patterns) {
    if (re.test(segment)) {
      return { matchedPattern: re.source };
    }
  }
  return null;
}

/**
 * 对整条命令（含组合/嵌套）做风险分类。
 * 仅当命中配置 shellBlacklist 正则时返回风险对象；否则 null。
 */
export function classifyShellCollabCommandRisk(
  command: string,
  options?: { configPath?: string; patterns?: RegExp[] },
): ShellCollabCommandRisk | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const patterns = options?.patterns
    ?? readShellBlacklistPatternsSync(options?.configPath);
  if (patterns.length === 0) return null;

  const normalized = normalizeShellCommand(trimmed);
  const segments = collectShellCommandSegments(trimmed);

  for (const segment of segments) {
    const hit = matchConfigurablePattern(segment, patterns);
    if (hit) {
      const { category, impact } = inferCategory(hit.matchedPattern);
      return {
        risk: 'mandatory_confirm',
        category,
        normalized,
        matchedPattern: hit.matchedPattern,
        impact,
      };
    }
  }

  return null;
}

/** 对展示用命令脱敏 token/password/secret 参数。 */
export function redactShellCommandForDisplay(command: string): string {
  return command
    .replace(
      /((?:^|\s)(?:--?(?:password|pass|token|secret|api[_-]?key))(?:\s|=|:))(\S+)/gi,
      '$1[redacted]',
    )
    .replace(
      /((?:^|\s)(?:password|passwd|token|secret)\s*=\s*)(\S+)/gi,
      '$1[redacted]',
    );
}

/** 测试或配置热更新后重置黑名单缓存（转发 shell-sandbox）。 */
export function resetShellCollabCommandRiskCache(): void {
  resetShellBlacklistCache();
}

/** 解析配置中的 shellBlacklist 字符串列表（测试用）。 */
export function resolveShellCollabConfirmPatterns(value: unknown): string[] {
  return resolveShellBlacklistPatterns(value);
}
