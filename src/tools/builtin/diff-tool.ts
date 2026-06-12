/**
 * 文件差异对比工具。
 * 对比两个文件或同一文件的两段内容，返回 unified diff 格式的差异。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';
import { buildUnifiedDiff } from '../file-change-diff.js';

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

/**
 * 创建文件差异对比工具。
 */
export function createDiffTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'diff_files',
      description:
        'Compare two files and return unified diff. Also supports comparing two text strings (use text1/text2 instead of file1/file2). Returns no diff if files are identical.',
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

        const diff = buildUnifiedDiff(
          oldContent.split('\n'),
          newContent.split('\n'),
          oldLabel,
          newLabel,
          contextLines,
        );

        return { success: true, output: diff };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: '', error: `差异对比失败: ${message}` };
      }
    },
  };
}
