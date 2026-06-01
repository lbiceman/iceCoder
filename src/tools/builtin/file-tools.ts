/**
 * 文件读写工具集。
 * 提供文件读取、写入、追加、删除、列目录等操作。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';
import { getEditHistory } from './undo-edit-tool.js';
import {
  getReadFileDefaultMaxChars,
  getReadFileDefaultMaxLines,
  getWriteFileBlockChars,
  getWriteFileWarnChars,
  getWriteFileWarnLines,
} from '../tool-output-limits.js';
import { applyNonRegexReplace } from '../file-edit-fuzzy.js';
import {
  buildFileChangeDiff,
  formatToolOutputWithDiff,
  readFileTextOrEmpty,
} from '../file-change-diff.js';

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
        description:
          'Read file content. Returns full text by default. Use offset and limit to read a line range (ideal for large files). offset is 1-based start line, limit is max lines to return. Returns numbered lines when offset/limit is used. Use immediately when you need to read a file\'s content. If the file does not exist (ENOENT), use write_file to create it — do not retry read_file on the same missing path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to work directory' },
            encoding: { type: 'string', description: 'File encoding, default utf-8', default: 'utf-8' },
            offset: { type: 'number', description: 'Start line number (1-based). When provided with limit, reads only that line range instead of the whole file.' },
            limit: { type: 'number', description: 'Maximum lines to read. Use together with offset to read a specific window into a large file.' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        // filePath is an accepted alias for path (LLMs sometimes use it by habit)
        const rawPath = args.path || args.filePath;
        if (!rawPath) {
          return { success: false, output: '', error: 'path is required (accepted names: path, filePath)' };
        }
        const resolvedPath = safePath(rawPath, workDir);
        const encoding = (args.encoding || 'utf-8') as BufferEncoding;
        const content = await fs.readFile(resolvedPath, encoding);

        if (args.offset !== undefined || args.limit !== undefined) {
          const allLines = content.split('\n');
          const totalLines = allLines.length;
          let start = (args.offset as number) || 1;
          if (start < 0) start = totalLines + start + 1;
          start = Math.max(1, Math.min(start, totalLines));
          const end = args.limit !== undefined
            ? Math.max(start, Math.min(start + (args.limit as number) - 1, totalLines))
            : totalLines;
          const selectedLines = allLines.slice(start - 1, end);
          const numbered = selectedLines
            .map((line, idx) => `${start + idx}: ${line}`)
            .join('\n');
          return {
            success: true,
            output: `${rawPath} (lines ${start}-${end}, total ${totalLines})\n${'─'.repeat(40)}\n${numbered}`,
          };
        }

        // 无窗口参数：大文件软截断，避免整文件灌入主上下文（仍可通过 offset/limit 分段读取）
        const maxLines = getReadFileDefaultMaxLines();
        const maxChars = getReadFileDefaultMaxChars();
        const allLines = content.split('\n');
        let lines = allLines;
        let truncated = false;
        if (allLines.length > maxLines) {
          lines = allLines.slice(0, maxLines);
          truncated = true;
        }
        let body = lines.join('\n');
        if (body.length > maxChars) {
          body = body.slice(0, maxChars);
          const lastNl = body.lastIndexOf('\n');
          if (lastNl > maxChars * 0.4) body = body.slice(0, lastNl);
          truncated = true;
        }
        if (!truncated) {
          return { success: true, output: content };
        }
        const totalLines = allLines.length;
        const totalChars = content.length;
        const header =
          `${rawPath} (partial read: lines 1–${lines.length}/${totalLines}, chars ~${body.length}/${totalChars} — use offset and limit to read more)\n` +
          `${'─'.repeat(40)}`;
        return { success: true, output: `${header}\n${body}` };
      },
    },

    // ---- 写入文件 ----
    {
      definition: {
        name: 'write_file',
        // 创建新文件或覆盖已有文件。修改部分内容用 edit_file。追加用 append_file。
        description: 'Create new file or completely overwrite a SMALL existing file (prefer under ~150 lines). Auto-creates parent directories. For partial/large edits use patch_file or edit_file; for appending use append_file. Pass path and content as top-level JSON fields (never wrap in raw/arguments). Payloads over ~10k chars or ~150 lines trigger a warning; over ~22k chars are rejected — use patch_file or split writes. If truncated or skipped due to max_tokens, switch to patch_file or smaller edits — do not retry the same full payload.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to work directory). Top-level field; alias: filePath' },
            content: { type: 'string', description: 'Content to write. Top-level string field alongside path' },
            encoding: { type: 'string', description: 'File encoding, default utf-8', default: 'utf-8' },
          },
          required: ['path', 'content'],
        },
      },
      handler: async (args) => {
        const rawPath = args.path || args.filePath;
        if (!rawPath) return { success: false, output: '', error: 'path is required (accepted names: path, filePath)' };
        const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
        const blockChars = getWriteFileBlockChars();
        if (content.length > blockChars) {
          return {
            success: false,
            output: '',
            error: `write_file payload too large (${content.length} chars, limit ${blockChars}). Use patch_file (small unified diff hunks), edit_file, append_file in chunks, or split into multiple files — do not retry the same full payload.`,
          };
        }
        const filePath = safePath(rawPath, workDir);
        const oldContent = await readFileTextOrEmpty(() => fs.readFile(filePath, 'utf-8'));
        await getEditHistory().saveSnapshot(filePath, 'write_file');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, (args.encoding || 'utf-8') as BufferEncoding);

        const lineCount = content.split('\n').length;
        const warnChars = getWriteFileWarnChars();
        const warnLines = getWriteFileWarnLines();
        const large = content.length > warnChars || lineCount > warnLines;
        const warnNote = large
          ? ` Warning: large payload (${content.length} chars, ${lineCount} lines). Prefer patch_file or edit_file for future changes to this file.`
          : '';

        const diff = buildFileChangeDiff(oldContent, content, rawPath);
        return {
          success: true,
          output: formatToolOutputWithDiff(`File written: ${rawPath}${warnNote}`, diff),
        };
      },
    },

    // ---- 追加文件 ----
    {
      definition: {
        name: 'append_file',
        // 向文件末尾追加。修改已有内容用 edit_file。
        description: 'Append content to end of file. Creates file if not exists. For modifying existing content use edit_file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to work directory)' },
            content: { type: 'string', description: 'Content to append' },
          },
          required: ['path', 'content'],
        },
      },
      handler: async (args) => {
        const filePath = safePath(args.path, workDir);
        const appendContent = String(args.content ?? '');
        const oldContent = await readFileTextOrEmpty(() => fs.readFile(filePath, 'utf-8'));
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, appendContent, 'utf-8');
        const newContent = oldContent + appendContent;
        const diff = buildFileChangeDiff(oldContent, newContent, args.path);
        return {
          success: true,
          output: formatToolOutputWithDiff(`Content appended to: ${args.path}`, diff),
        };
      },
    },

    // ---- 修改文件（查找替换） ----
    {
      definition: {
        name: 'edit_file',
        // 查找替换。search 必须精确匹配现有内容。多处修改用 batch_edit_file。大段修改用 patch_file。
        description: 'Find and replace in existing file. search matches exactly or with fuzzy whitespace/line trim. Keep search short and unique. Pass path, search, replace as top-level fields (alias: filePath). For multiple changes use batch_edit_file. For large/multi-hunk changes prefer patch_file. For new files use write_file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to work directory)' },
            search: { type: 'string', description: 'Content to search for (string or regex)' },
            replace: { type: 'string', description: 'Replacement content' },
            isRegex: { type: 'boolean', description: 'Whether to use regex matching', default: false },
            replaceAll: { type: 'boolean', description: 'Whether to replace all matches', default: true },
          },
          required: ['path', 'search', 'replace'],
        },
      },
      handler: async (args) => {
        const rawPath = args.path || args.filePath;
        if (!rawPath) return { success: false, output: '', error: 'path is required (accepted names: path, filePath)' };
        const filePath = safePath(rawPath, workDir);
        const content = await fs.readFile(filePath, 'utf-8');

        let newContent: string;
        let fuzzyMatch = false;

        if (args.isRegex) {
          const flags = args.replaceAll !== false ? 'g' : '';
          newContent = content.replace(new RegExp(args.search, flags), args.replace);
        } else {
          const result = applyNonRegexReplace(
            content,
            String(args.search),
            String(args.replace),
            args.replaceAll !== false,
          );
          if (!result.changed) {
            return {
              success: false,
              output: '',
              error: `No match found for search string in ${rawPath}. Try a shorter unique snippet, read_file to verify exact text, or use patch_file for larger edits.`,
            };
          }
          newContent = result.content;
          fuzzyMatch = result.fuzzy;
        }

        const changed = content !== newContent;
        if (changed) {
          await getEditHistory().saveSnapshot(filePath, 'edit_file');
        }
        await fs.writeFile(filePath, newContent, 'utf-8');

        const fuzzyNote = fuzzyMatch ? ' (fuzzy whitespace/line match)' : '';

        const summary = changed
          ? `File modified: ${rawPath}${fuzzyNote}`
          : `No match found, file unchanged: ${rawPath}`;
        const diff = changed ? buildFileChangeDiff(content, newContent, rawPath) : null;

        return {
          success: true,
          output: formatToolOutputWithDiff(summary, diff),
        };
      },
    },

    // ---- 文件系统操作（合并 delete_file, list_directory, create_directory, move_file, copy_file） ----
    {
      definition: {
        name: 'fs_operation',
        description:
          'File system operations. operation: "list" — list directory contents (supports recursive, maxDepth); "create_dir" — create directory (auto-creates parents); "delete" — delete a file; "move" — move/rename file or directory (requires target); "copy" — copy file or directory recursively (requires target). Use overwrite: true to overwrite existing targets for move/copy.',
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['list', 'create_dir', 'delete', 'move', 'copy'],
              description: 'Operation: list (list dir), create_dir (create dir), delete (delete file), move (move/rename), copy (copy file/dir)',
            },
            path: { type: 'string', description: 'Target path relative to work directory' },
            target: { type: 'string', description: 'Destination path for move or copy operations' },
            recursive: { type: 'boolean', description: 'Recursive listing for list operation', default: false },
            maxDepth: { type: 'number', description: 'Max recursion depth for list, default 3', default: 3 },
            overwrite: { type: 'boolean', description: 'Overwrite existing target for move/copy, default false', default: false },
          },
          required: ['operation', 'path'],
        },
      },
      handler: async (args) => {
        const op = args.operation as string;
        const rawPath = args.path || args.filePath;
        if (!rawPath) return { success: false, output: '', error: 'path is required (accepted names: path, filePath)' };
        const filePath = safePath(rawPath, workDir);

        switch (op) {
          case 'list': {
            const recursive = args.recursive || false;
            const maxDepth = args.maxDepth || 3;
            const entries = await listDir(filePath, workDir, recursive, maxDepth, 0);
            return { success: true, output: entries.join('\n') };
          }
          case 'create_dir': {
            await fs.mkdir(filePath, { recursive: true });
            return { success: true, output: `Directory created: ${args.path}` };
          }
          case 'delete': {
            await fs.unlink(filePath);
            return { success: true, output: `File deleted: ${args.path}` };
          }
          case 'move': {
            const target = args.target as string;
            if (!target) return { success: false, output: '', error: 'target is required for move operation' };
            const destPath = safePath(target, workDir);
            const overwrite = args.overwrite || false;
            try { await fs.access(filePath); } catch { return { success: false, output: '', error: `Source not found: ${args.path}` }; }
            if (!overwrite) {
              try { await fs.access(destPath); return { success: false, output: '', error: `Target exists: ${target}. Set overwrite: true to replace.` }; } catch { /* ok */ }
            }
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.rename(filePath, destPath);
            return { success: true, output: `Moved: ${args.path} → ${target}` };
          }
          case 'copy': {
            const target = args.target as string;
            if (!target) return { success: false, output: '', error: 'target is required for copy operation' };
            const destPath = safePath(target, workDir);
            const overwrite = args.overwrite || false;
            let srcStat;
            try { srcStat = await fs.stat(filePath); } catch { return { success: false, output: '', error: `Source not found: ${args.path}` }; }
            if (!overwrite) {
              try { await fs.access(destPath); return { success: false, output: '', error: `Target exists: ${target}. Set overwrite: true to replace.` }; } catch { /* ok */ }
            }
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            if (srcStat.isDirectory()) {
              await copyDir(filePath, destPath);
              return { success: true, output: `Copied directory: ${args.path} → ${target}` };
            }
            await fs.copyFile(filePath, destPath);
            return { success: true, output: `Copied file: ${args.path} → ${target}` };
          }
          default:
            return { success: false, output: '', error: `Unknown operation: ${op}. Valid: list, create_dir, delete, move, copy` };
        }
      },
    },

    // ---- 获取文件信息 ----
    {
      definition: {
        name: 'file_info',
        // 获取文件元信息：大小、修改时间、类型。
        description: 'Get file or directory metadata: size, modification time, type.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File or directory path (relative to work directory)' },
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
 * 递归复制目录。
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
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
