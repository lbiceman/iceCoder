/**
 * 多智能体编排器 - 应用入口点
 *
 * 加载提供者配置，初始化 LLM 适配器、文件解析器、
 * 包含所有 6 个子智能体的编排器，并启动带 SSE 支持的 Express Web 服务器
 * 以实现前端实时更新。
 *
 * Requirements: 2.1, 10.4, 18.1, 18.6, 19.4, 19.5, 22.1, 22.6
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

// 智能体
import { RequirementAnalysisAgent } from './agents/requirement-analysis.js';
import { DesignAgent } from './agents/design.js';
import { TaskGenerationAgent } from './agents/task-generation.js';
import { CodeWritingAgent } from './agents/code-writing.js';
import { TestingAgent } from './agents/testing.js';
import { RequirementVerificationAgent } from './agents/requirement-verification.js';

// Web 层
import { SSEManager } from './web/sse.js';
import { createServer, startServer } from './web/server.js';
import { createConfigRouter } from './web/routes/config.js';
import { createChatRouter } from './web/routes/chat.js';
import { createPipelineRouter, wireOrchestratorToSSE } from './web/routes/pipeline.js';
import { createToolsRouter } from './web/routes/tools.js';
import { createRemoteRouter } from './web/routes/remote.js';
import { attachRemoteWebSocket } from './web/remote-ws.js';

// 类型
import type { ProviderConfig } from './web/types.js';

const CONFIG_PATH = path.resolve('data/config.json');
const OUTPUT_DIR = path.resolve('output');

/**
 * 从 data/config.json 读取提供者配置。
 */
async function loadConfig(): Promise<ProviderConfig[]> {
  const data = await fs.readFile(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(data) as { providers: ProviderConfig[] };
  return config.providers;
}

/**
 * 根据加载的配置注册 LLM 提供者适配器。
 * 将默认提供者设置为标记 isDefault: true 的提供者。
 */
function initializeLLMAdapter(providers: ProviderConfig[]): LLMAdapter {
  const llmAdapter = new LLMAdapter();

  for (const provider of providers) {
    if (provider.providerName === 'openai') {
      const openaiAdapter = new OpenAIAdapter({
        apiKey: provider.apiKey,
        baseURL: provider.apiUrl,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens: provider.parameters.maxTokens,
        topP: provider.parameters.topP,
      });
      llmAdapter.registerProvider(openaiAdapter);
    } else if (provider.providerName === 'anthropic') {
      const anthropicAdapter = new AnthropicAdapter({
        apiKey: provider.apiKey,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens: provider.parameters.maxTokens,
        topP: provider.parameters.topP,
      });
      llmAdapter.registerProvider(anthropicAdapter);
    }
  }

  // 将默认提供者设置为标记 isDefault: true 的提供者
  const defaultProvider = providers.find((p) => p.isDefault);
  if (defaultProvider) {
    llmAdapter.setDefaultProvider(defaultProvider.providerName);
  } else if (providers.length > 0) {
    // 如果没有标记为默认的，回退到第一个提供者
    llmAdapter.setDefaultProvider(providers[0].providerName);
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
 * 创建编排器并注册所有 6 个子智能体。
 * 返回编排器和工具系统用于路由连接。
 */
function initializeOrchestrator(
  fileParser: FileParser,
  llmAdapter: LLMAdapter,
): { orchestrator: Orchestrator; toolRegistry: import('./tools/tool-registry.js').ToolRegistry; toolExecutor: import('./tools/tool-executor.js').ToolExecutor } {
  const orchestrator = new Orchestrator(fileParser, llmAdapter, {
    outputDir: OUTPUT_DIR,
    stageMaxRetries: 2,
    stageRetryDelay: 3000,
  });

  // 初始化工具系统
  const { registry, executor } = initializeToolSystem({
    workDir: path.resolve('.'),
    fileParser,
  });

  // 注册所有 6 个流水线智能体
  orchestrator.registerAgent(new RequirementAnalysisAgent());
  orchestrator.registerAgent(new DesignAgent());
  orchestrator.registerAgent(new TaskGenerationAgent());
  orchestrator.registerAgent(new CodeWritingAgent());
  orchestrator.registerAgent(new TestingAgent());
  orchestrator.registerAgent(new RequirementVerificationAgent());

  return { orchestrator, toolRegistry: registry, toolExecutor: executor };
}

/**
 * 重新加载提供者配置并重新初始化 LLM 适配器。
 * 支持不重启智能体的情况下热切换提供者。
 */
async function reloadLLMAdapter(llmAdapter: LLMAdapter): Promise<void> {
  const providers = await loadConfig();

  // 从更新的配置重新注册所有提供者
  for (const provider of providers) {
    if (provider.providerName === 'openai') {
      const openaiAdapter = new OpenAIAdapter({
        apiKey: provider.apiKey,
        baseURL: provider.apiUrl,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens: provider.parameters.maxTokens,
        topP: provider.parameters.topP,
      });
      llmAdapter.registerProvider(openaiAdapter);
    } else if (provider.providerName === 'anthropic') {
      const anthropicAdapter = new AnthropicAdapter({
        apiKey: provider.apiKey,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens: provider.parameters.maxTokens,
        topP: provider.parameters.topP,
      });
      llmAdapter.registerProvider(anthropicAdapter);
    }
  }

  const defaultProvider = providers.find((p) => p.isDefault);
  if (defaultProvider) {
    llmAdapter.setDefaultProvider(defaultProvider.providerName);
  } else if (providers.length > 0) {
    llmAdapter.setDefaultProvider(providers[0].providerName);
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
        reloadLLMAdapter(llmAdapter).catch((err) => {
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
  console.log('Multi-Agent Orchestrator starting...');

  // 1. 加载提供者配置
  const providers = await loadConfig();
  console.log(`Loaded ${providers.length} provider configuration(s)`);

  // 2. 使用注册的提供者初始化 LLM 适配器
  const llmAdapter = initializeLLMAdapter(providers);

  // 3. 使用所有策略初始化 FileParser（HTML、Office、XMind）
  const fileParser = initializeFileParser();

  // 4. 使用 FileParser、LLMAdapter、工具系统和输出配置初始化编排器
  const { orchestrator, toolRegistry, toolExecutor } = initializeOrchestrator(fileParser, llmAdapter);

  // 5. 创建 SSE 管理器用于前端实时更新
  const sseManager = new SSEManager();

  // 6. 将编排器事件连接到 SSE 管理器
  wireOrchestratorToSSE(orchestrator, sseManager);

  // 7. 创建带所有 API 路由的 Express 服务器
  const port = parseInt(process.env.PORT ?? '3000', 10);

  const app = await createServer({
    routes: [
      { path: '/api/config', router: createConfigRouter() },
      { path: '/api/chat', router: createChatRouter({ orchestrator, toolRegistry, toolExecutor }) },
      { path: '/api/tools', router: createToolsRouter({ registry: toolRegistry, executor: toolExecutor }) },
      { path: '/api/remote', router: createRemoteRouter({ orchestrator, toolRegistry, toolExecutor }) },
      { path: '/api', router: createPipelineRouter({ orchestrator, sseManager }) },
    ],
  });

  // 8. 启动服务器
  const server = await startServer(app, port);

  // 9. 附加远程控制 WebSocket
  attachRemoteWebSocket(server, { orchestrator, toolRegistry, toolExecutor });

  // 10. 监视配置变化以支持 LLM 提供者热切换
  watchConfigChanges(llmAdapter);

  console.log('Multi-Agent Orchestrator is ready');
}

main().catch((err) => {
  console.error('Failed to start Multi-Agent Orchestrator:', err);
  process.exit(1);
});
