/**
 * iceCoder - 应用入口点
 *
 * 加载提供者配置，初始化 LLM 适配器、文件解析器、工具系统、编排器，
 * 并启动 Express Web 服务器与 WebSocket 聊天。
 */

import fs from 'fs/promises';
import path from 'path';

// LLM 层
import { LLMAdapter } from './llm/llm-adapter.js';
import { OpenAIAdapter } from './llm/openai-adapter.js';
import { AnthropicAdapter } from './llm/anthropic-adapter.js';

// 解析器层
import { FileParser } from './parser/file-parser.js';
import { HtmlParserStrategy } from './parser/html-strategy.js';
import { OfficeParserStrategy } from './parser/office-strategy.js';
import { XMindParserStrategy } from './parser/xmind-strategy.js';

// 核心
import { Orchestrator } from './core/orchestrator.js';

// 工具
import { initializeToolSystem } from './tools/index.js';

// MCP
import { MCPManager, startMcpBackgroundInit } from './mcp/index.js';

// Web 层
import { createServer, startServer } from './web/server.js';
import { createConfigRouter, getModelMaxOutputTokens, resolveOpenAiRequestTimeoutMs } from './web/routes/config.js';
import { createToolsRouter } from './web/routes/tools.js';
import { createRemoteRouter } from './web/routes/remote.js';
import {
  attachChatWebSocket,
  broadcastMcpReady,
  broadcastTunnelReady,
  cleanupChatResources,
} from './web/chat-ws.js';
import { startTunnelReadyWatcher } from './web/tunnel-ready-watcher.js';
import { createSessionsRouter } from './web/routes/sessions.js';
import { createUploadRouter } from './web/routes/upload.js';
import { createMemoryTelemetryRouter } from './web/routes/memory-telemetry.js';
import { createSupervisorEventsRouter } from './web/routes/supervisor-events.js';
import { createMemoryExportRouter } from './web/routes/memory-export.js';
import { createMemoryFilesRouter } from './web/routes/memory-files.js';

// 类型
import type { ProviderConfig, IceCoderConfigFile } from './web/types.js';
import { ensureMcpConfigFile, resolveMcpConfigPath } from './cli/paths.js';

const CONFIG_PATH = path.resolve(process.env.ICE_CONFIG_PATH ?? 'data/config.json');
const OUTPUT_DIR = path.resolve(process.env.ICE_OUTPUT_DIR ?? 'output');
const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR ?? 'data/sessions');

/**
 * 从 data/config.json 读取提供者配置。
 */
async function loadConfig(): Promise<ProviderConfig[]> {
  const data = await fs.readFile(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(data) as IceCoderConfigFile;
  return config.providers;
}

/**
 * 根据加载的配置注册 LLM 提供者适配器。
 * 将默认提供者设置为标记 isDefault: true 的提供者。
 */
function initializeLLMAdapter(providers: ProviderConfig[]): LLMAdapter {
  const llmAdapter = new LLMAdapter();

  for (const provider of providers) {
    const maxTokens = provider.parameters.maxTokens ?? getModelMaxOutputTokens(provider.modelName);
    if (provider.providerName === 'openai') {
      const rt = resolveOpenAiRequestTimeoutMs(provider);
      const openaiAdapter = new OpenAIAdapter({
        name: provider.id,
        apiKey: provider.apiKey,
        baseURL: provider.apiUrl,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens,
        topP: provider.parameters.topP,
        ...(rt !== undefined ? { timeout: rt } : {}),
      });
      llmAdapter.registerProvider(openaiAdapter);
    } else if (provider.providerName === 'anthropic') {
      const anthropicAdapter = new AnthropicAdapter({
        apiKey: provider.apiKey,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens,
        topP: provider.parameters.topP,
      });
      llmAdapter.registerProvider(anthropicAdapter);
    }
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
 * 创建并配置带有所有支持策略的 FileParser。
 */
function initializeFileParser(): FileParser {
  const fileParser = new FileParser();
  fileParser.registerStrategy(new HtmlParserStrategy());
  fileParser.registerStrategy(new OfficeParserStrategy());
  fileParser.registerStrategy(new XMindParserStrategy());
  return fileParser;
}

/**
 * 初始化工具系统与 MCPManager（MCP 进程在 HTTP 就绪后后台拉起，见 main）。
 */
async function initializeOrchestrator(
  fileParser: FileParser,
  llmAdapter: LLMAdapter,
): Promise<{ orchestrator: Orchestrator; toolRegistry: import('./tools/tool-registry.js').ToolRegistry; toolExecutor: import('./tools/tool-executor.js').ToolExecutor; mcpManager: MCPManager }> {
  const { registry, executor } = initializeToolSystem({
    workDir: path.resolve('.'),
    fileParser,
    llmAdapter,
  });

  const mcpManager = new MCPManager({ mcpConfigPath: resolveMcpConfigPath() });

  const orchestrator = new Orchestrator(fileParser, llmAdapter, {
    outputDir: OUTPUT_DIR,
    sessionDir: SESSIONS_DIR,
  });

  return { orchestrator, toolRegistry: registry, toolExecutor: executor, mcpManager };
}

/**
 * 重新加载提供者配置并重新初始化 LLM 适配器。
 * 委托给 bootstrap 中的共享实现。
 */
async function reloadLLMAdapterFromConfig(llmAdapter: LLMAdapter): Promise<void> {
  const providers = await loadConfig();

  for (const provider of providers) {
    const maxTokens = provider.parameters.maxTokens ?? getModelMaxOutputTokens(provider.modelName);
    if (provider.providerName === 'openai') {
      const rt = resolveOpenAiRequestTimeoutMs(provider);
      const openaiAdapter = new OpenAIAdapter({
        name: provider.id,
        apiKey: provider.apiKey,
        baseURL: provider.apiUrl,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens,
        topP: provider.parameters.topP,
        ...(rt !== undefined ? { timeout: rt } : {}),
      });
      llmAdapter.registerProvider(openaiAdapter);
    } else if (provider.providerName === 'anthropic') {
      const anthropicAdapter = new AnthropicAdapter({
        apiKey: provider.apiKey,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens,
        topP: provider.parameters.topP,
      });
      llmAdapter.registerProvider(anthropicAdapter);
    }
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
 * 监视 data/config.json 的变化并热重载 LLM 适配器。
 * 使用 node:fs watchFile 以获得广泛兼容性。
 */
function watchConfigChanges(llmAdapter: LLMAdapter): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  import('node:fs').then((nodeFs) => {
    nodeFs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        reloadLLMAdapterFromConfig(llmAdapter).catch((err) => {
          console.error('Failed to reload LLM adapter config:', err);
        });
      }, 500);
    });
  });
}

/**
 * 主应用引导程序。
 */
async function main(): Promise<void> {
  console.log('iceCoder starting...');

  await ensureMcpConfigFile(CONFIG_PATH);

  // 1. 加载提供者配置
  const providers = await loadConfig();
  console.log(`Loaded ${providers.length} provider configuration(s)`);

  // 2. 使用注册的提供者初始化 LLM 适配器
  const llmAdapter = initializeLLMAdapter(providers);

  // 3. 使用所有策略初始化 FileParser（HTML、Office、XMind）
  const fileParser = initializeFileParser();

  // 4. 使用 FileParser、LLMAdapter、工具系统和输出配置初始化编排器
  const { orchestrator, toolRegistry, toolExecutor, mcpManager } = await initializeOrchestrator(fileParser, llmAdapter);

  // 5. 创建带所有 API 路由的 Express 服务器
  const port = parseInt(process.env.PORT ?? '1024', 10);

  const app = await createServer({
    routes: [
      { path: '/api/config', router: createConfigRouter({
        configPath: CONFIG_PATH,
        onConfigSaved: () => {
          reloadLLMAdapterFromConfig(llmAdapter).catch(err => console.error('Failed to reload LLM adapter:', err));
        },
      }) },
      { path: '/api/tools', router: createToolsRouter({ registry: toolRegistry, executor: toolExecutor }) },
      { path: '/api/remote', router: createRemoteRouter({ orchestrator, toolRegistry, toolExecutor }) },
      { path: '/api/sessions', router: createSessionsRouter() },
      { path: '/api/chat', router: createUploadRouter() },
      { path: '/api/memory/telemetry', router: createMemoryTelemetryRouter() },
      { path: '/api/supervisor/events', router: createSupervisorEventsRouter() },
      { path: '/api/memory/files', router: createMemoryFilesRouter() },
      { path: '/api/memory', router: createMemoryExportRouter() },
    ],
  });

  // 6. 启动服务器
  const server = await startServer(app, port);

  // 7. 附加统一聊天 WebSocket（PC 和移动端共用，兼容 /api/remote/ws 旧路径）
  attachChatWebSocket(server, { orchestrator, toolRegistry, toolExecutor });

  // 7b. MCP 后台初始化（不阻塞监听）；完成后广播 mcp_ready，并由宠物提示
  startMcpBackgroundInit(mcpManager, toolRegistry, (r) => {
    broadcastMcpReady({
      ok: r.ok,
      toolCount: r.toolCount,
      readyServers: r.readyServers,
      ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
    });
  });

  // 7c. Cloudflare Quick Tunnel 后台探测（与 concurrently 启动的 cloudflared 对齐）；就绪后 WS 推送 + 宠物提示
  const stopTunnelReadyWatcher = startTunnelReadyWatcher({
    onReady: (url) => broadcastTunnelReady({ url }),
  });

  // 8. 监视配置变化以支持 LLM 提供者热切换
  watchConfigChanges(llmAdapter);

  // 9. 优雅关闭处理
  const shutdown = () => {
    console.log('Shutting down...');
    stopTunnelReadyWatcher();
    cleanupChatResources();
    mcpManager.shutdown().catch((err) => console.error('MCP shutdown error:', err));
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('iceCoder is ready');
}

main().catch((err) => {
  console.error('Failed to start iceCoder:', err);
  process.exit(1);
});
