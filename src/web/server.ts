/**
 * Express Web 服务器，提供 API 路由。
 * 开发模式下前端由 Vite dev server 提供（通过 proxy 转发 API 请求）。
 * 生产模式下提供 Vite 构建产物的静态文件托管和 SPA 回退。
 */

import express, { type Express, type Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Server } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 创建 Express 服务器的配置。
 */
export interface ServerConfig {
  /** 提供静态文件的目录（生产模式）。默认为 dist/public。 */
  staticDir?: string;
  /** 要挂载到应用的 API 路由。 */
  routes?: { path: string; router: Router }[];
}

/**
 * 创建并配置 Express 应用。
 */
export async function createServer(config?: ServerConfig): Promise<Express> {
  const app = express();

  // 解析 JSON 和 URL 编码的请求体
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // 挂载 API 路由
  if (config?.routes) {
    for (const route of config.routes) {
      app.use(route.path, route.router);
    }
  }

  // 静态文件托管
  // 路径解析：__dirname 在编译后是 dist/web/，优先找 dist/public，回退 src/public
  const isProd = process.env.NODE_ENV === 'production';
  const distPublic = path.join(__dirname, '../public');       // dist/web/../public = dist/public
  const srcPublic = path.join(__dirname, '../../src/public'); // 开发模式回退
  const staticDir = config?.staticDir ?? (
    fs.existsSync(distPublic) ? distPublic : srcPublic
  );

  if (isProd) {
    app.use(express.static(staticDir));
    app.get('/{*splat}', (_req: Request, res: Response) => {
      if (_req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  } else {
    // 开发模式：JS/CSS 也不缓存，方便调试
    app.use(express.static(staticDir, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      },
    }));
    app.get('/{*splat}', (_req: Request, res: Response) => {
      if (_req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  return app;
}

/**
 * 在指定端口启动 Express 服务器。
 */
export function startServer(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const server = app.listen(port);

    server.on('listening', () => {
      if (!settled) {
        settled = true;
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        console.log(`API server listening on http://localhost:${actualPort}`);
        resolve(server);
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        if (err.code === 'EADDRINUSE') {
          const error = new Error(`Port ${port} is already in use`);
          console.error(error.message);
          reject(error);
          process.exit(1);
        } else {
          reject(err);
        }
      }
    });
  });
}
