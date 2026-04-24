/**
 * ice serve — 启动 Web 服务器。
 * 复用现有的 Express + WebSocket 逻辑。
 */

import type { BootstrapResult } from '../bootstrap.js';
import { reloadLLMAdapter } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { getFlagNum } from '../utils/args-parser.js';
import { SSEManager } from '../../web/sse.js';
import { createServer, startServer } from '../../web/server.js';
import { createConfigRouter } from '../../web/routes/config.js';
import { createPipelineRouter, wireOrchestratorToSSE } from '../../web/routes/pipeline.js';
import { createToolsRouter } from '../../web/routes/tools.js';
import { createRemoteRouter } from '../../web/routes/remote.js';
import { attachChatWebSocket, cleanupChatResources } from '../../web/chat-ws.js';
import { createSessionsRouter } from '../../web/routes/sessions.js';
import { createUploadRouter } from '../../web/routes/upload.js';
import type { Server } from 'http';

export interface ServeResult {
  server: Server;
  port: number;
  cleanup: () => void;
}

/**
 * 启动 Web 服务器，返回 server 实例。
 */
export async function startWebServer(ctx: BootstrapResult, port: number): Promise<ServeResult> {
  const { orchestrator, toolRegistry, toolExecutor, llmAdapter, paths } = ctx;

  const sseManager = new SSEManager();
  wireOrchestratorToSSE(orchestrator, sseManager);

  const app = await createServer({
    routes: [
      { path: '/api/config', router: createConfigRouter({
        onConfigSaved: () => {
          reloadLLMAdapter(llmAdapter, paths.configPath).catch(err =>
            console.error('[serve] Failed to reload LLM adapter:', err));
        },
      }) },
      { path: '/api/tools', router: createToolsRouter({ registry: toolRegistry, executor: toolExecutor }) },
      { path: '/api/remote', router: createRemoteRouter({ orchestrator, toolRegistry, toolExecutor }) },
      { path: '/api/sessions', router: createSessionsRouter() },
      { path: '/api/chat/upload', router: createUploadRouter() },
      { path: '/api', router: createPipelineRouter({ orchestrator, sseManager }) },
    ],
  });

  const server = await startServer(app, port);
  attachChatWebSocket(server, { orchestrator, toolRegistry, toolExecutor });

  const cleanup = () => {
    cleanupChatResources();
    server.close();
  };

  return { server, port, cleanup };
}

/**
 * ice serve 命令入口。
 */
export async function runServe(ctx: BootstrapResult, args: ParsedArgs): Promise<void> {
  const port = getFlagNum(args.flags, 'port', 'p') ?? parseInt(process.env.PORT ?? '3000', 10);

  const { cleanup } = await startWebServer(ctx, port);

  // 优雅关闭
  const shutdown = () => {
    console.log('Shutting down...');
    cleanup();
    ctx.mcpManager.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
