/**
 * 搜索工具集。
 * 提供文件内容搜索、文件名搜索、glob 模式搜索能力。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

/**
 * 创建搜索工具集（合并 search_in_files, find_files, glob_files）。
 * @param workDir - 工作目录根路径
 */
export function createSearchTools(workDir: string): RegisteredTool[] {
  return [
    // ---- 统一搜索工具 ----
    {
      definition: {
        name: 'search_codebase',
        description:
          'Search the codebase. Default mode searches file content with regex/text pattern. Set mode:"filename" to find files by glob pattern (e.g. "**/*.ts", "src/**/*.test.js"). Set mode:"content" for explicit content search. Auto-skips node_modules and hidden directories. Use immediately when asked to find or search for code.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Search pattern. For content mode: text or regex. For filename mode: glob pattern.' },
            mode: { type: 'string', description: 'Search mode: "content" (default, search inside files), "filename" (glob match file paths)', default: 'content' },
            directory: { type: 'string', description: 'Search directory relative to work dir, default root', default: '.' },
            filePattern: { type: 'string', description: 'Filter files by name pattern for content mode (e.g. *.ts)', default: '*' },
            isRegex: { type: 'boolean', description: 'Treat pattern as regex for content mode', default: false },
            maxResults: { type: 'number', description: 'Maximum results', default: 50 },
            contextLines: { type: 'number', description: 'Context lines around matches for content mode', default: 2 },
          },
          required: ['pattern'],
        },
      },
      handler: async (args) => {
        const mode = (args.mode as string) || 'content';
        const maxResults = (args.maxResults as number) || 50;

        if (mode === 'filename') {
          // ── Glob filename search (merged from search_codebase) ──
          const pattern = args.pattern as string;
          const searchDir = args.directory
            ? path.resolve(workDir, args.directory as string)
            : workDir;

          const allFiles = await walkDir(searchDir, maxResults * 5);
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
          const truncated = matched.length >= maxResults ? `\n... (truncated at ${maxResults})` : '';
          return {
            success: true,
            output: `Found ${matched.length} files matching "${pattern}":\n${matched.join('\n')}${truncated}`,
          };
        }

        // ── Content search (merged from search_codebase) ──
        const dir = safePath(args.directory || '.', workDir);
        const pattern = args.isRegex ? new RegExp(args.pattern, 'gi') : args.pattern.toLowerCase();
        const contextLines = args.contextLines || 2;
        const filePattern = args.filePattern || '*';

        const results: string[] = [];
        await searchDir(dir, workDir, pattern, filePattern, maxResults, contextLines, results);

        if (results.length === 0) {
          return { success: true, output: 'No matches found.' };
        }
        return { success: true, output: results.join('\n\n') };
      },
    },
  ];
}

// ═══════════════════════════════════════════════════════════
// Content search helpers
// ═══════════════════════════════════════════════════════════

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
  try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const item of items) {
    if (results.length >= maxResults) break;
    const fullPath = path.join(dir, item.name);
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    if (item.isDirectory()) {
      await searchDir(fullPath, baseDir, pattern, filePattern, maxResults, contextLines, results);
    } else if (item.isFile() && matchGlob(item.name, filePattern)) {
      await searchFile(fullPath, baseDir, pattern, contextLines, maxResults, results);
    }
  }
}

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
      const isMatch = pattern instanceof RegExp ? pattern.test(line) : line.toLowerCase().includes(pattern);
      if (isMatch) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        const context = lines.slice(start, end + 1).map((l, idx) => {
          const lineNum = start + idx + 1;
          const marker = start + idx === i ? '>' : ' ';
          return `${marker} ${lineNum}: ${l}`;
        }).join('\n');
        results.push(`${relativePath}:${i + 1}\n${context}`);
      }
    }
  } catch { /* skip binary files */ }
}

// ═══════════════════════════════════════════════════════════
// Glob filename search helpers (merged from glob-tool.ts)
// ═══════════════════════════════════════════════════════════

function globSegmentToRegex(segment: string): RegExp {
  let regexStr = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') regexStr += '[^/\\\\]*';
    else if (ch === '?') regexStr += '[^/\\\\]';
    else if ('.+^${}()|[]\\'.includes(ch)) regexStr += '\\' + ch;
    else regexStr += ch;
  }
  return new RegExp(`^${regexStr}$`, 'i');
}

async function walkDir(dir: string, maxResults: number): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    if (results.length >= maxResults) return;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) results.push(fullPath);
    }
  }
  await walk(dir);
  return results;
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  return matchSegments(normalizedPath.split('/'), 0, normalizedPattern.split('/'), 0);
}

function matchSegments(
  pathSegs: string[], pathIdx: number,
  patternSegs: string[], patternIdx: number,
): boolean {
  if (pathIdx >= pathSegs.length && patternIdx >= patternSegs.length) return true;
  if (patternIdx >= patternSegs.length) return false;
  const pat = patternSegs[patternIdx];
  if (pat === '**') {
    for (let i = pathIdx; i <= pathSegs.length; i++) {
      if (matchSegments(pathSegs, i, patternSegs, patternIdx + 1)) return true;
    }
    return false;
  }
  if (pathIdx >= pathSegs.length) return false;
  if (globSegmentToRegex(pat).test(pathSegs[pathIdx])) {
    return matchSegments(pathSegs, pathIdx + 1, patternSegs, patternIdx + 1);
  }
  return false;
}

function matchGlob(filename: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(filename);
}
