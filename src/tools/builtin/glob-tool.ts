/**
 * Glob 文件搜索工具。
 * 基于 Node.js fs.readdir 递归实现 glob 模式匹配。
 * 支持 ** 递归目录匹配、* 单层通配、? 单字符通配。
 * 不依赖第三方 glob 库。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

/**
 * 将 glob 模式段转为正则表达式。
 * * 匹配任意字符（不含路径分隔符），? 匹配单字符。
 */
function globSegmentToRegex(segment: string): RegExp {
  let regexStr = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') {
      regexStr += '[^/\\\\]*';
    } else if (ch === '?') {
      regexStr += '[^/\\\\]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regexStr += '\\' + ch;
    } else {
      regexStr += ch;
    }
  }
  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * 递归遍历目录，收集所有文件路径。
 */
async function walkDir(dir: string, maxResults: number): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return; // 无权限等错误，跳过
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      // 跳过隐藏目录和 node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results;
}

/**
 * 匹配文件路径是否符合 glob 模式。
 * 将模式按 / 或 \ 拆分为段，逐段匹配。
 * ** 段匹配零个或多个目录。
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const pathSegments = normalizedPath.split('/');
  const patternSegments = normalizedPattern.split('/');

  return matchSegments(pathSegments, 0, patternSegments, 0);
}

function matchSegments(
  pathSegs: string[],
  pathIdx: number,
  patternSegs: string[],
  patternIdx: number,
): boolean {
  // 两者都消耗完 → 匹配成功
  if (pathIdx >= pathSegs.length && patternIdx >= patternSegs.length) return true;
  // 模式消耗完但路径还有 → 不匹配
  if (patternIdx >= patternSegs.length) return false;

  const pat = patternSegs[patternIdx];

  // ** 匹配零个或多个目录
  if (pat === '**') {
    // 尝试匹配 0, 1, 2, ... 个路径段
    for (let i = pathIdx; i <= pathSegs.length; i++) {
      if (matchSegments(pathSegs, i, patternSegs, patternIdx + 1)) {
        return true;
      }
    }
    return false;
  }

  // 路径消耗完但模式还有 → 不匹配
  if (pathIdx >= pathSegs.length) return false;

  // 普通段匹配
  const regex = globSegmentToRegex(pat);
  if (regex.test(pathSegs[pathIdx])) {
    return matchSegments(pathSegs, pathIdx + 1, patternSegs, patternIdx + 1);
  }

  return false;
}

/**
 * 创建 glob 文件搜索工具。
 */
export function createGlobTool(workDir: string): RegisteredTool {
  return {
    definition: {
      name: 'glob_files',
      // 用 **/*.ts 模式搜索文件。支持递归匹配。比 find_files 更强大。
      description:
        'Search files by glob pattern (e.g. **/*.ts, src/**/*.test.js). Supports recursive ** matching. For content search use search_in_files. For simple filename patterns use find_files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern (e.g. **/*.ts, src/**/*.{ts,js}, **/README.md)',
          },
          path: {
            type: 'string',
            description: 'Search root directory (relative to work dir). Default: work dir.',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum results to return. Default: 200.',
            default: 200,
          },
        },
        required: ['pattern'],
      },
    },
    handler: async (args) => {
      const pattern = args.pattern as string;
      const searchDir = args.path
        ? path.resolve(workDir, args.path)
        : workDir;
      const maxResults = (args.maxResults as number) || 200;

      try {
        // 收集所有文件
        const allFiles = await walkDir(searchDir, maxResults * 5); // 多收集一些用于过滤

        // 用 glob 模式过滤
        const matched: string[] = [];
        for (const file of allFiles) {
          if (matched.length >= maxResults) break;
          const relativePath = path.relative(searchDir, file).replace(/\\/g, '/');
          if (matchesGlob(relativePath, pattern)) {
            matched.push(relativePath);
          }
        }

        if (matched.length === 0) {
          return { success: true, output: `No files matched pattern: ${pattern}` };
        }

        const truncated = matched.length >= maxResults
          ? `\n... (truncated at ${maxResults} results)`
          : '';

        return {
          success: true,
          output: `Found ${matched.length} files matching "${pattern}":\n${matched.join('\n')}${truncated}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: '', error: `Glob search failed: ${message}` };
      }
    },
  };
}
