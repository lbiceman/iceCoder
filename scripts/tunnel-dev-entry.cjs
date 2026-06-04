/**
 * 本地开发：将 web/cli 隧道入口重定向到 src/dev/tunnel 实现（tsx 加载前执行一次）。
 * 发布构建不运行此脚本；dist 仅含 tunnel-stubs。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const patches = [
  {
    target: path.join(root, 'src/web/quicktunnel-url.ts'),
    body: "export * from '../dev/tunnel/quicktunnel-url.js';\n",
  },
  {
    target: path.join(root, 'src/web/tunnel-ready-watcher.ts'),
    body: "export * from '../dev/tunnel/tunnel-ready-watcher.js';\n",
  },
  {
    target: path.join(root, 'src/cli/tunnel/cloudflared-tunnel.ts'),
    body: "export * from '../../dev/tunnel/cloudflared-tunnel.js';\n",
  },
];

for (const { target, body } of patches) {
  fs.writeFileSync(target, body, 'utf8');
}
