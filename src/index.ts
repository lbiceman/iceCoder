/**
 * iceCoder 应用入口（Electron 安装包 / `npm start`）。
 *
 * 与 tgz 的 `iceCoder start` / `iceCoder web` 共用 bootstrap 与 startWebServer，
 * 保证 API、MCP、工具初始化与退出清理不再分叉。
 */

import './cli/paths.js';
import { bootstrap } from './cli/bootstrap.js';
import { startWebServer, registerWebRuntimeShutdown } from './cli/commands/serve.js';
import { resolveDefaultApiPort } from './cli/serve-port.js';

const startupStartedAt = performance.now();

function logStartupTiming(phase: string): void {
  console.log(`[startup] server ${phase} +${Math.round(performance.now() - startupStartedAt)}ms`);
}

async function main(): Promise<void> {
  console.log('iceCoder starting...');
  const ctx = await bootstrap();
  logStartupTiming('runtime-initialized');
  const { cleanup } = await startWebServer(ctx, resolveDefaultApiPort());
  logStartupTiming('http-listening');
  registerWebRuntimeShutdown(ctx, cleanup);
  console.log('iceCoder is ready');
  logStartupTiming('ready');
}

main().catch((err) => {
  console.error('Failed to start iceCoder:', err);
  process.exit(1);
});
