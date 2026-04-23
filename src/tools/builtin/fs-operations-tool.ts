/**
 * 文件系统操作工具集。
 * 提供创建目录、移动/重命名、复制文件或目录的能力。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RegisteredTool } from '../types.js';

function safePath(filePath: string, baseDir: string): string {
  return path.resolve(baseDir, filePath);
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
 * 创建文件系统操作工具集。
 */
export function createFsOperationsTools(workDir: string): RegisteredTool[] {
  return [
    // ---- 创建目录 ----
    {
      definition: {
        name: 'create_directory',
        description: '创建目录。支持递归创建多层嵌套目录。如果目录已存在则不报错。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '目录路径（相对于工作目录）' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const dirPath = safePath(args.path, workDir);
        await fs.mkdir(dirPath, { recursive: true });
        return { success: true, output: `目录已创建: ${args.path}` };
      },
    },

    // ---- 移动/重命名 ----
    {
      definition: {
        name: 'move_file',
        description:
          '移动或重命名文件/目录。如果目标路径的父目录不存在会自动创建。可用于重命名（同目录下移动）或跨目录移动。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '源路径（相对于工作目录）' },
            destination: { type: 'string', description: '目标路径（相对于工作目录）' },
            overwrite: {
              type: 'boolean',
              description: '如果目标已存在是否覆盖，默认 false',
              default: false,
            },
          },
          required: ['source', 'destination'],
        },
      },
      handler: async (args) => {
        const srcPath = safePath(args.source, workDir);
        const destPath = safePath(args.destination, workDir);
        const overwrite = args.overwrite || false;

        // 检查源是否存在
        try {
          await fs.access(srcPath);
        } catch {
          return { success: false, output: '', error: `源路径不存在: ${args.source}` };
        }

        // 检查目标是否已存在
        if (!overwrite) {
          try {
            await fs.access(destPath);
            return {
              success: false,
              output: '',
              error: `目标路径已存在: ${args.destination}。设置 overwrite: true 可覆盖。`,
            };
          } catch {
            // 目标不存在，继续
          }
        }

        // 确保目标父目录存在
        await fs.mkdir(path.dirname(destPath), { recursive: true });

        await fs.rename(srcPath, destPath);
        return {
          success: true,
          output: `已移动: ${args.source} → ${args.destination}`,
        };
      },
    },

    // ---- 复制文件/目录 ----
    {
      definition: {
        name: 'copy_file',
        description:
          '复制文件或目录。支持递归复制整个目录树。如果目标路径的父目录不存在会自动创建。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '源路径（相对于工作目录）' },
            destination: { type: 'string', description: '目标路径（相对于工作目录）' },
            overwrite: {
              type: 'boolean',
              description: '如果目标已存在是否覆盖，默认 false',
              default: false,
            },
          },
          required: ['source', 'destination'],
        },
      },
      handler: async (args) => {
        const srcPath = safePath(args.source, workDir);
        const destPath = safePath(args.destination, workDir);
        const overwrite = args.overwrite || false;

        // 检查源是否存在
        let srcStat;
        try {
          srcStat = await fs.stat(srcPath);
        } catch {
          return { success: false, output: '', error: `源路径不存在: ${args.source}` };
        }

        // 检查目标是否已存在
        if (!overwrite) {
          try {
            await fs.access(destPath);
            return {
              success: false,
              output: '',
              error: `目标路径已存在: ${args.destination}。设置 overwrite: true 可覆盖。`,
            };
          } catch {
            // 目标不存在，继续
          }
        }

        // 确保目标父目录存在
        await fs.mkdir(path.dirname(destPath), { recursive: true });

        if (srcStat.isDirectory()) {
          await copyDir(srcPath, destPath);
          return {
            success: true,
            output: `已复制目录: ${args.source} → ${args.destination}`,
          };
        } else {
          await fs.copyFile(srcPath, destPath);
          return {
            success: true,
            output: `已复制文件: ${args.source} → ${args.destination}`,
          };
        }
      },
    },
  ];
}
