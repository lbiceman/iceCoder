import { defineConfig } from 'vite';
import path from 'path';

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
    port: 1025,
    // 将 API 请求代理到 Express 后端
    proxy: {
      '/api': {
        target: 'http://localhost:1024',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
