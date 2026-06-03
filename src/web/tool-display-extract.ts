/**
 * 从工具参数 / 输出中提取可用于 UI diff 展示的 unified diff 文本。
 * 浏览器端 mirror：src/public/js/diff-viewer.js extractUnifiedDiff（须保持语义一致）
 */

const TOOL_PREFIX_RE = /^\[[^\]]+\]\n?/;

/** 是否含 unified diff / patch hunk 变更行 */
export function looksLikeUnifiedDiffText(text: string | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  const cleaned = text.replace(TOOL_PREFIX_RE, '');
  if (/^(?:diff --git |--- )/m.test(cleaned)) return true;
  if (/^@@\s/m.test(cleaned) && /^(?:\+(?!\+)|-(?!-))/m.test(cleaned)) return true;
  return false;
}

export function extractUnifiedDiffFromText(text: string | undefined): string | null {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(TOOL_PREFIX_RE, '');

  const headerStart = cleaned.search(/^(?:diff --git |--- )/m);
  if (headerStart >= 0) {
    const slice = cleaned.slice(headerStart);
    if (/^@@\s/m.test(slice) || /^(?:\+(?!\+)|-(?!-))/m.test(slice)) return slice;
  }

  const hunkStart = cleaned.search(/^@@\s/m);
  if (hunkStart >= 0) {
    const slice = cleaned.slice(hunkStart);
    if (/^(?:\+(?!\+)|-(?!-))/m.test(slice)) return slice;
  }

  return null;
}

export function extractDiffSourceFromToolArgs(
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): string | null {
  if (!toolArgs) return null;
  if (toolName === 'patch_file') {
    const patch = toolArgs.patch;
    if (typeof patch === 'string' && /^@@\s/m.test(patch)) return patch;
  }
  return null;
}

export function extractDiffSource(
  toolName: string,
  toolOutput: string | undefined,
  toolArgs?: Record<string, unknown>,
): string | null {
  const fromArgs = extractDiffSourceFromToolArgs(toolName, toolArgs);
  if (fromArgs) return fromArgs;
  if (!toolOutput) return null;
  return extractUnifiedDiffFromText(toolOutput);
}

/** @deprecated 使用 extractDiffSource(toolName, toolOutput, toolArgs) */
export function resolveDiffSource(
  toolOutput: string | undefined,
  toolArgs: Record<string, unknown> | undefined,
  toolName: string,
): string | null {
  return extractDiffSource(toolName, toolOutput, toolArgs);
}
