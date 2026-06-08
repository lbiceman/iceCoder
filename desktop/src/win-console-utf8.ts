import { execSync } from 'node:child_process';

let applied = false;

/**
 * Windows 控制台默认 CP936(GBK)，UTF-8 中文日志会显示为乱码。
 * 在 Electron 主进程启动时切换到 UTF-8 code page。
 */
export function ensureWinConsoleUtf8(): void {
  if (applied || process.platform !== 'win32') return;
  applied = true;
  try {
    execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch {
    // 无附加控制台时忽略
  }
  try {
    if (process.stdout.isTTY) process.stdout.setDefaultEncoding('utf8');
    if (process.stderr.isTTY) process.stderr.setDefaultEncoding('utf8');
  } catch {
    // ignore
  }
}
