/**
 * 批量编辑工具。
 * 一次调用对文件执行多处查找替换，减少工具调用轮次。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

/**
 * 创建批量编辑工具。
 */
export function createBatchEditTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'batch_edit_file',
      description:
        '对文件执行多处查找替换操作。每个替换按顺序执行（前一个替换的结果作为后一个的输入）。比多次调用 edit_file 更高效。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对于工作目录）' },
          edits: {
            type: 'array',
            description: '替换操作列表，按顺序执行',
            items: {
              type: 'object',
              properties: {
                search: { type: 'string', description: '要查找的内容' },
                replace: { type: 'string', description: '替换后的内容' },
                isRegex: { type: 'boolean', description: '是否使用正则表达式', default: false },
                replaceAll: { type: 'boolean', description: '是否替换所有匹配项', default: true },
              },
              required: ['search', 'replace'],
            },
          },
          dryRun: {
            type: 'boolean',
            description: '仅预览变更，不实际写入文件',
            default: false,
          },
        },
        required: ['path', 'edits'],
      },
    },
    handler: async (args) => {
      const filePath = safePath(args.path, workDir);
      const edits = args.edits as Array<{
        search: string;
        replace: string;
        isRegex?: boolean;
        replaceAll?: boolean;
      }>;
      const dryRun = args.dryRun || false;

      if (!edits || edits.length === 0) {
        return { success: false, output: '', error: '编辑列表不能为空' };
      }

      try {
        let content = await fs.readFile(filePath, 'utf-8');
        const originalContent = content;
        const results: string[] = [];

        for (let i = 0; i < edits.length; i++) {
          const edit = edits[i];
          const before = content;

          let pattern: string | RegExp;
          if (edit.isRegex) {
            const flags = edit.replaceAll !== false ? 'g' : '';
            pattern = new RegExp(edit.search, flags);
          } else if (edit.replaceAll !== false) {
            pattern = new RegExp(
              edit.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
              'g',
            );
          } else {
            pattern = edit.search;
          }

          content = content.replace(pattern, edit.replace);
          const changed = before !== content;
          results.push(`  ${i + 1}. "${edit.search}" → "${edit.replace}": ${changed ? '✅ 已替换' : '⚠️ 未匹配'}`);
        }

        const totalChanged = originalContent !== content;

        if (!dryRun && totalChanged) {
          await fs.writeFile(filePath, content, 'utf-8');
        }

        const header = dryRun
          ? `[预览模式] ${args.path} (${edits.length} 处编辑)`
          : `${args.path} (${edits.length} 处编辑${totalChanged ? ', 已保存' : ', 无变更'})`;

        return {
          success: true,
          output: `${header}\n${results.join('\n')}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: '', error: `批量编辑失败: ${message}` };
      }
    },
  };
}
