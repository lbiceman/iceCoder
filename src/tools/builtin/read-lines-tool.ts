/**
 * 按行范围读取文件工具。
 * 支持读取文件的指定行范围，避免大文件场景下读取全部内容浪费 token。
 * 支持负数索引（从文件末尾计算）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

/**
 * 创建按行范围读取文件工具。
 */
export function createReadLinesTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'read_file_lines',
      description:
        '按行范围读取文件内容。适合大文件场景，只读取需要的部分。支持负数索引（-1 表示最后一行）。同时返回文件总行数。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对于工作目录）' },
          startLine: {
            type: 'number',
            description: '起始行号（1-based，含）。负数表示从末尾计算（-1 = 最后一行）。默认 1。',
            default: 1,
          },
          endLine: {
            type: 'number',
            description: '结束行号（1-based，含）。负数表示从末尾计算。默认读到文件末尾。',
          },
          encoding: { type: 'string', description: '文件编码，默认 utf-8', default: 'utf-8' },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const filePath = safePath(args.path, workDir);
      const encoding = (args.encoding || 'utf-8') as BufferEncoding;

      try {
        const content = await fs.readFile(filePath, encoding);
        const allLines = content.split('\n');
        const totalLines = allLines.length;

        // 解析行范围
        let start = (args.startLine as number) || 1;
        let end = (args.endLine as number) || totalLines;

        // 处理负数索引
        if (start < 0) start = totalLines + start + 1;
        if (end < 0) end = totalLines + end + 1;

        // 边界检查
        start = Math.max(1, Math.min(start, totalLines));
        end = Math.max(start, Math.min(end, totalLines));

        // 提取行（转为 0-based）
        const selectedLines = allLines.slice(start - 1, end);

        // 带行号输出
        const numbered = selectedLines
          .map((line, idx) => `${start + idx}: ${line}`)
          .join('\n');

        const header = `${args.path} (行 ${start}-${end}，共 ${totalLines} 行)`;

        return {
          success: true,
          output: `${header}\n${'─'.repeat(40)}\n${numbered}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: '', error: `读取文件失败: ${message}` };
      }
    },
  };
}
