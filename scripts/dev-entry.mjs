/**
 * 本地开发唯一入口：npm run dev
 *
 * 默认：API(1024) + Vite(1025) + cloudflared（需 CLOUDFLARED_BIN）
 * 可选：npm run dev -- --api | --web | --no-tunnel | --help
 *
 * CLI 子命令（run / tools / start 等）请安装 tgz 后用全局 iceCoder，
 * 或开发期：npx tsx src/cli/index.ts <子命令>
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const has = (f) => flags.has(f);

const HELP = `
本地开发 — npm run dev

  npm run dev                 API :1024 + Web :1025 + 隧道（浏览器 http://127.0.0.1:1025/）
  npm run dev -- --no-tunnel  不启 cloudflared
  npm run dev -- --api        仅 API（调试）
  npm run dev -- --web        仅 Vite（需 API 已启动）

打包安装后使用全局命令 iceCoder（见 PACKAGE_USAGE.md），例如：
  iceCoder web | iceCoder run "任务" | iceCoder config
`;

if (has('--help') || has('-h')) {
  console.log(HELP.trim());
  process.exit(0);
}

function run(cmd, extraEnv = {}) {
  const result = spawnSync(cmd, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      PORT: process.env.PORT?.trim() || '1024',
      ...extraEnv,
    },
  });
  process.exit(result.status ?? 1);
}

spawnSync('node', ['scripts/tunnel-dev-entry.cjs'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});

const port = process.env.PORT?.trim() || '1024';
const tunnelDev = 'cross-env ICE_TUNNEL_DEV=1';
const apiCmd = `${tunnelDev} ICE_TUNNEL_METRICS_PORT=20341 tsx src/index.ts`;
const webCmd = 'tsx scripts/wait-then-vite.ts';
const tunnelCmd = `${tunnelDev} node scripts/run-dev-cloudflared.mjs`;

if (has('--api')) {
  run(apiCmd, { PORT: port });
}

if (has('--web')) {
  run(webCmd, { PORT: port });
}

if (!has('--no-tunnel')) {
  run(`npx concurrently -n api,web,tunnel -c blue,green,magenta "${apiCmd}" "${webCmd}" "${tunnelCmd}"`, {
    PORT: port,
  });
}

run(`npx concurrently -n api,web -c blue,green "${apiCmd}" "${webCmd}"`, { PORT: port });
