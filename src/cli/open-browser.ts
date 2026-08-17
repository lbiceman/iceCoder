/**
 * 启动 Web 后用系统默认浏览器打开对应页面。
 * 无第三方依赖；Windows 下必须给 URL 加引号，否则 cmd 会把 `#/settings` 的 `#` 当成注释。
 */

import { exec } from 'node:child_process';
import { hasFlag } from './utils/args-parser.js';
import { c, success, warn } from './utils/terminal-ui.js';

export type OpenBrowserExec = (command: string) => Promise<boolean>;

/** 未配置 API Key 时打开设置页，否则打开桌面聊天页。 */
export function resolveLaunchUrl(port: number, needsSetup: boolean): string {
  const hash = needsSetup ? '/#/settings' : '/#/chat';
  return `http://127.0.0.1:${port}${hash}`;
}

export function shouldOpenBrowser(opts: {
  flags: Record<string, string | boolean>;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = opts.env ?? process.env;
  if (hasFlag(opts.flags, 'no-open')) return false;
  const noOpen = env.ICE_NO_OPEN?.trim().toLowerCase();
  if (noOpen === '1' || noOpen === 'true') return false;
  const ci = env.CI?.trim().toLowerCase();
  if (ci === '1' || ci === 'true') return false;
  return true;
}

/** 拼出可直接交给 shell 的打开命令（纯函数，便于单测）。 */
export function buildOpenBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): string {
  const safe = url.replace(/"/g, '');
  if (platform === 'win32') {
    return `cmd /c start "" "${safe}"`;
  }
  if (platform === 'darwin') {
    return `open "${safe}"`;
  }
  return `xdg-open "${safe}"`;
}

function defaultExec(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * 在允许自动打开时用系统浏览器打开对应页面。
 * 失败不抛错，只打印手动访问地址。
 */
export async function maybeOpenAppInBrowser(opts: {
  port: number;
  needsSetup: boolean;
  flags: Record<string, string | boolean>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execCommand?: OpenBrowserExec;
}): Promise<{ opened: boolean; url: string }> {
  const url = resolveLaunchUrl(opts.port, opts.needsSetup);
  if (!shouldOpenBrowser({ flags: opts.flags, env: opts.env })) {
    return { opened: false, url };
  }

  const command = buildOpenBrowserCommand(url, opts.platform ?? process.platform);
  const execCommand = opts.execCommand ?? defaultExec;
  let opened = false;
  try {
    opened = await execCommand(command);
  } catch {
    opened = false;
  }

  if (opened) {
    success(`已在浏览器打开 ${c.underline}${url}${c.reset}`);
  } else {
    warn(`无法自动打开浏览器，请手动访问 ${c.underline}${url}${c.reset}`);
  }
  return { opened, url };
}
