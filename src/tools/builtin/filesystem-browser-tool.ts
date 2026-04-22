/**
 * 系统文件浏览器工具。
 * 提供浏览电脑任意路径的能力，不限于工作目录。
 * 支持：列出驱动器、浏览目录、读取文件内容。
 *
 * 用于移动端通过聊天界面远程浏览电脑文件系统。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RegisteredTool } from '../types.js';

const execAsync = promisify(exec);

/** 文件大小可读格式 */
function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/** 判断是否为文本文件（通过扩展名） */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.scss',
  '.html', '.htm', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1', '.py',
  '.rb', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs',
  '.swift', '.kt', '.scala', '.lua', '.r', '.sql', '.graphql',
  '.env', '.gitignore', '.editorconfig', '.prettierrc', '.eslintrc',
  '.log', '.csv', '.tsv', '.svg', '.vue', '.svelte', '.astro',
]);

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  // 无扩展名的常见文本文件
  const basename = path.basename(filePath).toLowerCase();
  if (['makefile', 'dockerfile', 'readme', 'license', 'changelog'].includes(basename)) {
    return true;
  }
  return TEXT_EXTENSIONS.has(ext);
}

/** 最大可读取的文件大小（5MB） */
const MAX_READ_SIZE = 10 * 1024 * 1024;

/**
 * 列出 Windows 驱动器盘符。
 */
async function listWindowsDrives(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('wmic logicaldisk get name', { timeout: 5000 });
    const drives = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^[A-Z]:$/i.test(line))
      .map(d => d + '\\');
    return drives.length > 0 ? drives : ['C:\\'];
  } catch {
    // 备用方案：用 PowerShell
    try {
      const { stdout } = await execAsync(
        'powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root"',
        { timeout: 5000 },
      );
      const drives = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      return drives.length > 0 ? drives : ['C:\\'];
    } catch {
      return ['C:\\'];
    }
  }
}

/**
 * 创建系统文件浏览器工具集。
 */
export function createFilesystemBrowserTools(): RegisteredTool[] {
  return [
    // ---- 列出驱动器 / 根目录 ----
    {
      definition: {
        name: 'list_drives',
        description: '列出电脑上所有可用的磁盘驱动器（如 C:\\, D:\\）。用于文件浏览的起点。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      handler: async () => {
        const platform = process.platform;

        if (platform === 'win32') {
          const drives = await listWindowsDrives();
          const lines = drives.map(d => `💾 ${d}`);
          return {
            success: true,
            output: `[当前路径] /\n电脑磁盘驱动器:\n${lines.join('\n')}\n\n用户说 "打开 X:" 时，直接调用 browse_directory({ path: "X:\\\\" }) 即可。`,
          };
        } else {
          // macOS / Linux
          const rootItems = await fs.readdir('/', { withFileTypes: true });
          const dirs = rootItems
            .filter(item => item.isDirectory())
            .map(item => `📁 /${item.name}`)
            .slice(0, 30);
          return {
            success: true,
            output: `根目录内容:\n${dirs.join('\n')}\n\n常用路径: /home, /Users, /tmp`,
          };
        }
      },
    },

    // ---- 浏览任意目录 ----
    {
      definition: {
        name: 'browse_directory',
        description: '浏览电脑上任意目录的内容。支持绝对路径（如 D:\\Projects, /home/user）。显示文件和文件夹列表，包含大小和修改时间。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '要浏览的目录的绝对路径（如 D:\\Projects 或 /home/user/documents）',
            },
            showHidden: {
              type: 'boolean',
              description: '是否显示隐藏文件（以.开头的文件）',
              default: false,
            },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const dirPath = path.resolve(args.path);
        const showHidden = args.showHidden || false;

        // 检查路径是否存在
        let stat;
        try {
          stat = await fs.stat(dirPath);
        } catch {
          return { success: false, output: '', error: `路径不存在: ${dirPath}` };
        }

        // 如果是文件，返回文件信息
        if (stat.isFile()) {
          return {
            success: true,
            output: `这是一个文件，不是目录。\n📄 ${dirPath}\n大小: ${formatSize(stat.size)}\n修改时间: ${stat.mtime.toLocaleString()}\n\n如需查看文件内容，请说 "打开这个文件" 或使用 open_file 工具。`,
          };
        }

        if (!stat.isDirectory()) {
          return { success: false, output: '', error: `不是有效的目录: ${dirPath}` };
        }

        // 读取目录内容
        let items;
        try {
          items = await fs.readdir(dirPath, { withFileTypes: true });
        } catch (err: any) {
          return { success: false, output: '', error: `无法读取目录: ${err.message}` };
        }

        // 过滤隐藏文件
        if (!showHidden) {
          items = items.filter(item => !item.name.startsWith('.'));
        }

        // 分类：目录在前，文件在后
        const dirs: string[] = [];
        const files: string[] = [];

        for (const item of items) {
          const fullPath = path.join(dirPath, item.name);
          try {
            const itemStat = await fs.stat(fullPath);
            if (item.isDirectory()) {
              dirs.push(`📁 ${item.name}/`);
            } else {
              files.push(`📄 ${item.name}  (${formatSize(itemStat.size)})`);
            }
          } catch {
            // 无法访问的项目，跳过
            if (item.isDirectory()) {
              dirs.push(`📁 ${item.name}/ [无法访问]`);
            } else {
              files.push(`📄 ${item.name} [无法访问]`);
            }
          }
        }

        const totalDirs = dirs.length;
        const totalFiles = files.length;

        // 限制显示数量，避免输出过长
        const maxShow = 50;
        const truncatedDirs = dirs.slice(0, maxShow);
        const truncatedFiles = files.slice(0, maxShow);

        let output = `[当前路径] ${dirPath}\n`;
        output += `共 ${totalDirs} 个文件夹, ${totalFiles} 个文件\n`;
        output += '─'.repeat(40) + '\n';

        if (truncatedDirs.length > 0) {
          output += truncatedDirs.join('\n') + '\n';
        }
        if (truncatedFiles.length > 0) {
          output += truncatedFiles.join('\n') + '\n';
        }

        if (totalDirs > maxShow || totalFiles > maxShow) {
          output += `\n... 还有更多项目未显示（共 ${totalDirs + totalFiles} 项）`;
        }

        output += `\n\n用户说 "进入 XXX" 时，直接拼接: ${dirPath}${path.sep}XXX，一次调用即可。`;

        return { success: true, output };
      },
    },

    // ---- 打开/读取任意文件 ----
    {
      definition: {
        name: 'open_file',
        description: '读取电脑上任意位置的文件内容。支持绝对路径。自动判断文本/二进制文件。对于文本文件显示内容，对于二进制文件显示文件信息。',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '要读取的文件的绝对路径（如 D:\\docs\\readme.txt）',
            },
            encoding: {
              type: 'string',
              description: '文件编码，默认 utf-8',
              default: 'utf-8',
            },
            maxLines: {
              type: 'number',
              description: '最多读取的行数，默认不限制。对于大文件建议设置此参数。',
            },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const filePath = path.resolve(args.path);
        const encoding = (args.encoding || 'utf-8') as BufferEncoding;

        // 检查文件是否存在
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          return { success: false, output: '', error: `文件不存在: ${filePath}` };
        }

        if (stat.isDirectory()) {
          return {
            success: false,
            output: '',
            error: `这是一个目录，不是文件。请使用 browse_directory 工具浏览目录。`,
          };
        }

        if (!stat.isFile()) {
          return { success: false, output: '', error: `不是有效的文件: ${filePath}` };
        }

        // 文件信息头
        const ext = path.extname(filePath).toLowerCase();
        let header = `📄 ${filePath}\n`;
        header += `大小: ${formatSize(stat.size)} | 修改时间: ${stat.mtime.toLocaleString()}\n`;
        header += '─'.repeat(40) + '\n';

        // 检查是否为文本文件
        if (!isTextFile(filePath)) {
          return {
            success: true,
            output: header + `\n这是一个二进制文件 (${ext || '未知类型'})，无法直接显示内容。\n文件大小: ${formatSize(stat.size)}`,
          };
        }

        // 检查文件大小
        if (stat.size > MAX_READ_SIZE) {
          return {
            success: true,
            output: header + `\n文件过大 (${formatSize(stat.size)})，超过 ${formatSize(MAX_READ_SIZE)} 的限制。\n建议使用 maxLines 参数限制读取行数。`,
          };
        }

        // 读取文件内容
        try {
          let content = await fs.readFile(filePath, encoding);
          const maxLines = args.maxLines as number | undefined;

          if (maxLines && maxLines > 0) {
            const lines = content.split('\n');
            const totalLines = lines.length;
            content = lines.slice(0, maxLines).join('\n');
            if (totalLines > maxLines) {
              content += `\n\n... 还有 ${totalLines - maxLines} 行未显示（共 ${totalLines} 行）`;
            }
          }

          return { success: true, output: header + content };
        } catch (err: any) {
          return { success: false, output: '', error: `读取文件失败: ${err.message}` };
        }
      },
    },
  ];
}
