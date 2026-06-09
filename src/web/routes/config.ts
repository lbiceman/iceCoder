/**
 * 配置 API 路由。
 * 处理提供者配置的保存和加载（data/config.json）。
 */

import { Router, type Request, type Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  DEFAULT_MAIN_CONFIG_SUPERVISOR_MODE,
  normalizeSupervisorMode,
  readMainConfigFile,
  resolveSkipPermissionChecks,
  writeSupervisorModeToMainConfig,
} from '../../config/main-config-supervisor-mode.js';
import { resetSupervisorRuntimeCache } from '../../harness/supervisor/supervisor-runtime-cache.js';
import { isAppConfigReady, isPlaceholderApiKey } from '../../config/config-readiness.js';
import { normalizeProvider } from '../../config/normalize-provider.js';
import { applyRuntimeDataEnvDefaults } from '../../cli/paths.js';
import type { IceCoderConfigFile, ProviderConfig } from '../types.js';

/** 与 bootstrap / index 使用同一规则，避免 Web API 读写错误的 config.json */
function resolveConfigPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  applyRuntimeDataEnvDefaults();
  return path.resolve(process.env.ICE_CONFIG_PATH!);
}

/** 恰好一个 isDefault: true，避免前端或旧配置出现全 false 时默默地用「第一条」当默认 */
function normalizeDefaultFlags(providers: ProviderConfig[]): ProviderConfig[] {
  const idx = providers.findIndex(p => p.isDefault === true);
  const keep = idx >= 0 ? idx : 0;
  return providers.map((p, i) => ({ ...p, isDefault: i === keep }));
}

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
 * 解析 OpenAI 兼容提供者的单次请求超时（毫秒）。
 * 优先级：provider.requestTimeoutMs → ICE_OPENAI_REQUEST_TIMEOUT_MS → undefined（由适配器默认 120s 处理）。
 */
export function resolveOpenAiRequestTimeoutMs(provider: ProviderConfig): number | undefined {
  if (
    typeof provider.requestTimeoutMs === 'number' &&
    Number.isFinite(provider.requestTimeoutMs) &&
    provider.requestTimeoutMs > 0
  ) {
    return Math.floor(provider.requestTimeoutMs);
  }
  const raw = process.env.ICE_OPENAI_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 读取当前默认提供者下冰豆与压缩器共用上下文上限（不向客户端暴露密钥）。
 * 供 WebSocket `connected` 包携带，替代聊天页周期性 GET /api/config。
 */
export async function resolveDefaultChatModelMeta(
  explicitConfigPath?: string,
): Promise<{ modelName: string; maxContextTokens: number; maxOutputTokens: number } | null> {
  const configFile = resolveConfigPath(explicitConfigPath);
  try {
    const raw = await fs.readFile(configFile, 'utf-8');
    const parsed = JSON.parse(raw) as IceCoderConfigFile;
    const providers = normalizeDefaultFlags(parsed.providers ?? []);
    const p = providers.find(pp => pp.isDefault) ?? providers[0];
    if (!p) return null;
    return {
      modelName: p.modelName || '',
      maxContextTokens: p.maxContextTokens ?? getModelMaxContext(p.modelName),
      maxOutputTokens: p.parameters?.maxTokens ?? getModelMaxOutputTokens(p.modelName),
    };
  } catch {
    return null;
  }
}

/** 默认聊天 provider 是否支持 vision；未显式配置时默认为 `true`。 */
export async function resolveDefaultSupportsVision(
  explicitConfigPath?: string,
): Promise<boolean> {
  const configFile = resolveConfigPath(explicitConfigPath);
  try {
    const raw = await fs.readFile(configFile, 'utf-8');
    const parsed = JSON.parse(raw) as IceCoderConfigFile;
    const providers = normalizeDefaultFlags(parsed.providers ?? []);
    const p = providers.find(pp => pp.isDefault) ?? providers[0];
    if (!p) return false;
    if (p.supportsVision !== undefined) return p.supportsVision;
    return true;
  } catch {
    return false;
  }
}

/** 去掉旧版 providerName 并保证 id 存在 */
function sanitizeProvider(provider: ProviderConfig & { providerName?: unknown }, index: number): ProviderConfig {
  const normalized = normalizeProvider(provider, index);
  return {
    ...normalized,
    supportsVision: normalized.supportsVision ?? true,
  };
}

/** 验证单个提供者配置：无效返回错误文案，合法返回 null */
function validateProvider(provider: ProviderConfig): string | null {
  if (!provider.apiUrl || provider.apiUrl.trim() === '') {
    return 'API 地址不能为空';
  }
  if (!provider.apiKey || provider.apiKey.trim() === '') {
    return 'API 密钥不能为空';
  }
  if (isPlaceholderApiKey(provider.apiKey)) {
    return '请填写有效的 API 密钥，不能使用占位符';
  }
  if (!provider.modelName || provider.modelName.trim() === '') {
    return '模型名称不能为空';
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

/** Agent 运行时未配置 maxTokens 时的单次输出上限（未知/新模型兜底） */
export const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 16384;

/**
 * 根据模型名称返回单次最大输出 token 数。
 * 用户不填 maxTokens 时，系统自动推算。
 */
export function getModelMaxOutputTokens(modelName: string): number {
  const name = modelName.toLowerCase();

  // DeepSeek 系列
  if (name.includes('deepseek-v4')) return 16384;
  if (name.includes('deepseek')) return 16384;

  // OpenAI 系列
  if (name.includes('o1') || name.includes('o3') || name.includes('o4')) return 100000;
  if (name.includes('gpt-4o')) return 16384;
  if (name.includes('gpt-4-turbo')) return 4096;
  if (name.includes('gpt-4')) return 16384;
  if (name.includes('gpt-3.5')) return 4096;

  // GLM 系列
  if (name.includes('glm')) return 16384;

  // Qwen 系列
  if (name.includes('qwen')) return 16384;

  // MiniMax / MiMo 系列
  if (name.includes('minimax') || name.includes('mimo')) return 16384;

  // Llama 系列
  if (name.includes('llama')) return 4096;

  // Mistral 系列
  if (name.includes('mistral') || name.includes('mixtral')) return 4096;

  // 未知模型：Agent 场景需容纳整文件 write_file 等长 tool 参数
  return DEFAULT_AGENT_MAX_OUTPUT_TOKENS;
}

/**
 * 创建配置 API 路由。
 */
export interface ConfigRouterOptions {
  /** 配置保存成功后的回调（用于触发 LLM adapter 热重载） */
  onConfigSaved?: (ready: boolean) => void;
  /** 配置文件路径（须与 LLM bootstrap 的 configPath 一致，例如 CLI 下的 ~/.iceCoder/config.json） */
  configPath?: string;
  /** 配置保存后更新「待配置」状态 */
  setSetupRequired?: (required: boolean) => void;
}

export function createConfigRouter(options?: ConfigRouterOptions): Router {
  const configFile = resolveConfigPath(options?.configPath);
  const router = Router();

  /**
   * POST /api/config - 保存提供者配置。
   * 如果前端发来的 apiKey 是脱敏值（包含 *），保留原文件中的真实 key。
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { providers } = req.body as { providers: ProviderConfig[] };

      if (!providers || !Array.isArray(providers)) {
        res.status(400).json({ error: '请求体须包含 providers 数组' });
        return;
      }

      // 读取现有配置，用于恢复被脱敏的 apiKey
      let existingProviders: ProviderConfig[] = [];
      let existingSupervisorMode: IceCoderConfigFile['supervisorMode'];
      let existingSkipPermissionChecks: IceCoderConfigFile['skipPermissionChecks'];
      try {
        const data = await fs.readFile(configFile, 'utf-8');
        const existing = JSON.parse(data) as IceCoderConfigFile;
        existingProviders = existing.providers || [];
        existingSupervisorMode = existing.supervisorMode;
        existingSkipPermissionChecks = existing.skipPermissionChecks;
      } catch { /* 文件不存在，首次保存 */ }

      // 构建 id → 原始 apiKey 的映射
      const originalKeys = new Map<string, string>();
      for (const p of existingProviders) {
        if (p.id && p.apiKey) {
          originalKeys.set(p.id, p.apiKey);
        }
      }

      // 处理每个 provider：如果 apiKey 是脱敏值，恢复原始 key
      const resolvedProviders = providers.map((provider, index) => {
        let apiKey = provider.apiKey;
        if (apiKey && apiKey.includes('*') && provider.id && originalKeys.has(provider.id)) {
          // 脱敏值，恢复原始 key
          apiKey = originalKeys.get(provider.id)!;
        }
        return sanitizeProvider({ ...provider, apiKey }, index);
      });

      const normalizedProviders = normalizeDefaultFlags(resolvedProviders);

      // 验证每个提供者
      for (let i = 0; i < normalizedProviders.length; i++) {
        const error = validateProvider(normalizedProviders[i]);
        if (error) {
          res.status(400).json({ error: `提供者 ${i + 1}：${error}` });
          return;
        }
      }

      const configData = JSON.stringify(
        {
          providers: normalizedProviders,
          supervisorMode: normalizeSupervisorMode(existingSupervisorMode),
          skipPermissionChecks: resolveSkipPermissionChecks(existingSkipPermissionChecks),
        },
        null,
        2,
      );
      await fs.writeFile(configFile, configData, 'utf-8');

      resetSupervisorRuntimeCache();
      const setupComplete = isAppConfigReady({ providers: normalizedProviders });
      options?.setSetupRequired?.(!setupComplete);

      // 触发热重载回调
      if (options?.onConfigSaved) {
        try { options.onConfigSaved(setupComplete); } catch { /* 不阻塞响应 */ }
      }

      res.json({ success: true, message: '配置已保存', setupComplete, setupRequired: !setupComplete });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: `保存配置失败：${message}` });
    }
  });

  /**
   * GET /api/config - 加载已保存的配置（API 密钥已遮蔽）。
   */
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const data = await fs.readFile(configFile, 'utf-8');
      const config = JSON.parse(data) as IceCoderConfigFile;

      // 返回前遮蔽 API 密钥
      const maskedProviders = config.providers.map((provider: ProviderConfig, index: number) => ({
        ...sanitizeProvider(provider, index),
        apiKey: maskApiKey(provider.apiKey),
        // 优先用配置文件中的 maxContextTokens，没有才根据模型名推断
        maxContextTokens: provider.maxContextTokens || getModelMaxContext(provider.modelName),
      }));

      res.json({
        providers: maskedProviders,
        supervisorMode: normalizeSupervisorMode(config.supervisorMode),
        skipPermissionChecks: resolveSkipPermissionChecks(config.skipPermissionChecks),
        setupRequired: !isAppConfigReady(config),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.json({
          providers: [],
          supervisorMode: DEFAULT_MAIN_CONFIG_SUPERVISOR_MODE,
          skipPermissionChecks: false,
          setupRequired: true,
        });
        return;
      }
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: `加载配置失败：${message}` });
    }
  });

  /**
   * PATCH /api/config/supervisor-mode — 切换双模监管档位（写入 config.json）。
   */
  router.patch('/supervisor-mode', async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = (req.body as { supervisorMode?: string })?.supervisorMode;
      if (raw !== 'off' && raw !== 'adaptive' && raw !== 'strict') {
        res.status(400).json({
          error: 'supervisorMode 须为 off、adaptive 或 strict 之一',
        });
        return;
      }
      const saved = await writeSupervisorModeToMainConfig(configFile, raw);
      resetSupervisorRuntimeCache();
      if (options?.onConfigSaved) {
        try { options.onConfigSaved(true); } catch { /* 不阻塞响应 */ }
      }
      res.json({ success: true, supervisorMode: saved });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: `更新监管模式失败：${message}` });
    }
  });

  return router;
}
