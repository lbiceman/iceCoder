/**
 * read_file 分页：只按连续行范围裁剪，绝不头尾挖空中段。
 *
 * 超出 token 上限时返回从起始行开始、能放进上限的一页，
 * 头部写明已读范围、未读范围和下一页的 offset/limit，模型可据此继续读。
 */

import { estimateStringTokens } from '../llm/token-estimator.js';

export interface ReadFileRange {
  /** 调用方传入的路径（未归一化） */
  path: string;
  startLine: number;
  endLine: number;
  /** 本次请求的末行（整文件读取即 totalLines）；大于 endLine 表示后面还有未返回的行 */
  requestedEnd: number;
  totalLines: number;
  /** 正文是否为 `N: line` 编号格式（整文件原文直出时为 false） */
  numbered: boolean;
  /** 编号格式下正文前的头部行数 */
  headerLines: number;
  /** 因 token 上限只返回了请求范围的一部分 */
  capped: boolean;
}

const RULE = '─'.repeat(40);

/** 单行超过此字符数时，在分页视图里截断该行（极长压缩行不让一行吃掉整页） */
const MAX_PAGE_LINE_CHARS = 4_000;

function numberedLine(lineNo: number, text: string): string {
  if (text.length <= MAX_PAGE_LINE_CHARS) return `${lineNo}: ${text}`;
  return `${lineNo}: ${text.slice(0, MAX_PAGE_LINE_CHARS)} …[line truncated, ${text.length} chars]`;
}

/** 从 startLine 起，有多少行的编号正文能放进 capTokens（至少 1 行） */
export function linesFittingTokens(
  allLines: string[],
  startLine: number,
  capTokens: number,
): number {
  let used = 0;
  let count = 0;
  for (let i = startLine - 1; i < allLines.length; i++) {
    const cost = estimateStringTokens(numberedLine(i + 1, allLines[i] ?? '')) + 1;
    if (count > 0 && used + cost > capTokens) break;
    used += cost;
    count++;
    if (used >= capTokens) break;
  }
  return Math.max(1, count);
}

/** 显式范围读取的头部（与历史格式一致） */
export function formatReadFileRange(
  path: string,
  allLines: string[],
  startLine: number,
  endLine: number,
): { output: string; range: ReadFileRange } {
  const body = allLines
    .slice(startLine - 1, endLine)
    .map((line, idx) => numberedLine(startLine + idx, line))
    .join('\n');
  return {
    output: `${path} (lines ${startLine}-${endLine}, total ${allLines.length})\n${RULE}\n${body}`,
    range: {
      path,
      startLine,
      endLine,
      requestedEnd: endLine,
      totalLines: allLines.length,
      numbered: true,
      headerLines: 2,
      capped: false,
    },
  };
}

/**
 * 因 token 上限分页：返回 [startLine, startLine + fit) 并给出续读指引。
 * requestedEnd 为原请求的末行（整文件读取即 totalLines）；
 * availableEnd 为 allLines 中实际有内容的末行（重新分页时只有已返回的行可用）。
 */
export function formatReadFileCappedPage(
  path: string,
  allLines: string[],
  startLine: number,
  requestedEnd: number,
  capTokens: number,
  availableEnd: number = requestedEnd,
): { output: string; range: ReadFileRange } {
  const totalLines = allLines.length;
  const headerBudget = 120;
  const fit = linesFittingTokens(allLines, startLine, Math.max(200, capTokens - headerBudget));
  const endLine = Math.min(requestedEnd, availableEnd, startLine + fit - 1);
  const body = allLines
    .slice(startLine - 1, endLine)
    .map((line, idx) => numberedLine(startLine + idx, line))
    .join('\n');
  const pageSize = endLine - startLine + 1;
  const unread: string[] = [];
  if (startLine > 1) unread.push(`1-${startLine - 1}`);
  if (endLine < totalLines) unread.push(`${endLine + 1}-${totalLines}`);
  const next = endLine < requestedEnd
    ? `Next: read_file offset=${endLine + 1} limit=${Math.min(pageSize, requestedEnd - endLine)}`
    : '';
  const header = [
    `${path} (lines ${startLine}-${endLine} of ${totalLines}, PARTIAL — read cap ${capTokens} tokens)`,
    `Unread: lines ${unread.join(', ') || 'none'}. Content beyond the shown lines exists; do not assume it is absent.${next ? ` ${next}` : ''}`,
    RULE,
  ];
  return {
    output: `${header.join('\n')}\n${body}`,
    range: {
      path,
      startLine,
      endLine,
      requestedEnd,
      totalLines,
      numbered: true,
      headerLines: header.length,
      capped: true,
    },
  };
}

/** 从 read_file 输出还原所返回的原始行（去掉头部与 `N: ` 编号） */
export function readFileOutputLines(output: string, range: ReadFileRange): string[] {
  const lines = output.split('\n');
  if (!range.numbered) return lines;
  return lines
    .slice(range.headerLines)
    .map((line, idx) => {
      const prefix = `${range.startLine + idx}: `;
      return line.startsWith(prefix) ? line.slice(prefix.length) : line;
    });
}

/**
 * 已返回的 read_file 结果超出 capTokens 时，在同一范围内按连续行重新分页。
 * 未超出返回 null。
 */
export function repageReadFileOutput(
  output: string,
  range: ReadFileRange,
  capTokens: number,
): { output: string; range: ReadFileRange } | null {
  if (estimateStringTokens(output) <= capTokens) return null;
  const returned = readFileOutputLines(output, range);
  const allLines: string[] = new Array(range.totalLines).fill('');
  for (let i = 0; i < returned.length; i++) {
    const at = range.startLine - 1 + i;
    if (at < allLines.length) allLines[at] = returned[i] ?? '';
  }
  return formatReadFileCappedPage(
    range.path,
    allLines,
    range.startLine,
    range.requestedEnd,
    capTokens,
    range.endLine,
  );
}
