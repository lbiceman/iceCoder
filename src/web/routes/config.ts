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
import {
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  getModelMaxContext,
  getModelMaxOutputTokens,
  resolveOpenAiRequestTimeoutMs,
} from '../../config/model-capabilities.js';
import type { IceCoderConfigFile, ProviderConfig } from '../types.js';

// 向后兼容：历史上这些助手从本文件导出，保留 re-export 以免破坏既有引用与测试。
export {
  DEFAULT_AGENT_MAX_OUTPUT_TOKENS,
  getModelMaxOutputTokens,
  resolveOpenAiRequestTimeoutMs,
};

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
      let existingShellBlacklist: IceCoderConfigFile['shellBlacklist'];
      try {
        const data = await fs.readFile(configFile, 'utf-8');
        const existing = JSON.parse(data) as IceCoderConfigFile;
        existingProviders = existing.providers || [];
        existingSupervisorMode = existing.supervisorMode;
        existingSkipPermissionChecks = existing.skipPermissionChecks;
        existingShellBlacklist = existing.shellBlacklist;
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
          ...(existingShellBlacklist !== undefined ? { shellBlacklist: existingShellBlacklist } : {}),
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
        ...(config.shellBlacklist !== undefined ? { shellBlacklist: config.shellBlacklist } : {}),
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
