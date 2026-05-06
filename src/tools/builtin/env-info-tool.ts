/**
 * 环境信息工具。
 * 收集系统环境信息：OS、Node.js/Python/Git 版本、包管理器、磁盘空间。
 * LLM 做工具链决策时需要这些信息。
 */

import * as os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { RegisteredTool } from '../types.js';

const execAsync = promisify(exec);

/** 执行命令，失败返回 null */
async function tryExec(cmd: string, timeout = 5000): Promise<string | null> {
  try {
    const { stdout } = await execAsync(cmd, { timeout, encoding: 'utf-8' });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** 格式化字节为可读大小 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx++;
  }
  return `${size.toFixed(1)} ${units[idx]}`;
}

/**
 * 创建环境信息工具。
 */
export function createEnvInfoTool(): RegisteredTool {
  return {
    definition: {
      name: 'env_info',
      // 获取系统环境信息（OS、Node/Python/Git 版本、包管理器、磁盘空间）。
      description:
        'Get system environment info: OS, Node.js/Python/Git versions, package managers, disk space. For making informed decisions about toolchain compatibility.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      const platform = process.platform;
      const arch = process.arch;

      // 并行获取版本信息
      const [nodeVersion, pythonVersion, gitVersion, npmVersion, pnpmVersion, yarnVersion] =
        await Promise.all([
          tryExec('node --version'),
          tryExec('python --version') || tryExec('python3 --version'),
          tryExec('git --version'),
          tryExec('npm --version'),
          tryExec('pnpm --version'),
          tryExec('yarn --version'),
        ]);

      // 磁盘空间（Windows 用 wmic，其他用 df）
      let diskInfo: string | null = null;
      if (platform === 'win32') {
        diskInfo = await tryExec(
          'wmic logicaldisk get size,freespace,caption /format:csv',
          10000,
        );
      } else {
        diskInfo = await tryExec('df -h / 2>/dev/null');
      }

      // 检测 shell
      let shell: string | null = null;
      if (platform === 'win32') {
        shell = process.env.COMSPEC || 'cmd.exe';
      } else {
        shell = process.env.SHELL || '/bin/sh';
      }

      // 组装输出
      const lines: string[] = [];
      lines.push('## System');
      lines.push(`Platform: ${platform}`);
      lines.push(`Architecture: ${arch}`);
      lines.push(`OS Release: ${os.release()}`);
      lines.push(`Hostname: ${os.hostname()}`);
      lines.push(`Shell: ${shell}`);
      lines.push(`Memory: ${formatBytes(os.freemem())} free / ${formatBytes(os.totalmem())} total`);
      lines.push(`CPUs: ${os.cpus().length} cores`);

      lines.push('');
      lines.push('## Toolchain');
      lines.push(`Node.js: ${nodeVersion || 'not found'}`);
      lines.push(`Python: ${pythonVersion || 'not found'}`);
      lines.push(`Git: ${gitVersion || 'not found'}`);

      lines.push('');
      lines.push('## Package Managers');
      lines.push(`npm: ${npmVersion || 'not found'}`);
      lines.push(`pnpm: ${pnpmVersion || 'not found'}`);
      lines.push(`yarn: ${yarnVersion || 'not found'}`);

      if (diskInfo) {
        lines.push('');
        lines.push('## Disk');
        // 只取前几行，避免输出过长
        const diskLines = diskInfo.split('\n').slice(0, 10);
        lines.push(diskLines.join('\n'));
      }

      return { success: true, output: lines.join('\n') };
    },
  };
}
