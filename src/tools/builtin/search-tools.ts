/**
 * 搜索工具集。
 * 提供文件内容搜索（grep）和文件名搜索能力。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

/**
 * 安全路径检查。
 */
function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

/**
 * 创建搜索工具集。
 * @param workDir - 工作目录根路径
 */
export function createSearchTools(workDir: string): RegisteredTool[] {
  return [
    // ---- 文件内容搜索 ----
    {
      definition: {
        name: 'search_in_files',
        description: '在指定目录下的文件中搜索匹配的文本内容。支持正则表达式。返回匹配行及上下文。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '搜索模式（字符串或正则表达式）' },
            directory: { type: 'string', description: '搜索目录（相对于工作目录），默认为根目录', default: '.' },
            filePattern: { type: 'string', description: '文件名匹配模式（如 *.ts, *.js），默认搜索所有文件', default: '*' },
            isRegex: { type: 'boolean', description: '是否使用正则表达式', default: false },
            maxResults: { type: 'number', description: '最大结果数', default: 50 },
            contextLines: { type: 'number', description: '每个匹配项显示的上下文行数', default: 2 },
          },
          required: ['pattern'],
        },
      },
      handler: async (args) => {
        const dir = safePath(args.directory || '.', workDir);
        const pattern = args.isRegex ? new RegExp(args.pattern, 'gi') : args.pattern.toLowerCase();
        const maxResults = args.maxResults || 50;
        const contextLines = args.contextLines || 2;
        const filePattern = args.filePattern || '*';

        const results: string[] = [];
        await searchDir(dir, workDir, pattern, filePattern, maxResults, contextLines, results);

        if (results.length === 0) {
          return { success: true, output: '未找到匹配结果。' };
        }

        return { success: true, output: results.join('\n\n') };
      },
    },

    // ---- 文件名搜索 ----
    {
      definition: {
        name: 'find_files',
        description: '按文件名模式搜索文件。支持通配符匹配。',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '文件名匹配模式（支持 * 和 ? 通配符）' },
            directory: { type: 'string', description: '搜索目录（相对于工作目录），默认为根目录', default: '.' },
            maxResults: { type: 'number', description: '最大结果数', default: 100 },
          },
          required: ['pattern'],
        },
      },
      handler: async (args) => {
        const dir = safePath(args.directory || '.', workDir);
        const maxResults = args.maxResults || 100;
        const pattern = args.pattern;

        const matches: string[] = [];
        await findFiles(dir, workDir, pattern, maxResults, matches);

        if (matches.length === 0) {
          return { success: true, output: '未找到匹配文件。' };
        }

        return { success: true, output: `找到 ${matches.length} 个文件:\n${matches.join('\n')}` };
      },
    },
  ];
}

/**
 * 递归搜索目录中的文件内容。
 */
async function searchDir(
  dir: string,
  baseDir: string,
  pattern: RegExp | string,
  filePattern: string,
  maxResults: number,
  contextLines: number,
  results: string[],
): Promise<void> {
  if (results.length >= maxResults) return;

  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    if (results.length >= maxResults) break;

    const fullPath = path.join(dir, item.name);

    // 跳过隐藏目录和 node_modules
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;

    if (item.isDirectory()) {
      await searchDir(fullPath, baseDir, pattern, filePattern, maxResults, contextLines, results);
    } else if (item.isFile() && matchGlob(item.name, filePattern)) {
      await searchFile(fullPath, baseDir, pattern, contextLines, maxResults, results);
    }
  }
}

/**
 * 在单个文件中搜索匹配内容。
 */
async function searchFile(
  filePath: string,
  baseDir: string,
  pattern: RegExp | string,
  contextLines: number,
  maxResults: number,
  results: string[],
): Promise<void> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const relativePath = path.relative(baseDir, filePath);

    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      const line = lines[i];
      const isMatch =
        pattern instanceof RegExp ? pattern.test(line) : line.toLowerCase().includes(pattern);

      if (isMatch) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const context = lines
          .slice(start, end + 1)
          .map((l, idx) => {
            const lineNum = start + idx + 1;
            const marker = start + idx === i ? '>' : ' ';
            return `${marker} ${lineNum}: ${l}`;
          })
          .join('\n');

        results.push(`${relativePath}:${i + 1}\n${context}`);
      }
    }
  } catch {
    // 跳过无法读取的文件（二进制文件等）
  }
}

/**
 * 递归查找匹配文件名的文件。
 */
async function findFiles(
  dir: string,
  baseDir: string,
  pattern: string,
  maxResults: number,
  matches: string[],
): Promise<void> {
  if (matches.length >= maxResults) return;

  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const item of items) {
    if (matches.length >= maxResults) break;

    const fullPath = path.join(dir, item.name);

    if (item.name.startsWith('.') || item.name === 'node_modules') continue;

    if (item.isDirectory()) {
      await findFiles(fullPath, baseDir, pattern, maxResults, matches);
    } else if (item.isFile() && matchGlob(item.name, pattern)) {
      matches.push(path.relative(baseDir, fullPath));
    }
  }
}

/**
 * 简单的通配符匹配。
 */
function matchGlob(filename: string, pattern: string): boolean {
  if (pattern === '*') return true;

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${regexStr}$`, 'i').test(filename);
}
