/**
 * Configuration API routes.
 * Handles saving and loading provider configurations to/from data/config.json.
 */

import { Router, type Request, type Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import type { ProviderConfig } from '../types.js';

const CONFIG_PATH = path.resolve('data/config.json');

/**
 * Masks an API key, showing only the first 4 and last 4 characters.
 */
function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return '****';
  }
  const first = apiKey.slice(0, 4);
  const last = apiKey.slice(-4);
  return `${first}${'*'.repeat(apiKey.length - 8)}${last}`;
}

/**
 * Validates a single provider configuration.
 * Returns an error message if invalid, or null if valid.
 */
function validateProvider(provider: ProviderConfig): string | null {
  if (!provider.apiUrl || provider.apiUrl.trim() === '') {
    return 'API URL is required and cannot be empty';
  }
  if (!provider.apiKey || provider.apiKey.trim() === '') {
    return 'API Key is required and cannot be empty';
  }
  return null;
}

/**
 * Creates the configuration API router.
 */
export function createConfigRouter(): Router {
  const router = Router();

  /**
   * POST /api/config - Save provider configurations.
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { providers } = req.body as { providers: ProviderConfig[] };

      if (!providers || !Array.isArray(providers)) {
        res.status(400).json({ error: 'Request body must contain a providers array' });
        return;
      }

      // Validate each provider
      for (let i = 0; i < providers.length; i++) {
        const error = validateProvider(providers[i]);
        if (error) {
          res.status(400).json({ error: `Provider ${i}: ${error}` });
          return;
        }
      }

      const configData = JSON.stringify({ providers }, null, 2);
      await fs.writeFile(CONFIG_PATH, configData, 'utf-8');

      res.json({ success: true, message: 'Configuration saved successfully' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: `Failed to save configuration: ${message}` });
    }
  });

  /**
   * GET /api/config - Load saved configurations with masked API keys.
   */
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const data = await fs.readFile(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(data) as { providers: ProviderConfig[] };

      // Mask API keys before returning
      const maskedProviders = config.providers.map((provider) => ({
        ...provider,
        apiKey: maskApiKey(provider.apiKey),
      }));

      res.json({ providers: maskedProviders });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({ providers: [] });
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: `Failed to load configuration: ${message}` });
    }
  });

  return router;
}
