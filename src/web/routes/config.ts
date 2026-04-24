/**
 * 配置 API 路由。
 * 处理提供者配置的保存和加载（data/config.json）。
 */

import { Router, type Request, type Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import type { ProviderConfig } from '../types.js';

const CONFIG_PATH = path.resolve('data/config.json');

/**
 * 遮蔽 API 密钥，仅显示前 4 位和后 4 位字符。
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
 * 验证单个提供者配置。
 * 如果无效返回错误消息，有效则返回 null。
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
 * 根据模型名称返回最大上下文长度（token 数）。
 * 已知模型返回精确值，未知模型根据名称模式推断。
 */
function getModelMaxContext(modelName: string): number {
  const name = modelName.toLowerCase();

  // DeepSeek 系列
  if (name.includes('deepseek-v4')) return 1000000;
  if (name.includes('deepseek')) return 131072;

  // OpenAI GPT-4o 系列
  if (name.includes('gpt-4o')) return 128000;
  if (name.includes('gpt-4-turbo')) return 128000;
  if (name.includes('gpt-4')) return 8192;
  if (name.includes('gpt-3.5-turbo-16k')) return 16384;
  if (name.includes('gpt-3.5')) return 4096;
  if (name.includes('o1') || name.includes('o3') || name.includes('o4')) return 200000;

  // Claude 系列
  if (name.includes('claude-3') || name.includes('claude-4')) return 200000;
  if (name.includes('claude-2')) return 100000;
  if (name.includes('claude')) return 200000;

  // GLM 系列
  if (name.includes('glm-4')) return 128000;
  if (name.includes('glm')) return 128000;

  // Qwen 系列
  if (name.includes('qwen')) return 131072;

  // Llama 系列
  if (name.includes('llama-3')) return 128000;
  if (name.includes('llama')) return 8192;

  // Mistral 系列
  if (name.includes('mistral')) return 32768;
  if (name.includes('mixtral')) return 32768;

  // 默认保守估计
  return 8192;
}

/**
 * 创建配置 API 路由。
 */
export interface ConfigRouterOptions {
  /** 配置保存成功后的回调（用于触发 LLM adapter 热重载） */
  onConfigSaved?: () => void;
}

export function createConfigRouter(options?: ConfigRouterOptions): Router {
  const router = Router();

  /**
   * POST /api/config - 保存提供者配置。
   * 如果前端发来的 apiKey 是脱敏值（包含 *），保留原文件中的真实 key。
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { providers } = req.body as { providers: ProviderConfig[] };

      if (!providers || !Array.isArray(providers)) {
        res.status(400).json({ error: 'Request body must contain a providers array' });
        return;
      }

      // 读取现有配置，用于恢复被脱敏的 apiKey
      let existingProviders: ProviderConfig[] = [];
      try {
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        const existing = JSON.parse(data) as { providers: ProviderConfig[] };
        existingProviders = existing.providers || [];
      } catch { /* 文件不存在，首次保存 */ }

      // 构建 id → 原始 apiKey 的映射
      const originalKeys = new Map<string, string>();
      for (const p of existingProviders) {
        if (p.id && p.apiKey) {
          originalKeys.set(p.id, p.apiKey);
        }
      }

      // 处理每个 provider：如果 apiKey 是脱敏值，恢复原始 key
      const resolvedProviders = providers.map(provider => {
        let apiKey = provider.apiKey;
        if (apiKey && apiKey.includes('*') && provider.id && originalKeys.has(provider.id)) {
          // 脱敏值，恢复原始 key
          apiKey = originalKeys.get(provider.id)!;
        }
        return { ...provider, apiKey };
      });

      // 验证每个提供者
      for (let i = 0; i < resolvedProviders.length; i++) {
        const error = validateProvider(resolvedProviders[i]);
        if (error) {
          res.status(400).json({ error: `Provider ${i}: ${error}` });
          return;
        }
      }

      const configData = JSON.stringify({ providers: resolvedProviders }, null, 2);
      await fs.writeFile(CONFIG_PATH, configData, 'utf-8');

      // 触发热重载回调
      if (options?.onConfigSaved) {
        try { options.onConfigSaved(); } catch { /* 不阻塞响应 */ }
      }

      res.json({ success: true, message: 'Configuration saved successfully' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: `Failed to save configuration: ${message}` });
    }
  });

  /**
   * GET /api/config - 加载已保存的配置（API 密钥已遮蔽）。
   */
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const data = await fs.readFile(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(data) as { providers: ProviderConfig[] };

      // 返回前遮蔽 API 密钥
      const maskedProviders = config.providers.map((provider: any) => ({
        ...provider,
        apiKey: maskApiKey(provider.apiKey),
        // 优先用配置文件中的 maxContextTokens，没有才根据模型名推断
        maxContextTokens: provider.maxContextTokens || getModelMaxContext(provider.modelName),
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
