/**
 * 文件内容变更 → unified diff（供工具 output 与 Web UI diff 展示）。
 */

/** 生成 unified diff 文本；无差异时返回 null */
export function buildFileChangeDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string | null {
  if (oldContent === newContent) return null;
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diff = buildUnifiedDiff(oldLines, newLines, filePath, filePath, 3);
  if (!diff || diff.includes('无差异')) return null;
  return diff;
}

/** 工具成功摘要 + 可选 diff 块（structured / WebSocket 共用） */
export function formatToolOutputWithDiff(summary: string, diff: string | null | undefined): string {
  if (!diff) return summary;
  return `${summary}\n\n${diff}`;
}

/** 尝试读取文件；不存在则返回空字符串 */
export async function readFileTextOrEmpty(
  read: () => Promise<string>,
): Promise<string> {
  try {
    return await read();
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
    if (code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * 最长公共子序列（LCS）算法，用于生成 diff。
 */
function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

type ChangeLine = { type: 'equal' | 'delete' | 'insert'; oldIdx: number; newIdx: number; line: string };

/** 连续 delete 块 + insert 块 → 逐行配对（-old / +new 交替），便于 Git 风格展示 */
export function interleaveDeleteInsert(changes: ChangeLine[]): ChangeLine[] {
  const result: ChangeLine[] = [];
  let i = 0;
  while (i < changes.length) {
    const cur = changes[i];
    if (cur.type === 'equal') {
      result.push(cur);
      i++;
      continue;
    }
    const dels: ChangeLine[] = [];
    while (i < changes.length && changes[i].type === 'delete') {
      dels.push(changes[i]);
      i++;
    }
    const adds: ChangeLine[] = [];
    while (i < changes.length && changes[i].type === 'insert') {
      adds.push(changes[i]);
      i++;
    }
    if (dels.length > 0 && adds.length > 0) {
      const max = Math.max(dels.length, adds.length);
      for (let k = 0; k < max; k++) {
        if (k < dels.length) result.push(dels[k]);
        if (k < adds.length) result.push(adds[k]);
      }
    } else {
      result.push(...dels, ...adds);
    }
  }
  return result;
}

/**
 * 生成 unified diff 格式的差异（与 diff_files 工具语义一致）。
 */
export function buildUnifiedDiff(
  oldLines: string[],
  newLines: string[],
  oldLabel: string,
  newLabel: string,
  contextLines: number = 3,
): string {
  const dp = lcs(oldLines, newLines);

  const raw: ChangeLine[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      raw.push({ type: 'equal', oldIdx: i, newIdx: j, line: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: 'insert', oldIdx: i, newIdx: j, line: newLines[j - 1] });
      j--;
    } else {
      raw.push({ type: 'delete', oldIdx: i, newIdx: j, line: oldLines[i - 1] });
      i--;
    }
  }

  raw.reverse();

  const hasChanges = raw.some((c) => c.type !== 'equal');
  if (!hasChanges) {
    return '文件内容相同，无差异。';
  }

  const output: string[] = [];
  output.push(`--- ${oldLabel}`);
  output.push(`+++ ${newLabel}`);

  const hunks: Array<{ start: number; changes: ChangeLine[] }> = [];
  let currentHunk: ChangeLine[] = [];
  let lastChangeIdx = -999;

  for (let idx = 0; idx < raw.length; idx++) {
    const change = raw[idx];
    if (change.type !== 'equal') {
      if (idx - lastChangeIdx > contextLines * 2 + 1 && currentHunk.length > 0) {
        hunks.push({ start: 0, changes: currentHunk });
        currentHunk = [];
      }
      const ctxStart = Math.max(lastChangeIdx === -999 ? 0 : lastChangeIdx + contextLines + 1, idx - contextLines);
      for (let c = ctxStart; c < idx; c++) {
        if (raw[c] && raw[c].type === 'equal' && !currentHunk.includes(raw[c])) {
          currentHunk.push(raw[c]);
        }
      }
      currentHunk.push(change);
      lastChangeIdx = idx;
    } else if (currentHunk.length > 0 && idx - lastChangeIdx <= contextLines) {
      currentHunk.push(change);
    }
  }

  if (currentHunk.length > 0) {
    hunks.push({ start: 0, changes: currentHunk });
  }

  for (const hunk of hunks) {
    const changes = interleaveDeleteInsert(hunk.changes);
    if (changes.length === 0) continue;

    let oldStart = Infinity;
    let newStart = Infinity;
    let oldCount = 0;
    let newCount = 0;

    for (const c of changes) {
      if (c.type === 'equal') {
        if (c.oldIdx < oldStart) oldStart = c.oldIdx;
        if (c.newIdx < newStart) newStart = c.newIdx;
        oldCount++;
        newCount++;
      } else if (c.type === 'delete') {
        if (c.oldIdx < oldStart) oldStart = c.oldIdx;
        oldCount++;
      } else {
        if (c.newIdx < newStart) newStart = c.newIdx;
        newCount++;
      }
    }

    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

    for (const c of changes) {
      if (c.type === 'equal') {
        output.push(` ${c.line}`);
      } else if (c.type === 'delete') {
        output.push(`-${c.line}`);
      } else {
        output.push(`+${c.line}`);
      }
    }
  }

  return output.join('\n');
}

