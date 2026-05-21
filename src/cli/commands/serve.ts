/**
 * ice serve — 启动 Web 服务器。
 * 复用现有的 Express + WebSocket 逻辑。
 */

import type { BootstrapResult } from '../bootstrap.js';
import { reloadLLMAdapter } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { getFlagNum } from '../utils/args-parser.js';
import { createServer, startServer } from '../../web/server.js';
import { createConfigRouter } from '../../web/routes/config.js';
import { createToolsRouter } from '../../web/routes/tools.js';
import { createRemoteRouter } from '../../web/routes/remote.js';
import { attachChatWebSocket, broadcastTunnelReady, cleanupChatResources } from '../../web/chat-ws.js';
import { startTunnelReadyWatcher } from '../../web/tunnel-ready-watcher.js';
import { createSessionsRouter } from '../../web/routes/sessions.js';
import { createUploadRouter } from '../../web/routes/upload.js';
import { createMemoryTelemetryRouter } from '../../web/routes/memory-telemetry.js';
import { createSupervisorEventsRouter } from '../../web/routes/supervisor-events.js';
import { createMemoryExportRouter } from '../../web/routes/memory-export.js';
import { createMemoryFilesRouter } from '../../web/routes/memory-files.js';
import type { Server } from 'http';
import { registerGracefulShutdown } from '../graceful-shutdown.js';
import { getBackgroundTaskManager } from '../../tools/background-task-manager.js';

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

  const app = await createServer({
    routes: [
      { path: '/api/config', router: createConfigRouter({
        configPath: paths.configPath,
        onConfigSaved: () => {
          reloadLLMAdapter(llmAdapter, paths.configPath).catch(err =>
            console.error('[serve] Failed to reload LLM adapter:', err));
        },
      }) },
      { path: '/api/tools', router: createToolsRouter({ registry: toolRegistry, executor: toolExecutor }) },
      { path: '/api/remote', router: createRemoteRouter({ orchestrator, toolRegistry, toolExecutor }) },
      { path: '/api/sessions', router: createSessionsRouter() },
      { path: '/api/chat', router: createUploadRouter() },
      { path: '/api/memory/telemetry', router: createMemoryTelemetryRouter() },
      { path: '/api/supervisor/events', router: createSupervisorEventsRouter() },
      { path: '/api/memory/files', router: createMemoryFilesRouter() },
      { path: '/api/memory', router: createMemoryExportRouter(llmAdapter) },
    ],
  });

  const server = await startServer(app, port);
  attachChatWebSocket(server, { orchestrator, toolRegistry, toolExecutor });

  const stopTunnelWatcher = startTunnelReadyWatcher({
    onReady: (url) => broadcastTunnelReady({ url }),
  });

  const cleanup = () => {
    stopTunnelWatcher();
    cleanupChatResources();
    server.close();
  };

  return { server, port, cleanup };
}

/**
 * ice serve 命令入口。
 */
export async function runServe(ctx: BootstrapResult, args: ParsedArgs): Promise<void> {
  const port = getFlagNum(args.flags, 'port', 'p') ?? parseInt(process.env.PORT ?? '3784', 10);

  const { cleanup } = await startWebServer(ctx, port);

  registerGracefulShutdown({
    message: 'iceCoder 正在退出...',
    cleanups: [
      () => { cleanup(); },
      () => { getBackgroundTaskManager().dispose(); },
      () => ctx.mcpManager.shutdown(),
    ],
  });
}
