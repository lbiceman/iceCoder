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
import { openAiAdapterConfigFromProvider } from '../llm/provider-adapter-config.js';
import { FileParser } from '../parser/file-parser.js';
import { HtmlParserStrategy } from '../parser/html-strategy.js';
import { OfficeParserStrategy } from '../parser/office-strategy.js';
import { XMindParserStrategy } from '../parser/xmind-strategy.js';
import { Orchestrator } from '../core/orchestrator.js';
import { initializeToolSystem } from '../tools/index.js';
import { MCPManager, startMcpBackgroundInit, watchMcpConfigChanges } from '../mcp/index.js';
import { broadcastMcpReady } from '../web/chat-ws.js';
import { resolveDataPaths, ensureDataDir, resolveMcpConfigPath, type DataPaths } from './paths.js';
import { isAppConfigReady } from '../config/config-readiness.js';
import { normalizeProviders } from '../config/normalize-provider.js';
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
  return normalizeProviders(config.providers);
}

function resolveDefaultProviderId(providers: ProviderConfig[]): string {
  const pick = providers.find((p) => p.isDefault) ?? providers[0];
  const id = pick?.id?.trim();
  if (!id) {
    if (providers.length === 0) {
      throw new Error('config.json 中未配置任何 LLM provider');
    }
    throw new Error(
      '默认 LLM provider 缺少 id。请在 Web 配置页保存一次，或检查 data/config.json / ~/.iceCoder/config.json',
    );
  }
  return id;
}

/**
 * 初始化 LLM 适配器。
 */
export function initializeLLMAdapter(providers: ProviderConfig[]): LLMAdapter {
  const llmAdapter = new LLMAdapter();

  for (const provider of providers) {
    llmAdapter.registerProvider(new OpenAIAdapter(openAiAdapterConfigFromProvider(provider)));
  }

  if (providers.length > 0) {
    llmAdapter.setDefaultProvider(resolveDefaultProviderId(providers));
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
    llmAdapter.registerProvider(new OpenAIAdapter(openAiAdapterConfigFromProvider(provider)));
  }

  // 清理已从配置中删除/改名的陈旧 provider，避免它们继续残留可被选中
  llmAdapter.pruneProviders(providers.map((p) => p.id));

  if (providers.length > 0) {
    llmAdapter.setDefaultProvider(resolveDefaultProviderId(providers));
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
  const notifyMcpReady = (r: import('../mcp/start-mcp-background.js').McpBackgroundSettled) => {
    broadcastMcpReady({
      ok: r.ok,
      toolCount: r.toolCount,
      readyServers: r.readyServers,
      ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
    });
  };
  startMcpBackgroundInit(mcpManager, registry, notifyMcpReady);
  watchMcpConfigChanges({
    mcpConfigPath: resolveMcpConfigPath(),
    mcpManager,
    registry,
    onReloaded: notifyMcpReady,
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
