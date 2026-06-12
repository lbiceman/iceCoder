/**
 * CLI start 时拉起 cloudflared Quick Tunnel。仅本地开发（ICE_TUNNEL_DEV=1）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolveTunnelMetricsListenAddress } from './quicktunnel-url.js';
import { c, info, warn, error } from '../../cli/utils/terminal-ui.js';

async function findCloudflared(customBin?: string): Promise<string | null> {
  const candidates = [customBin, process.env.CLOUDFLARED_BIN, 'cloudflared'].filter(Boolean) as string[];

  for (const bin of candidates) {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`${bin} --version`, { stdio: 'ignore', timeout: 5000 });
      return bin;
    } catch {
      // 不可用，继续尝试下一个
    }
  }
  return null;
}

/**
 * 启动 Cloudflare Tunnel 子进程。
 * 如果 cloudflared 不存在，提示用户下载并跳过。
 */
export async function startTunnel(port: number, tunnelBin?: string): Promise<ChildProcess | null> {
  const bin = await findCloudflared(tunnelBin);

  if (!bin) {
    warn('未检测到 cloudflared，跳过公网隧道。');
    console.log(`
  ${c.bold}安装 cloudflared:${c.reset}
    Windows:  ${c.cyan}winget install cloudflare.cloudflared${c.reset}
    macOS:    ${c.cyan}brew install cloudflared${c.reset}
    Linux:    ${c.cyan}curl -fsSL https://pkg.cloudflare.com/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared${c.reset}
    手动下载: ${c.underline}https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/${c.reset}

  本地开发请设置 ${c.green}CLOUDFLARED_BIN${c.reset} 或 ${c.green}--tunnel-bin <路径>${c.reset}。
`);
    return null;
  }

  info(`启动 Cloudflare Tunnel: ${bin}`);

  const tunnelArgs = ['tunnel', '--url', `http://127.0.0.1:${port}`, '--metrics', resolveTunnelMetricsListenAddress()];
  const child = spawn(bin, tunnelArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    const urlMatch = msg.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (urlMatch) {
      info(`🌐 公网地址: ${c.underline}${urlMatch[0]}${c.reset}`);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    const urlMatch = msg.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (urlMatch) {
      info(`🌐 公网地址: ${c.underline}${urlMatch[0]}${c.reset}`);
    }
  });

  child.on('error', (err) => {
    error(`Cloudflare Tunnel 启动失败: ${err.message}`);
    info('可通过 --no-tunnel 跳过，或 --tunnel-bin / CLOUDFLARED_BIN 指定 cloudflared 路径');
  });

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      error(`Cloudflare Tunnel 控制台退出 (code: ${code})`);
    }
  });

  return child;
}
