/**
 * 文件差异对比工具。
 * 对比两个文件或同一文件的两段内容，返回 unified diff 格式的差异。
 * 纯 Node.js 实现，不依赖外部库。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

/**
 * 安全路径解析。
 */
function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
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

/**
 * 生成 unified diff 格式的差异。
 */
function unifiedDiff(
  oldLines: string[],
  newLines: string[],
  oldLabel: string,
  newLabel: string,
  contextLines: number = 3,
): string {
  const dp = lcs(oldLines, newLines);
  const changes: Array<{ type: 'equal' | 'delete' | 'insert'; oldIdx: number; newIdx: number; line: string }> = [];

  // 回溯 LCS 生成变更列表
  let i = oldLines.length;
  let j = newLines.length;

  const raw: Array<{ type: 'equal' | 'delete' | 'insert'; oldIdx: number; newIdx: number; line: string }> = [];

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

  // 如果没有差异
  const hasChanges = raw.some((c) => c.type !== 'equal');
  if (!hasChanges) {
    return '文件内容相同，无差异。';
  }

  // 生成 unified diff 格式
  const output: string[] = [];
  output.push(`--- ${oldLabel}`);
  output.push(`+++ ${newLabel}`);

  // 将变更分组为 hunks
  const hunks: Array<{ start: number; changes: typeof raw }> = [];
  let currentHunk: typeof raw = [];
  let lastChangeIdx = -999;

  for (let idx = 0; idx < raw.length; idx++) {
    const change = raw[idx];
    if (change.type !== 'equal') {
      // 如果距离上一个变更太远，开始新 hunk
      if (idx - lastChangeIdx > contextLines * 2 + 1 && currentHunk.length > 0) {
        hunks.push({ start: 0, changes: currentHunk });
        currentHunk = [];
      }
      // 添加前置上下文
      const ctxStart = Math.max(lastChangeIdx === -999 ? 0 : lastChangeIdx + contextLines + 1, idx - contextLines);
      for (let c = ctxStart; c < idx; c++) {
        if (raw[c] && raw[c].type === 'equal' && !currentHunk.includes(raw[c])) {
          currentHunk.push(raw[c]);
        }
      }
      currentHunk.push(change);
      lastChangeIdx = idx;
    } else if (currentHunk.length > 0 && idx - lastChangeIdx <= contextLines) {
      // 后置上下文
      currentHunk.push(change);
    }
  }

  if (currentHunk.length > 0) {
    hunks.push({ start: 0, changes: currentHunk });
  }

  // 格式化每个 hunk
  for (const hunk of hunks) {
    const changes = hunk.changes;
    if (changes.length === 0) continue;

    // 计算 hunk 范围
    let oldStart = Infinity, newStart = Infinity;
    let oldCount = 0, newCount = 0;

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

/**
 * 创建文件差异对比工具。
 */
export function createDiffTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'diff_files',
      description:
        '对比两个文件的差异，返回 unified diff 格式。可用于代码审查、理解变更。也支持直接对比两段文本内容。',
      parameters: {
        type: 'object',
        properties: {
          file1: { type: 'string', description: '第一个文件路径（相对于工作目录）' },
          file2: { type: 'string', description: '第二个文件路径（相对于工作目录）' },
          text1: { type: 'string', description: '直接提供第一段文本内容（与 file1 二选一）' },
          text2: { type: 'string', description: '直接提供第二段文本内容（与 file2 二选一）' },
          contextLines: {
            type: 'number',
            description: '差异上下文行数，默认 3',
            default: 3,
          },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const contextLines = (args.contextLines as number) || 3;

      let oldContent: string;
      let newContent: string;
      let oldLabel: string;
      let newLabel: string;

      try {
        // 获取旧内容
        if (args.file1) {
          const filePath = safePath(args.file1, workDir);
          oldContent = await fs.readFile(filePath, 'utf-8');
          oldLabel = args.file1;
        } else if (args.text1 !== undefined) {
          oldContent = args.text1;
          oldLabel = 'text1';
        } else {
          return { success: false, output: '', error: '必须提供 file1 或 text1' };
        }

        // 获取新内容
        if (args.file2) {
          const filePath = safePath(args.file2, workDir);
          newContent = await fs.readFile(filePath, 'utf-8');
          newLabel = args.file2;
        } else if (args.text2 !== undefined) {
          newContent = args.text2;
          newLabel = 'text2';
        } else {
          return { success: false, output: '', error: '必须提供 file2 或 text2' };
        }

        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');

        const diff = unifiedDiff(oldLines, newLines, oldLabel, newLabel, contextLines);

        return { success: true, output: diff };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: '', error: `差异对比失败: ${message}` };
      }
    },
  };
}
