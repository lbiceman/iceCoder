import { defineConfig } from 'vite';
import path from 'path';

const apiPort = Number(process.env.PORT) || 1024;
const vitePort = Number(process.env.VITE_PORT) || 1025;

export default defineConfig({
  root: path.resolve(__dirname, 'src/public'),
  plugins: [
    {
      name: 'icecoder-favicon-ico',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const url = req.url?.split('?')[0];
          if (url === '/favicon.ico') {
            req.url = '/favicon.svg';
          }
          next();
        });
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
