/**
 * Express Web 服务器，提供 API 路由。
 * 开发模式下前端由 Vite dev server 提供（通过 proxy 转发 API 请求）。
 * 生产模式下提供 Vite 构建产物的静态文件托管和 SPA 回退。
 */

import express, {
  type Express,
  type Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { ListenOptions } from 'node:net';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSetupGateMiddleware } from './setup-gate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8,}\.[^.]+$/;

/**
 * 创建 Express 服务器的配置。
 */
export interface ServerConfig {
  /** 提供静态文件的目录（生产模式）。默认为 dist/public。 */
  staticDir?: string;
  /** 要挂载到应用的 API 路由。 */
  routes?: { path: string; router: Router }[];
  /** 未完成主配置时拦截非配置类 API */
  setupGate?: () => boolean;
}

/**
 * 创建并配置 Express 应用。
 */
export async function createServer(config?: ServerConfig): Promise<Express> {
  const app = express();

  // 解析 JSON 和 URL 编码的请求体
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (config?.setupGate) {
    app.use(createSetupGateMiddleware(config.setupGate));
  }

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

  const faviconSvgPath = path.join(staticDir, 'favicon.svg');
  /** 浏览器默认请求 /favicon.ico；须先于 SPA 回退，否则会被改成返回 index.html */
  const sendFaviconIco: express.RequestHandler = (_req, res, next: NextFunction) => {
    if (!fs.existsSync(faviconSvgPath)) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.type('image/svg+xml');
    res.sendFile(faviconSvgPath);
  };

  if (isProd) {
    app.use(express.static(staticDir, {
      setHeaders: (res, filePath) => {
        // Vite 指纹资源的 URL 会随内容变化，可跨应用重启复用浏览器磁盘缓存；
        // HTML 和未指纹化的 pet 原始资源保持不缓存，避免发布后引用旧文件。
        if (filePath.includes(`${path.sep}assets${path.sep}`) && HASHED_ASSET_NAME.test(path.basename(filePath))) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return;
        }
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      },
    }));
    app.get('/favicon.ico', sendFaviconIco);
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
    app.get('/favicon.ico', sendFaviconIco);
    app.get('/{*splat}', (_req: Request, res: Response) => {
      if (_req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  return app;
}

/** 用于 ::1 / 127.0.0.1 启动后自检，确认是本进程的 iceCoder 首页而非其它占用端口的程序（须 dev/prod index 共有，勿用 Vite 哈希资源路径） */
const LOOPBACK_APP_MARKER = 'id="page-container"';

async function probeOurApp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const body = await res.text();
    return body.includes(LOOPBACK_APP_MARKER);
  } catch {
    return false;
  }
}

async function probeLoopbacks(actualPort: number): Promise<{ v4: boolean; v6: boolean }> {
  const [v4, v6] = await Promise.all([
    probeOurApp(`http://127.0.0.1:${actualPort}/`),
    probeOurApp(`http://[::1]:${actualPort}/`),
  ]);
  return { v4, v6 };
}

function listenOnce(server: Server, opts: number | ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(opts);
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * 在指定端口启动 Express 服务器。
 *
 * Windows 上 `localhost` 常解析为 ::1；若 [::1]:port 上另有进程占位，而本进程只监听 IPv4，会出现
 * 「服务已启动但 http://localhost:port 404」。启动后自检 127.0.0.1 与 ::1 是否都返回本项目首页；
 * 若只有 ::1 异常，日志会提示改用 127.0.0.1 或换端口（`-p`，如 3784）。
 */
export function startServer(app: Express, port: number): Promise<Server> {
  return startServerWithLoopbackProbe(app, port);
}

async function startServerWithLoopbackProbe(app: Express, port: number): Promise<Server> {
  let server = http.createServer(app);
  try {
    await listenOnce(server, { port, host: '::', ipv6Only: false });
  } catch {
    await closeHttpServer(server).catch(() => {});
    server = http.createServer(app);
    try {
      await listenOnce(server, { port });
    } catch (err) {
      await closeHttpServer(server).catch(() => {});
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EADDRINUSE') {
        const msg = `Port ${port} is already in use`;
        console.error(msg);
        process.exit(1);
        throw new Error(msg);
      }
      throw err;
    }
  }

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  const { v4, v6 } = await probeLoopbacks(actualPort);

  if (!v4) {
    await closeHttpServer(server).catch(() => {});
    throw new Error(`Web server started but loopback probe failed for 127.0.0.1:${actualPort}`);
  }

  console.log(`API server listening on http://127.0.0.1:${actualPort}`);

  if (!v6) {
    console.warn(
      `[web] 「http://localhost:${actualPort}/」在本机 [::1]:${actualPort} 仍可能指向其它程序（你已看到 404）。`
        + ` 请使用 http://127.0.0.1:${actualPort}/ ，或换端口：iceCoder web -p <port> 或设置 PORT`,
    );
  }

  return server;
}
