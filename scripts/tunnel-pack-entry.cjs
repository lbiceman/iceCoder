/**
 * 恢复隧道入口为发布 stub（tunnel-dev-entry 的逆操作）。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const patches = [
  {
    target: path.join(root, 'src/web/quicktunnel-url.ts'),
    body: "export * from './tunnel-stubs/quicktunnel-url.js';\n",
  },
  {
    target: path.join(root, 'src/web/tunnel-ready-watcher.ts'),
    body: "export * from './tunnel-stubs/tunnel-ready-watcher.js';\n",
  },
  {
    target: path.join(root, 'src/cli/tunnel/cloudflared-tunnel.ts'),
    body: "export * from '../../web/tunnel-stubs/cloudflared-tunnel.js';\n",
  },
];

for (const { target, body } of patches) {
  fs.writeFileSync(target, body, 'utf8');
}
