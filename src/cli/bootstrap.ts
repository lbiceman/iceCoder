/**
 * 应用引导模块。
 * 抽取 index.ts 中的初始化逻辑为可复用函数，
 * 供 CLI 和 Web 入口共享。
 */

import fs from 'fs/promises';
import path from 'path';

import { LLMAdapter } from '../llm/llm-adapter.js';
import { OpenAIAdapter } from '../llm/openai-adapter.js';
import { AnthropicAdapter } from '../llm/anthropic-adapter.js';
import { FileParser } from '../parser/file-parser.js';
import { HtmlParserStrategy } from '../parser/html-strategy.js';
import { OfficeParserStrategy } from '../parser/office-strategy.js';
import { XMindParserStrategy } from '../parser/xmind-strategy.js';
import { Orchestrator } from '../core/orchestrator.js';
import { initializeToolSystem } from '../tools/index.js';
import { MCPManager } from '../mcp/index.js';
import { RequirementAnalysisAgent } from '../agents/requirement-analysis.js';
import { DesignAgent } from '../agents/design.js';
import { TaskGenerationAgent } from '../agents/task-generation.js';
import { CodeWritingAgent } from '../agents/code-writing.js';
import { TestingAgent } from '../agents/testing.js';
import { RequirementVerificationAgent } from '../agents/requirement-verification.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ProviderConfig } from '../web/types.js';

const CONFIG_PATH = path.resolve(process.env.ICE_CONFIG_PATH ?? 'data/config.json');
const OUTPUT_DIR = path.resolve(process.env.ICE_OUTPUT_DIR ?? 'output');

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
}

/**
 * 加载 LLM 提供者配置。
 */
export async function loadConfig(): Promise<ProviderConfig[]> {
  const data = await fs.readFile(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(data) as { providers: ProviderConfig[] };
  return config.providers;
}

/**
 * 初始化 LLM 适配器。
 */
export function initializeLLMAdapter(providers: ProviderConfig[]): LLMAdapter {
  const llmAdapter = new LLMAdapter();

  for (const provider of providers) {
    if (provider.providerName === 'openai') {
      llmAdapter.registerProvider(new OpenAIAdapter({
        apiKey: provider.apiKey,
        baseURL: provider.apiUrl,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens: provider.parameters.maxTokens,
        topP: provider.parameters.topP,
      }));
    } else if (provider.providerName === 'anthropic') {
      llmAdapter.registerProvider(new AnthropicAdapter({
        apiKey: provider.apiKey,
        model: provider.modelName,
        temperature: provider.parameters.temperature,
        maxTokens: provider.parameters.maxTokens,
        topP: provider.parameters.topP,
      }));
    }
  }

  const defaultProvider = providers.find((p) => p.isDefault);
  if (defaultProvider) {
    llmAdapter.setDefaultProvider(defaultProvider.providerName);
  } else if (providers.length > 0) {
    llmAdapter.setDefaultProvider(providers[0].providerName);
  }

  return llmAdapter;
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
 * 完整引导：加载配置 → 初始化所有组件。
 */
export async function bootstrap(): Promise<BootstrapResult> {
  // 加载配置
  const providers = await loadConfig();

  // 初始化 LLM
  const llmAdapter = initializeLLMAdapter(providers);

  // 初始化文件解析器
  const fileParser = initializeFileParser();

  // 初始化编排器
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

  // 初始化 MCP
  const mcpManager = new MCPManager({ configPath: CONFIG_PATH });
  try {
    await mcpManager.initialize();
    for (const tool of mcpManager.getRegisteredTools()) {
      registry.register(tool);
    }
  } catch (err) {
    console.error('MCP 初始化失败（不影响核心功能）:', err);
  }

  // 注册智能体
  orchestrator.registerAgent(new RequirementAnalysisAgent());
  orchestrator.registerAgent(new DesignAgent());
  orchestrator.registerAgent(new TaskGenerationAgent());
  orchestrator.registerAgent(new CodeWritingAgent());
  orchestrator.registerAgent(new TestingAgent());
  orchestrator.registerAgent(new RequirementVerificationAgent());

  return { llmAdapter, fileParser, orchestrator, toolRegistry: registry, toolExecutor: executor, mcpManager };
}

export { CONFIG_PATH };
