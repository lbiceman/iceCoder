/**
 * 解析命令开头的 `cd [/d] path && remainder`，供 shell normalizer 与 workspace guard 共用。
 */

/** 命令开头的 `cd ... &&` / `cd ... ;`（含 Windows `cd /d`） */
export const LEADING_CD_RE =
  /^\s*cd\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s&;]+))\s*(?:&&|;)\s*(.+)$/s;

export interface ParsedLeadingCd {
  cdPath: string;
  remainder: string;
  /** cd 路径是否来自引号包裹 */
  quotedPath: boolean;
}

/** 若命令以 leading cd 开头则解析；否则 undefined。 */
export function parseLeadingCdCommand(rawCommand: string): ParsedLeadingCd | undefined {
  const match = LEADING_CD_RE.exec(rawCommand.trim());
  if (!match) return undefined;

  const cdPath = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  const remainder = match[4]?.trim() ?? '';
  if (!cdPath || !remainder) return undefined;

  return {
    cdPath,
    remainder,
    quotedPath: !!(match[1] || match[2]),
  };
}
