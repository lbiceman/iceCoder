/**
 * 工具输出与读文件软上限（减轻主上下文膨胀）。
 * 可用 ICE_MAX_TOOL_OUTPUT_CHARS、READ_FILE / DOC_PARSE 相关 env 调节。
 */

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

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** read_file 无 offset/limit 时最多返回的行数 */
export function getReadFileDefaultMaxLines(): number {
  return clamp(intEnv('ICE_READ_FILE_MAX_LINES', 420), 50, 5_000);
}

/** read_file 无 offset/limit 时正文软字符上限（与行数上限同时生效） */
export function getReadFileDefaultMaxChars(): number {
  return clamp(intEnv('ICE_READ_FILE_MAX_CHARS', 18_000), 2_000, 500_000);
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
