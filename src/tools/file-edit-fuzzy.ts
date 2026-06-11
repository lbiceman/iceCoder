/**
 * edit_file 模糊匹配：精确 → 归一化空白 → 按行 trim 对齐。
 */

export interface ReplaceRange {
  start: number;
  end: number;
  matched: string;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** 逐行去掉行尾空白，保留行结构。 */
function normalizeTrailingWhitespace(text: string): string {
  return normalizeLineEndings(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
}

function findNormalizedBlock(content: string, search: string): ReplaceRange | null {
  const normContent = normalizeTrailingWhitespace(content);
  const normSearch = normalizeTrailingWhitespace(search);
  if (!normSearch) return null;

  const idx = normContent.indexOf(normSearch);
  if (idx === -1) return null;

  // 映射归一化索引回原 content（按字符扫描，跳过 \r 差异）
  let normPos = 0;
  let start = -1;
  let end = -1;
  const targetStart = idx;
  const targetEnd = idx + normSearch.length;

  for (let i = 0; i <= content.length && (start === -1 || end === -1); ) {
    if (content.startsWith('\r\n', i)) {
      if (normPos === targetStart) start = i;
      normPos += 1;
      i += 2;
      if (normPos === targetEnd) end = i;
      continue;
    }
    const ch = content[i] ?? '';
    const normCh = ch === '\r' ? '' : ch;
    if (normCh) {
      if (normPos === targetStart) start = i;
      normPos += 1;
      if (normPos === targetEnd) {
        end = i + 1;
        break;
      }
    }
    i += 1;
  }

  if (start === -1 || end === -1) {
    return { start: idx, end: idx + search.length, matched: content.slice(idx, idx + search.length) };
  }
  return { start, end, matched: content.slice(start, end) };
}

function findLineBlockFuzzy(content: string, search: string): ReplaceRange | null {
  const searchLines = normalizeLineEndings(search).split('\n');
  if (searchLines.length === 0) return null;

  const contentNorm = normalizeLineEndings(content);
  const contentLines = contentNorm.split('\n');

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (contentLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const matchedBlock = contentLines.slice(i, i + searchLines.length).join('\n');
    const startNorm = contentNorm.indexOf(matchedBlock);
    if (startNorm === -1) continue;

    const endNorm = startNorm + matchedBlock.length;
    const start = mapNormOffsetToOriginal(content, startNorm);
    const end = mapNormOffsetToOriginal(content, endNorm);
    return { start, end, matched: content.slice(start, end) };
  }

  return null;
}

function mapNormOffsetToOriginal(content: string, normOffset: number): number {
  let normPos = 0;
  let origPos = 0;
  while (origPos < content.length && normPos < normOffset) {
    if (content.startsWith('\r\n', origPos)) {
      normPos += 1;
      origPos += 2;
      continue;
    }
    if (content[origPos] === '\r') {
      origPos += 1;
      continue;
    }
    normPos += 1;
    origPos += 1;
  }
  return origPos;
}

/**
 * 在 content 中定位 search 可替换区间；失败返回 null。
 */
export function findReplaceRange(content: string, search: string): ReplaceRange | null {
  if (!search) return null;

  const exact = content.indexOf(search);
  if (exact !== -1) {
    return { start: exact, end: exact + search.length, matched: search };
  }

  return findNormalizedBlock(content, search) ?? findLineBlockFuzzy(content, search);
}

export interface ApplyNonRegexReplaceResult {
  content: string;
  changed: boolean;
  fuzzy: boolean;
}

/**
 * 非正则查找替换：精确 → 模糊；支持 replaceAll。
 */
export function applyNonRegexReplace(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean,
): ApplyNonRegexReplaceResult {
  if (replaceAll && content.includes(search)) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const next = content.replace(new RegExp(escaped, 'g'), replace);
    return { content: next, changed: next !== content, fuzzy: false };
  }

  if (replaceAll) {
    let out = content;
    let changed = false;
    let fuzzy = false;
    let scanFrom = 0;
    const maxPasses = 10_000;
    for (let pass = 0; pass < maxPasses; pass++) {
      const slice = out.slice(scanFrom);
      const range = findReplaceRange(slice, search);
      if (!range) break;
      const absStart = scanFrom + range.start;
      const absEnd = scanFrom + range.end;
      fuzzy = fuzzy || range.matched !== search;
      out = out.slice(0, absStart) + replace + out.slice(absEnd);
      changed = true;
      // replace 常以 search 为前缀；不前进会在同一位置反复匹配导致挂死
      scanFrom = absStart + replace.length;
    }
    return { content: out, changed, fuzzy };
  }

  const range = findReplaceRange(content, search);
  if (!range) {
    return { content, changed: false, fuzzy: false };
  }
  const next = content.slice(0, range.start) + replace + content.slice(range.end);
  return { content: next, changed: true, fuzzy: range.matched !== search };
}
