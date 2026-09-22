/**
 * Unit tests for the Express web server.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, startServer, resolveDefaultStaticDir, resolveViteDevRedirectOrigin } from '../../src/web/server.js';
import type { Server } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Web Server', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  describe('createServer', () => {
    it('should create an Express app with default configuration', async () => {
      const app = await createServer();
      expect(app).toBeDefined();
      expect(typeof app.listen).toBe('function');
    });

    it('should create an Express app with custom static directory', async () => {
      const staticDir = path.join(__dirname, '../../src/public');
      const app = await createServer({ staticDir });
      expect(app).toBeDefined();
    });

    it('should mount provided API routes', async () => {
      const router = express.Router();
      router.get('/test', (_req, res) => {
        res.json({ ok: true });
      });

      const app = await createServer({
        staticDir: path.join(__dirname, '../../src/public'),
        routes: [{ path: '/api', router }],
      });

      server = await startServer(app, 0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const response = await fetch(`http://localhost:${port}/api/test`);
      const data = await response.json();
      expect(data).toEqual({ ok: true });
    });

    it('should serve index.html for GET /', async () => {
      const app = await createServer({
        staticDir: path.join(__dirname, '../../src/public'),
      });

      server = await startServer(app, 0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('<!DOCTYPE html>');
    });

    it('should serve static files from the configured directory', async () => {
      const app = await createServer({
        staticDir: path.join(__dirname, '../../src/public'),
      });

      server = await startServer(app, 0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const response = await fetch(`http://localhost:${port}/index.html`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('<!DOCTYPE html>');
    });

    it('ICE_TUNNEL_DEV 时本机 HTML 跳到 Vite，避免 API 口黑屏', async () => {
      const prevTunnel = process.env.ICE_TUNNEL_DEV;
      const prevVite = process.env.VITE_PORT;
      process.env.ICE_TUNNEL_DEV = '1';
      delete process.env.VITE_PORT;
      try {
        const app = await createServer({
          staticDir: path.join(__dirname, '../../src/public'),
        });
        server = await startServer(app, 0);
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        const response = await fetch(`http://127.0.0.1:${port}/`, {
          redirect: 'manual',
          headers: { Accept: 'text/html' },
        });
        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toBe('http://localhost:1025/');
        const probe = await fetch(`http://127.0.0.1:${port}/`);
        expect(probe.status).toBe(200);
        expect(await probe.text()).toContain('id="page-container"');
      } finally {
        if (prevTunnel === undefined) delete process.env.ICE_TUNNEL_DEV;
        else process.env.ICE_TUNNEL_DEV = prevTunnel;
        if (prevVite === undefined) delete process.env.VITE_PORT;
        else process.env.VITE_PORT = prevVite;
      }
    });

    it('should return index.html for unmatched client-side routes (SPA fallback)', async () => {
      const app = await createServer({
        staticDir: path.join(__dirname, '../../src/public'),
      });

      server = await startServer(app, 0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const response = await fetch(`http://localhost:${port}/some/client/route`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('<!DOCTYPE html>');
      expect(text).toContain('iceCoder');
    });
  });

  describe('startServer', () => {
    it('should start the server and log the address', async () => {
      const app = await createServer({
        staticDir: path.join(__dirname, '../../src/public'),
      });

      server = await startServer(app, 0);
      expect(server).toBeDefined();
      expect(server.listening).toBe(true);
    });

    it('should reject with error when port is already in use', async () => {
      const app1 = await createServer({
        staticDir: path.join(__dirname, '../../src/public'),
      });

      // Occupy a port using a raw net server with exclusive flag
      const net = await import('net');
      const blocker = net.createServer();
      const blockerPort = await new Promise<number>((resolve) => {
        blocker.listen({ port: 0, exclusive: true }, () => {
          const addr = blocker.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });

      // Mock process.exit to prevent test from exiting
      const originalExit = process.exit;
      let exitCalled = false;
      process.exit = (() => { exitCalled = true; }) as any;

      try {
        // Try to start Express server on the occupied port
        await expect(startServer(app1, blockerPort)).rejects.toThrow(`Port ${blockerPort} is already in use`);
        expect(exitCalled).toBe(true);
      } finally {
        process.exit = originalExit;
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });

  describe('resolveViteDevRedirectOrigin', () => {
    it('仅开发隧道或显式 VITE_PORT 时返回 Vite 源', () => {
      expect(resolveViteDevRedirectOrigin({ NODE_ENV: 'production', ICE_TUNNEL_DEV: '1' })).toBeNull();
      expect(resolveViteDevRedirectOrigin({})).toBeNull();
      expect(resolveViteDevRedirectOrigin({ ICE_TUNNEL_DEV: '1' })).toBe('http://localhost:1025');
      expect(resolveViteDevRedirectOrigin({ VITE_PORT: '5173' })).toBe('http://localhost:5173');
    });
  });

  describe('resolveDefaultStaticDir', () => {
    it('tsx 源码入口使用 src/public 且不做生产缓存', () => {
      const resolved = resolveDefaultStaticDir({
        moduleDir: path.join('/repo', 'src', 'web'),
        nodeEnv: undefined,
        existsSync: () => false,
      });
      expect(path.normalize(resolved.dir)).toBe(path.normalize('/repo/src/public'));
      expect(resolved.prodCaching).toBe(false);
    });

    it('dist/web 且存在 dist/public/index.html 时用打包前端（不依赖 NODE_ENV）', () => {
      const moduleDir = path.join('/app', 'node_modules', 'ice-coder', 'dist', 'web');
      const distIndex = path.join('/app', 'node_modules', 'ice-coder', 'dist', 'public', 'index.html');
      const resolved = resolveDefaultStaticDir({
        moduleDir,
        nodeEnv: undefined,
        existsSync: (p) => path.normalize(p) === path.normalize(distIndex),
      });
      expect(path.normalize(resolved.dir)).toBe(
        path.normalize('/app/node_modules/ice-coder/dist/public'),
      );
      expect(resolved.prodCaching).toBe(true);
    });

    it('NODE_ENV=production 时优先 dist/public', () => {
      const moduleDir = path.join('/app', 'dist', 'web');
      const distPublic = path.join('/app', 'dist', 'public');
      const resolved = resolveDefaultStaticDir({
        moduleDir,
        nodeEnv: 'production',
        existsSync: (p) => path.normalize(p) === path.normalize(distPublic),
      });
      expect(path.normalize(resolved.dir)).toBe(path.normalize(distPublic));
      expect(resolved.prodCaching).toBe(true);
    });
  });
});
