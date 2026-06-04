/**
 * 本地开发用：由 npm run dev 的 concurrently 拉起 cloudflared。
 * 不进入 npm pack（files 仅含 dist/）；路径通过 CLOUDFLARED_BIN 配置，无硬编码。
 */
import { spawn } from 'node:child_process';

const bin = process.env.CLOUDFLARED_BIN?.trim();
if (!bin) {
  console.warn(
    '[dev:tunnel] 未设置 CLOUDFLARED_BIN，跳过 cloudflared。请在环境变量或 .env 中配置可执行文件路径。',
  );
  process.exit(0);
}

const apiPort = process.env.PORT?.trim() || '3784';
const metricsPort = process.env.ICE_TUNNEL_METRICS_PORT?.trim() || '20341';
const metricsHost = process.env.ICE_TUNNEL_METRICS_HOST?.trim() || '127.0.0.1';

const child = spawn(
  bin,
  ['tunnel', '--url', `http://127.0.0.1:${apiPort}`, '--metrics', `${metricsHost}:${metricsPort}`],
  { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true },
);

child.on('error', (err) => {
  console.error('[dev:tunnel] cloudflared 启动失败:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
