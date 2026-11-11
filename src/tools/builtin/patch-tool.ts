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
  afterSuccessfulMemoryMarkdownWrite,
  assertAgentMemoryWriteAllowed,
  formatMemoryWritePathNote,
  removeStaleMemoryFileIfMoved,
  resolveExistingMemoryToolPath,
  resolveMemoryRootForPath,
  resolveMemoryWritePath,
  sanitizeMemoryContentBeforeWrite,
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

interface FailedHunk {
  index: number;
  oldStart: number;
  oldLines: string[];
}

/**
 * 将 hunks 应用到文件内容。
 * 支持模糊匹配：如果精确行号不匹配，会在附近搜索上下文。
 */
function applyHunks(originalLines: string[], hunks: Hunk[]): {
  lines: string[];
  applied: number;
  failures: FailedHunk[];
} {
  let result = [...originalLines];
  let offset = 0; // 累计行偏移
  let applied = 0;
  const failures: FailedHunk[] = [];

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex]!;
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
      failures.push({ index: hunkIndex + 1, oldStart: hunk.oldStart, oldLines });
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

  return { lines: result, applied, failures };
}

function clipLines(lines: string[], maxLines: number, maxChars: number): string {
  const clipped = lines.slice(0, maxLines);
  let text = clipped.join('\n');
  if (lines.length > maxLines) text += '\n…';
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…`;
  return text;
}

function fileWindow(lines: string[], startLine: number): string {
  const start = Math.max(0, startLine - 4);
  const window = lines.slice(start, start + 8);
  return window.map((line, index) => `${start + index + 1}|${line}`).join('\n');
}

/** 把没对上的旧上下文和文件里附近的原文交回模型。 */
function formatUnmatchedHunks(failures: FailedHunk[], originalLines: string[]): string {
  const blocks = failures.slice(0, 3).map((failure) => {
    const expected = clipLines(failure.oldLines, 12, 1_200);
    const nearby = fileWindow(originalLines, failure.oldStart);
    return [
      `hunk ${failure.index} 期望从第 ${failure.oldStart} 行开始，未匹配的上下文：`,
      expected || '(空)',
      '文件中该位置附近的原文：',
      nearby || '(文件更短)',
    ].join('\n');
  });
  const extra = failures.length > 3 ? `\n另有 ${failures.length - 3} 个 hunk 未匹配。` : '';
  return `未匹配的上下文：\n${blocks.join('\n\n')}${extra}`;
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
          path: { type: 'string', description: 'File path relative to the working directory' },
          patch: {
            type: 'string',
            description: 'Unified diff content with @@ hunk markers and +/- line prefixes',
          },
          dryRun: {
            type: 'boolean',
            description: 'Preview changes without writing the file',
            default: false,
          },
        },
        required: ['path', 'patch'],
      },
    },
    handler: async (args) => {
      const rawPath = args.path as string;
      const sourcePath = await resolveExistingMemoryToolPath(rawPath, workDir);
      if (resolveMemoryRootForPath(sourcePath)) {
        const guardErr = await assertAgentMemoryWriteAllowed(sourcePath, { sessionId });
        if (guardErr) return { success: false, output: '', error: guardErr };
      }
      const readErr = checkReadBeforeEdit(workDir, rawPath, sessionId);
      if (readErr) return { success: false, output: '', error: readErr };
      let readPath = sourcePath;
      try {
        await fs.access(readPath);
      } catch {
        readPath = safePath(rawPath, workDir);
      }
      const patch = args.patch as string;
      const dryRun = args.dryRun || false;

      try {
        const content = await fs.readFile(readPath, 'utf-8');
        const originalLines = content.split('\n');

        const hunks = parseUnifiedDiff(patch);
        if (hunks.length === 0) {
          return { success: false, output: '', error: '未能解析出有效的 diff hunk。请确保补丁格式正确（包含 @@ 行号标记）。' };
        }

        const { lines, applied, failures } = applyHunks(originalLines, hunks);

        if (applied === 0) {
          return {
            success: false,
            output: '',
            error: [
              `所有 ${hunks.length} 个 hunk 均匹配失败。文件内容可能已变更。`,
              formatUnmatchedHunks(failures, originalLines),
            ].join('\n'),
          };
        }

        const newContent = lines.join('\n');
        const destPath = resolveMemoryWritePath(rawPath, workDir, newContent);
        if (resolveMemoryRootForPath(destPath)) {
          const destGuard = await assertAgentMemoryWriteAllowed(destPath, { content: newContent, sessionId });
          if (destGuard) return { success: false, output: '', error: destGuard };
        }

        if (!dryRun) {
          let writeContent = newContent;
          if (resolveMemoryRootForPath(destPath)) {
            writeContent = sanitizeMemoryContentBeforeWrite(newContent).content;
          }
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          await fs.writeFile(destPath, writeContent, 'utf-8');
          await removeStaleMemoryFileIfMoved(readPath, destPath);
          if (resolveMemoryRootForPath(destPath)) {
            await afterSuccessfulMemoryMarkdownWrite(destPath, writeContent, sessionId);
          }
        }

        const status = dryRun ? '[预览模式] ' : '';
        let summary = `${status}补丁已应用到 ${args.path}\n`;
        summary += `  成功: ${applied}/${hunks.length} 个 hunk`;
        if (failures.length > 0) {
          summary += `\n  失败: ${failures.length} 个 hunk（上下文不匹配）\n${formatUnmatchedHunks(failures, originalLines)}`;
        }
        if (!dryRun) summary += formatMemoryWritePathNote(destPath);

        return { success: true, output: formatToolOutputWithDiff(summary, patch) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, output: '', error: `补丁应用失败: ${message}` };
      }
    },
  };
}
