/**
 * 应用引导模块。
 * 抽取初始化逻辑为可复用函数，供 CLI 和 Web 入口共享。
 *
 * 路径解析优先级：
 * 1. 环境变量（ICE_DATA_DIR / ICE_CONFIG_PATH 等）
 * 2. 开发环境（NODE_ENV !== 'production'）：项目 `data/`
 * 3. 生产环境（NODE_ENV === 'production'）：`~/.iceCoder/`
 */

import fs from 'fs/promises';
import path from 'path';

import { LLMAdapter } from '../llm/llm-adapter.js';
import { OpenAIAdapter } from '../llm/openai-adapter.js';
import { FileParser } from '../parser/file-parser.js';
import { HtmlParserStrategy } from '../parser/html-strategy.js';
import { OfficeParserStrategy } from '../parser/office-strategy.js';
import { XMindParserStrategy } from '../parser/xmind-strategy.js';
import { getModelMaxOutputTokens, resolveOpenAiRequestTimeoutMs } from '../web/routes/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { initializeToolSystem } from '../tools/index.js';
import { MCPManager, startMcpBackgroundInit } from '../mcp/index.js';
import { broadcastMcpReady } from '../web/chat-ws.js';
import { resolveDataPaths, ensureDataDir, resolveMcpConfigPath, type DataPaths } from './paths.js';
import { isAppConfigReady } from '../config/config-readiness.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ProviderConfig, IceCoderConfigFile } from '../web/types.js';

/**
 * 引导结果，包含所有初始化好的核心组件。
 */
export interface BootstrapResult {
  llmAdapter: LLMAdapter;
  fileParser: FileParser;
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  mcpManager: MCPManager;
  /** 解析后的数据路径（供其他模块使用） */
  paths: DataPaths;
  /** 主配置未完成（缺 API Key 等），Web 应仅开放配置页 */
  needsSetup: boolean;
}

/**
 * 加载 LLM 提供者配置。
 */
export async function loadConfig(configPath: string): Promise<ProviderConfig[]> {
  const data = await fs.readFile(configPath, 'utf-8');
  const config = JSON.parse(data) as IceCoderConfigFile;
  return config.providers;
}

/**
 * 初始化 LLM 适配器。
 */
export function initializeLLMAdapter(providers: ProviderConfig[]): LLMAdapter {
  const llmAdapter = new LLMAdapter();

  for (const provider of providers) {
    const maxTokens = provider.parameters.maxTokens ?? getModelMaxOutputTokens(provider.modelName);
    const rt = resolveOpenAiRequestTimeoutMs(provider);
    llmAdapter.registerProvider(new OpenAIAdapter({
      name: provider.id,
      apiKey: provider.apiKey,
      baseURL: provider.apiUrl,
      model: provider.modelName,
      temperature: provider.parameters.temperature,
      maxTokens,
      topP: provider.parameters.topP,
      ...(rt !== undefined ? { timeout: rt } : {}),
    }));
  }

  const defaultProvider = providers.find((p) => p.isDefault);
  if (defaultProvider) {
    llmAdapter.setDefaultProvider(defaultProvider.id);
  } else if (providers.length > 0) {
    llmAdapter.setDefaultProvider(providers[0].id);
  }

  return llmAdapter;
}

/**
 * 热重载 LLM 适配器配置。
 * 重新读取配置文件，注册所有 providers 并切换默认提供者。
 */
export async function reloadLLMAdapter(llmAdapter: LLMAdapter, configPath: string): Promise<void> {
  const providers = await loadConfig(configPath);

  for (const provider of providers) {
    const maxTokens = provider.parameters.maxTokens ?? getModelMaxOutputTokens(provider.modelName);
    const rt = resolveOpenAiRequestTimeoutMs(provider);
    llmAdapter.registerProvider(new OpenAIAdapter({
      name: provider.id,
      apiKey: provider.apiKey,
      baseURL: provider.apiUrl,
      model: provider.modelName,
      temperature: provider.parameters.temperature,
      maxTokens,
      topP: provider.parameters.topP,
      ...(rt !== undefined ? { timeout: rt } : {}),
    }));
  }

  const defaultProvider = providers.find((p) => p.isDefault);
  if (defaultProvider) {
    llmAdapter.setDefaultProvider(defaultProvider.id);
  } else if (providers.length > 0) {
    llmAdapter.setDefaultProvider(providers[0].id);
  }

  console.log('LLM adapter configuration reloaded');
}

/**
 * 初始化文件解析器。
 */
export function initializeFileParser(): FileParser {
  const fileParser = new FileParser();
  fileParser.registerStrategy(new HtmlParserStrategy());
  fileParser.registerStrategy(new OfficeParserStrategy());
  fileParser.registerStrategy(new XMindParserStrategy());
  return fileParser;
}

/**
 * 完整引导：解析路径 → 自动初始化 → 加载配置 → 初始化所有组件。
 * 返回 needsSetup 表示主配置未完成（需在 Web 配置页填写 API Key 等）。
 */
export async function bootstrap(): Promise<BootstrapResult> {
  // 解析数据路径
  const paths = await resolveDataPaths();

  // 确保数据目录和默认配置存在
  await ensureDataDir(paths);

  // 加载配置
  const providers = await loadConfig(paths.configPath);
  const needsSetup = !isAppConfigReady({ providers });

  // 初始化 LLM
  const llmAdapter = initializeLLMAdapter(providers);

  // 初始化文件解析器
  const fileParser = initializeFileParser();

  // 初始化工具系统
  const { registry, executor } = initializeToolSystem({
    workDir: path.resolve('.'),
    fileParser,
  });

  const mcpManager = new MCPManager({ mcpConfigPath: resolveMcpConfigPath() });
  startMcpBackgroundInit(mcpManager, registry, (r) => {
    broadcastMcpReady({
      ok: r.ok,
      toolCount: r.toolCount,
      readyServers: r.readyServers,
      ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
    });
  });

  const orchestrator = new Orchestrator(fileParser, llmAdapter, {
    outputDir: paths.outputDir,
    sessionDir: paths.sessionsDir,
  });


  return {
    llmAdapter, fileParser, orchestrator,
    toolRegistry: registry, toolExecutor: executor,
    mcpManager, paths, needsSetup,
  };
}
