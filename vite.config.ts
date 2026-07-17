import fs from 'node:fs';
import { defineConfig } from 'vite';
import path from 'path';

const apiPort = Number(process.env.PORT) || 1024;
const vitePort = Number(process.env.VITE_PORT) || 1025;
const repoRoot = __dirname;
const publicRoot = path.resolve(repoRoot, 'src/public');
const distPublic = path.resolve(repoRoot, 'dist/public');

function copyDirSync(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else fs.copyFileSync(from, to);
  }
}

export default defineConfig({
  root: publicRoot,
  plugins: [
    {
      name: 'icecoder-favicon-ico',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const url = req.url?.split('?')[0];
          if (url === '/favicon.ico') {
            req.url = '/icons/favicon.svg';
          }
          next();
        });
      },
    },
    {
      name: 'icecoder-copy-static-assets',
      closeBundle() {
        const iconsSrc = path.join(publicRoot, 'icons');
        if (fs.existsSync(iconsSrc)) {
          copyDirSync(iconsSrc, path.join(distPublic, 'icons'));
        }
        const indexPath = path.join(distPublic, 'index.html');
        if (fs.existsSync(indexPath)) {
          let html = fs.readFileSync(indexPath, 'utf8');
          html = html.replace(
            /<link rel="icon" href="\/assets\/favicon-[^"]+\.svg" type="image\/svg\+xml">/,
            '<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">',
          );
          fs.writeFileSync(indexPath, html);
        }
      },
    },
  ],
  build: {
    outDir: path.resolve(__dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port: vitePort,
    // 将 API 请求代理到 Express 后端（PORT / VITE_PORT 可覆盖，开发不锁死端口）
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
