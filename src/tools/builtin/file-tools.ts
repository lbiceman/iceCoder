/**
 * 文件读写工具集。
 * 提供文件读取、写入、追加、删除、列目录等操作。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

/**
 * 路径解析：相对路径基于工作目录解析，绝对路径直接使用。
 */
function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

/**
 * 创建文件工具集。
 * @param workDir - 工作目录根路径，所有文件操作限制在此目录内
 */
export function createFileTools(workDir: string): RegisteredTool[] {
  return [
    // ---- 读取文件 ----
    {
      definition: {
        name: 'read_file',
        description: '读取指定文件的内容。支持文本文件。可指定编码，默认 utf-8。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对于工作目录）' },
            encoding: { type: 'string', description: '文件编码，默认 utf-8', default: 'utf-8' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = safePath(args.path, workDir);
        const encoding = (args.encoding || 'utf-8') as BufferEncoding;
        const content = await fs.readFile(filePath, encoding);
        return { success: true, output: content };
      },
    },

    // ---- 写入文件 ----
    {
      definition: {
        name: 'write_file',
        description: '将内容写入指定文件。如果文件不存在则创建，存在则覆盖。自动创建父目录。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对于工作目录）' },
            content: { type: 'string', description: '要写入的内容' },
            encoding: { type: 'string', description: '文件编码，默认 utf-8', default: 'utf-8' },
          },
          required: ['path', 'content'],
        },
      },
      handler: async (args) => {
        const filePath = safePath(args.path, workDir);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, args.content, (args.encoding || 'utf-8') as BufferEncoding);
        return { success: true, output: `文件已写入: ${args.path}` };
      },
    },

    // ---- 追加文件 ----
    {
      definition: {
        name: 'append_file',
        description: '向指定文件末尾追加内容。如果文件不存在则创建。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对于工作目录）' },
            content: { type: 'string', description: '要追加的内容' },
          },
          required: ['path', 'content'],
        },
      },
      handler: async (args) => {
        const filePath = safePath(args.path, workDir);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, args.content, 'utf-8');
        return { success: true, output: `内容已追加到: ${args.path}` };
      },
    },

    // ---- 修改文件（查找替换） ----
    {
      definition: {
        name: 'edit_file',
        description: '在文件中查找并替换指定内容。支持正则表达式。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对于工作目录）' },
            search: { type: 'string', description: '要查找的内容（字符串或正则表达式）' },
            replace: { type: 'string', description: '替换后的内容' },
            isRegex: { type: 'boolean', description: '是否使用正则表达式匹配', default: false },
            replaceAll: { type: 'boolean', description: '是否替换所有匹配项', default: true },
          },
          required: ['path', 'search', 'replace'],
        },
      },
      handler: async (args) => {
        const filePath = safePath(args.path, workDir);
        let content = await fs.readFile(filePath, 'utf-8');

        let pattern: string | RegExp;
        if (args.isRegex) {
          const flags = args.replaceAll !== false ? 'g' : '';
          pattern = new RegExp(args.search, flags);
        } else if (args.replaceAll !== false) {
          pattern = new RegExp(args.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        } else {
          pattern = args.search;
        }

        const newContent = content.replace(pattern, args.replace);
        const changed = content !== newContent;
        await fs.writeFile(filePath, newContent, 'utf-8');

        return {
          success: true,
          output: changed ? `文件已修改: ${args.path}` : `未找到匹配内容，文件未变更: ${args.path}`,
        };
      },
    },

    // ---- 删除文件 ----
    {
      definition: {
        name: 'delete_file',
        description: '删除指定文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对于工作目录）' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = safePath(args.path, workDir);
        await fs.unlink(filePath);
        return { success: true, output: `文件已删除: ${args.path}` };
      },
    },

    // ---- 列出目录 ----
    {
      definition: {
        name: 'list_directory',
        description: '列出指定目录下的文件和子目录。可选递归深度。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目录路径（相对于工作目录）', default: '.' },
            recursive: { type: 'boolean', description: '是否递归列出子目录', default: false },
            maxDepth: { type: 'number', description: '递归最大深度', default: 3 },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const dirPath = safePath(args.path || '.', workDir);
        const recursive = args.recursive || false;
        const maxDepth = args.maxDepth || 3;

        const entries = await listDir(dirPath, workDir, recursive, maxDepth, 0);
        return { success: true, output: entries.join('\n') };
      },
    },

    // ---- 获取文件信息 ----
    {
      definition: {
        name: 'file_info',
        description: '获取文件或目录的详细信息（大小、修改时间、类型等）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件或目录路径（相对于工作目录）' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = safePath(args.path, workDir);
        const stat = await fs.stat(filePath);
        const info = {
          path: args.path,
          type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
          size: stat.size,
          sizeHuman: formatSize(stat.size),
          modified: stat.mtime.toISOString(),
          created: stat.birthtime.toISOString(),
        };
        return { success: true, output: JSON.stringify(info, null, 2) };
      },
    },
  ];
}

/**
 * 递归列出目录内容。
 */
async function listDir(
  dirPath: string,
  baseDir: string,
  recursive: boolean,
  maxDepth: number,
  currentDepth: number,
): Promise<string[]> {
  const entries: string[] = [];
  const items = await fs.readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    const relativePath = path.relative(baseDir, path.join(dirPath, item.name));
    const prefix = item.isDirectory() ? '📁 ' : '📄 ';
    entries.push(`${prefix}${relativePath}`);

    if (recursive && item.isDirectory() && currentDepth < maxDepth) {
      const subEntries = await listDir(
        path.join(dirPath, item.name),
        baseDir,
        recursive,
        maxDepth,
        currentDepth + 1,
      );
      entries.push(...subEntries);
    }
  }

  return entries;
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}
