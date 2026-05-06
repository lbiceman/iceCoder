/**
 * Markdown 解析工具（共享模块）。
 *
 * 从 memory-fact-index.ts / harness-memory.ts / memory-scanner.ts 中统一抽取。
 */

/**
 * 从 Markdown 文件内容中提取正文（跳过 frontmatter）。
 *
 * 去除空行、纯格式行（--- 分隔线、* 时间戳行）。
 *
 * @param content - Markdown 文件完整内容
 * @param options - 解析选项
 * @param options.keepTimestampLines - 是否保留时间戳行（默认 false）
 */
export function extractBodyFromMarkdown(
  content: string,
  options: { keepTimestampLines?: boolean } = {},
): string {
  const { keepTimestampLines = false } = options;
  const lines = content.split('\n');
  let bodyStart = 0;

  // 跳过 frontmatter（--- ... ---）
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
    }
  }

  return lines.slice(bodyStart)
    .map(l => l.trim())
    .filter(l =>
      l.length > 0 &&
      l !== '---' &&
      (keepTimestampLines || (
        !l.startsWith('*Extracted:') &&
        !l.startsWith('*Updated:') &&
        !l.startsWith('*保存时间:')
      )),
    )
    .join('\n');
}
