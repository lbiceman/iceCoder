/**
 * Multi-Agent Orchestrator - Application Entry Point
 *
 * Loads provider configurations, initializes LLM adapters, file parser,
 * orchestrator with all 6 sub-agents, and starts the Express web server
 * with SSE support for real-time frontend updates.
 *
 * Requirements: 2.1, 10.4, 18.1, 18.6, 19.4, 19.5, 22.1, 22.6
 */

import fs from 'fs/promises';
import path from 'path';

// LLM layer
import { LLMAdapter } from './llm/llm-adapter.js';
import { OpenAIAdapter } from './llm/openai-adapter.js';
import { AnthropicAdapter } from './llm/anthropic-adapter.js';

// Parser layer
import { FileParser } from './parser/file-parser.js';
import { HtmlParserStrategy } from './parser/html-strategy.js';
import { OfficeParserStrategy } from './parser/office-strategy.js';
import { XMindParserStrategy } from './parser/xmind-strategy.js';

// Core
import { Orchestrator } from './core/orchestrator.js';

// Agents
import { RequirementAnalysisAgent } from './agents/requirement-analysis.js';
import { DesignAgent } from './agents/design.js';
import { TaskGenerationAgent } from './agents/task-generation.js';
import { CodeWritingAgent } from './agents/code-writing.js';
import { TestingAgent } from './agents/testing.js';
import { RequirementVerificationAgent } from './agents/requirement-verification.js';

// Web layer
import { SSEManager } from './web/sse.js';
import { createServer, startServer } from './web/server.js';
import { createConfigRouter } from './web/routes/config.js';
import { createChatRouter } from './web/routes/chat.js';
import { createPipelineRouter, wireOrchestratorToSSE } from './web/routes/pipeline.js';

// Types
import type { ProviderConfig } from './web/types.js';

const CONFIG_PATH = path.resolve('data/config.json');
const OUTPUT_DIR = path.resolve('output');

/**
 * Reads provider configurations from data/config.json.
 */
async function loadConfig(): Promise<ProviderConfig[]> {
  const data = await fs.readFile(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(data) as { providers: ProviderConfig[] };
  return config.providers;
}

/**
 * Registers LLM provider adapters based on the loaded configuration.
 * Sets the default provider to the one marked isDefault: true.
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

  // Set the default provider to the one marked isDefault: true
  const defaultProvider = providers.find((p) => p.isDefault);
  if (defaultProvider) {
    llmAdapter.setDefaultProvider(defaultProvider.providerName);
  } else if (providers.length > 0) {
    // Fallback to the first provider if none is marked as default
    llmAdapter.setDefaultProvider(providers[0].providerName);
  }

  return llmAdapter;
}

/**
 * Creates and configures the FileParser with all supported strategies.
 */
function initializeFileParser(): FileParser {
  const fileParser = new FileParser();
  fileParser.registerStrategy(new HtmlParserStrategy());
  fileParser.registerStrategy(new OfficeParserStrategy());
  fileParser.registerStrategy(new XMindParserStrategy());
  return fileParser;
}

/**
 * Creates the Orchestrator and registers all 6 sub-agents.
 */
function initializeOrchestrator(
  fileParser: FileParser,
  llmAdapter: LLMAdapter,
): Orchestrator {
  const orchestrator = new Orchestrator(fileParser, llmAdapter, {
    outputDir: OUTPUT_DIR,
  });

  // Register all 6 pipeline agents
  orchestrator.registerAgent(new RequirementAnalysisAgent());
  orchestrator.registerAgent(new DesignAgent());
  orchestrator.registerAgent(new TaskGenerationAgent());
  orchestrator.registerAgent(new CodeWritingAgent());
  orchestrator.registerAgent(new TestingAgent());
  orchestrator.registerAgent(new RequirementVerificationAgent());

  return orchestrator;
}

/**
 * Reloads provider configuration and re-initializes the LLM adapter.
 * Supports hot-switching providers without restarting agents.
 */
async function reloadLLMAdapter(llmAdapter: LLMAdapter): Promise<void> {
  const providers = await loadConfig();

  // Re-register all providers from the updated config
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
 * Watches data/config.json for changes and hot-reloads the LLM adapter.
 * Uses node:fs watchFile for broad compatibility.
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
 * Main application bootstrap.
 */
async function main(): Promise<void> {
  console.log('Multi-Agent Orchestrator starting...');

  // 1. Load provider configurations
  const providers = await loadConfig();
  console.log(`Loaded ${providers.length} provider configuration(s)`);

  // 2. Initialize LLM Adapter with registered providers
  const llmAdapter = initializeLLMAdapter(providers);

  // 3. Initialize FileParser with all strategies (HTML, Office, XMind)
  const fileParser = initializeFileParser();

  // 4. Initialize Orchestrator with FileParser, LLMAdapter, and output config
  const orchestrator = initializeOrchestrator(fileParser, llmAdapter);

  // 5. Create SSE Manager for real-time frontend updates
  const sseManager = new SSEManager();

  // 6. Wire Orchestrator events to SSE manager
  wireOrchestratorToSSE(orchestrator, sseManager);

  // 7. Create Express server with all API routes
  const port = parseInt(process.env.PORT ?? '3000', 10);

  const app = createServer({
    routes: [
      { path: '/api/config', router: createConfigRouter() },
      { path: '/api/chat', router: createChatRouter({ orchestrator }) },
      { path: '/api', router: createPipelineRouter({ orchestrator, sseManager }) },
    ],
  });

  // 8. Start the server
  await startServer(app, port);

  // 9. Watch for config changes to support LLM provider hot-switching
  watchConfigChanges(llmAdapter);

  console.log('Multi-Agent Orchestrator is ready');
}

main().catch((err) => {
  console.error('Failed to start Multi-Agent Orchestrator:', err);
  process.exit(1);
});
