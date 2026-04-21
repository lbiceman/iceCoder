/**
 * Unit tests for the Express web server.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, startServer } from './server.js';
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
      const staticDir = path.join(__dirname, '../public');
      const app = await createServer({ staticDir });
      expect(app).toBeDefined();
    });

    it('should mount provided API routes', async () => {
      const router = express.Router();
      router.get('/test', (_req, res) => {
        res.json({ ok: true });
      });

      const app = await createServer({
        staticDir: path.join(__dirname, '../public'),
        routes: [{ path: '/api', router }],
      });

      server = await startServer(app, 0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const response = await fetch(`http://localhost:${port}/api/test`);
      const data = await response.json();
      expect(data).toEqual({ ok: true });
    });

    it('should serve static files from the configured directory', async () => {
      const app = await createServer({
        staticDir: path.join(__dirname, '../public'),
      });

      server = await startServer(app, 0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const response = await fetch(`http://localhost:${port}/index.html`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('<!DOCTYPE html>');
    });

    it('should return index.html for unmatched client-side routes (SPA fallback)', async () => {
      const app = await createServer({
        staticDir: path.join(__dirname, '../public'),
      });

      server = await startServer(app, 0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      const response = await fetch(`http://localhost:${port}/some/client/route`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('<!DOCTYPE html>');
      expect(text).toContain('ICE');
    });
  });

  describe('startServer', () => {
    it('should start the server and log the address', async () => {
      const app = await createServer({
        staticDir: path.join(__dirname, '../public'),
      });

      server = await startServer(app, 0);
      expect(server).toBeDefined();
      expect(server.listening).toBe(true);
    });

    it('should reject with error when port is already in use', async () => {
      const app1 = await createServer({
        staticDir: path.join(__dirname, '../public'),
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
});
