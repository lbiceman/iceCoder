/**
 * Express web server with static file hosting and SPA fallback.
 * Serves the frontend application and provides API route mounting.
 */

import express, { type Express, type Router, type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Server } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Configuration for creating the Express server.
 */
export interface ServerConfig {
  /** Directory to serve static files from. Defaults to src/public. */
  staticDir?: string;
  /** API routes to mount on the app. */
  routes?: { path: string; router: Router }[];
}

/**
 * Creates and configures an Express application.
 *
 * @param config - Optional server configuration
 * @returns Configured Express application
 */
export function createServer(config?: ServerConfig): Express {
  const app = express();

  // Parse JSON and URL-encoded bodies
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Determine static files directory
  // Default to src/public relative to project root (not dist), since frontend files are plain HTML/CSS/JS
  const staticDir = config?.staticDir ?? path.join(__dirname, '../../src/public');

  // Serve static files
  app.use(express.static(staticDir));

  // Mount any provided API routes
  if (config?.routes) {
    for (const route of config.routes) {
      app.use(route.path, route.router);
    }
  }

  // SPA fallback: for GET requests that don't match API routes, send index.html
  app.get('/{*splat}', (req: Request, res: Response) => {
    const indexPath = path.join(staticDir, 'index.html');
    res.sendFile(indexPath);
  });

  return app;
}

/**
 * Starts the Express server on the specified port.
 *
 * @param app - Express application to start
 * @param port - Port number to listen on
 * @returns Promise that resolves with the HTTP server on success, or rejects on error
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
        console.log(`Server listening on http://localhost:${actualPort}`);
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
