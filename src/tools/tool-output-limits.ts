/**
 * 工具输出与读文件软上限（减轻主上下文膨胀）。
 * 可用 ICE_MAX_TOOL_OUTPUT_CHARS、ICE_READ_FILE_MAX_TOKENS、DOC_PARSE 相关 env 调节。
 *
 * 文件读取 / 命令 / 搜索 / 网页按 token 计，并随上下文窗口档位放大；
 * Codex 单条约 10k tokens 只是 L/XL 档的参照，不是固定值。
 */

import { getContextWindowTier, type ContextWindowTier } from '../harness/context-window-tier.js';

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Harness 注入 tool 消息的字符上限（与各工具元数据上限取 min） */
export function getMaxToolOutputChars(): number {
  const raw = process.env.ICE_MAX_TOOL_OUTPUT_CHARS;
  if (raw === undefined || raw === '') return 24_000;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return 24_000;
  return clamp(n, 8_000, 200_000);
}

/**
 * 失败 run_command 写入 LLM 的字符预算（头尾保留，不是行数）。
 *
 * 对齐 Claude Code ~30k 中段裁剪、Codex ~10k tokens、OpenCode bash 默认 50KB 尾部。
 * 3000 字符只够几十行，会裁掉测试/编译栈。至少 48k；用户把 ICE_MAX_TOOL_OUTPUT_CHARS
 * 调更高时跟随，上限 200k。
 */
export function getFailedRunCommandInlineChars(): number {
  return clamp(Math.max(getMaxToolOutputChars(), 48_000), 24_000, 200_000);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** 按 token 计上限的工具类别；其余工具仍走 {@link getMaxToolOutputChars} 字符上限 */
export type ToolTokenBudgetClass = 'file_read' | 'command' | 'search' | 'web';

const TOOL_TOKEN_CAPS: Record<ToolTokenBudgetClass, Record<ContextWindowTier, number>> = {
  file_read: { S: 8_000, M: 12_000, L: 20_000, XL: 20_000 },
  command: { S: 6_000, M: 8_000, L: 10_000, XL: 10_000 },
  search: { S: 5_000, M: 5_000, L: 5_000, XL: 5_000 },
  web: { S: 10_000, M: 10_000, L: 10_000, XL: 10_000 },
};

/** 单条工具结果注入上下文的 token 上限（未考虑剩余上下文；余量保护见 harness/tool-result-budget） */
export function getToolTokenCap(
  cls: ToolTokenBudgetClass,
  tier: ContextWindowTier = getContextWindowTier(),
): number {
  if (cls === 'file_read') {
    const override = intEnv('ICE_READ_FILE_MAX_TOKENS', 0);
    if (override > 0) return clamp(override, 1_000, 200_000);
  }
  return TOOL_TOKEN_CAPS[cls][tier];
}

/** read_file 单次返回的 token 上限 */
export function getReadFileMaxTokens(): number {
  return getToolTokenCap('file_read');
}

/** 文档解析等纯文本直读路径的单次软字符上限 */
export function getDocParseTextMaxChars(): number {
  return clamp(intEnv('ICE_DOC_PARSE_TEXT_MAX_CHARS', 16_000), 2_000, 200_000);
}

/** write_file 正文超过此字符数时返回警告（仍写入） */
export function getWriteFileWarnChars(): number {
  return clamp(intEnv('ICE_WRITE_FILE_WARN_CHARS', 10_000), 2_000, 100_000);
}

/** write_file 正文超过此行数时返回警告（仍写入） */
export function getWriteFileWarnLines(): number {
  return clamp(intEnv('ICE_WRITE_FILE_WARN_LINES', 150), 50, 2_000);
}

/** write_file 正文超过此字符数时拒绝写入（防单次输出顶满导致不完整大文件） */
export function getWriteFileBlockChars(): number {
  return clamp(intEnv('ICE_WRITE_FILE_BLOCK_CHARS', 22_000), 5_000, 500_000);
}

/** test marker */
