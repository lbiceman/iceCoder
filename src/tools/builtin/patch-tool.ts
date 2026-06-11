/**
 * Patch 应用工具。
 * 将 unified diff 格式的补丁应用到文件。
 * 比 edit_file 的查找替换更精确，适合大段代码修改。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';
import { formatToolOutputWithDiff } from '../file-change-diff.js';
import { checkReadBeforeEdit } from '../read-before-edit.js';
import {
  assertAgentMemoryWriteAllowed,
  canonicalizeMemoryToolPath,
  resolveMemoryRootForPath,
} from '../../memory/file-memory/memory-write-pipeline.js';

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
}

/** 解析 unified diff 中的一个 hunk */
interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ type: 'context' | 'delete' | 'insert'; content: string }>;
}

/**
 * 解析 unified diff 格式的补丁内容。
 */
function parseUnifiedDiff(patch: string): Hunk[] {
  const lines = patch.split('\n');
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const line of lines) {
    // 跳过文件头
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    // 解析 hunk 头
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        oldStart: parseInt(hunkMatch[1]),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2]) : 1,
        newStart: parseInt(hunkMatch[3]),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4]) : 1,
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'delete', content: line.slice(1) });
    } else if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'insert', content: line.slice(1) });
    } else if (line.startsWith(' ') || line === '') {
      currentHunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
    }
  }

  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}

/**
 * 将 hunks 应用到文件内容。
 * 支持模糊匹配：如果精确行号不匹配，会在附近搜索上下文。
 */
function applyHunks(originalLines: string[], hunks: Hunk[]): { lines: string[]; applied: number; failed: number } {
  let result = [...originalLines];
  let offset = 0; // 累计行偏移
  let applied = 0;
  let failed = 0;

  for (const hunk of hunks) {
    const targetLine = hunk.oldStart - 1 + offset; // 0-based

    // 提取 hunk 中的旧行（context + delete）
    const oldLines = hunk.lines
      .filter((l) => l.type === 'context' || l.type === 'delete')
      .map((l) => l.content);

    // 尝试精确匹配
    let matchPos = findMatch(result, oldLines, targetLine);

    // 如果精确匹配失败，在附近搜索（±50 行）
    if (matchPos === -1) {
      const searchRange = 50;
      for (let delta = 1; delta <= searchRange; delta++) {
        matchPos = findMatch(result, oldLines, targetLine - delta);
        if (matchPos !== -1) break;
        matchPos = findMatch(result, oldLines, targetLine + delta);
        if (matchPos !== -1) break;
      }
    }

    if (matchPos === -1) {
      failed++;
      continue;
    }

    // 构建新行
    const newLines = hunk.lines
      .filter((l) => l.type === 'context' || l.type === 'insert')
      .map((l) => l.content);

    // 替换
    result.splice(matchPos, oldLines.length, ...newLines);
    offset += newLines.length - oldLines.length;
    applied++;
  }

  return { lines: result, applied, failed };
}

/**
 * 在文件行中查找匹配位置。
 */
function findMatch(fileLines: string[], searchLines: string[], startPos: number): number {
  if (startPos < 0 || startPos + searchLines.length > fileLines.length) return -1;

  for (let i = 0; i < searchLines.length; i++) {
    if (fileLines[startPos + i] !== searchLines[i]) return -1;
  }

  return startPos;
}

/**
 * 创建 Patch 应用工具。
 */
export function createPatchTool(workDir: string, sessionId = 'default'): RegisteredTool {
  return {
    definition: {
      name: 'patch_file',
      // 应用 diff 补丁。大段修改用。小改动用 edit_file。
      description:
        'Apply unified diff patch to file. Preferred for large or multi-line edits and when max_tokens may truncate write_file. Use one or few small hunks. Use edit_file for tiny single replacements. Supports fuzzy line matching when context shifts.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要打补丁的文件路径（相对于工作目录）' },
          patch: {
            type: 'string',
            description: 'unified diff 格式的补丁内容（包含 @@ 行号标记和 +/- 前缀）',
          },
          dryRun: {
            type: 'boolean',
            description: '仅预览变更，不实际写入文件',
            default: false,
          },
        },
        required: ['path', 'patch'],
      },
    },
    handler: async (args) => {
      const rawPath = args.path as string;
      const resolvedMemoryPath = canonicalizeMemoryToolPath(rawPath, workDir);
      if (resolveMemoryRootForPath(resolvedMemoryPath)) {
        const guardErr = await assertAgentMemoryWriteAllowed(resolvedMemoryPath);
        if (guardErr) return { success: false, output: '', error: guardErr };
      }
      const readErr = checkReadBeforeEdit(workDir, rawPath, sessionId);
      if (readErr) return { success: false, output: '', error: readErr };
      const filePath = safePath(rawPath, workDir);
      const patch = args.patch as string;
      const dryRun = args.dryRun || false;

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const originalLines = content.split('\n');

        const hunks = parseUnifiedDiff(patch);
        if (hunks.length === 0) {
          return { success: false, output: '', error: '未能解析出有效的 diff hunk。请确保补丁格式正确（包含 @@ 行号标记）。' };
        }

        const { lines, applied, failed } = applyHunks(originalLines, hunks);

        if (applied === 0) {
          return {
            success: false,
            output: '',
            error: `所有 ${hunks.length} 个 hunk 均匹配失败。文件内容可能已变更。`,
          };
        }

        const newContent = lines.join('\n');

        if (!dryRun) {
          await fs.writeFile(filePath, newContent, 'utf-8');
        }

        const status = dryRun ? '[预览模式] ' : '';
        let summary = `${status}补丁已应用到 ${args.path}\n`;
        summary += `  成功: ${applied}/${hunks.length} 个 hunk`;
        if (failed > 0) {
          summary += `\n  失败: ${failed} 个 hunk（上下文不匹配）`;
        }

        return { success: true, output: formatToolOutputWithDiff(summary, patch) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: '', error: `补丁应用失败: ${message}` };
      }
    },
  };
}
