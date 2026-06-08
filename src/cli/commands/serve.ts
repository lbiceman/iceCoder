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
import {
  attachChatWebSocket,
  broadcastTunnelReady,
  cleanupChatResources,
  purgeSessionRuntimeCaches,
} from '../../web/chat-ws.js';
import { startTunnelReadyWatcher } from '../../web/tunnel-ready-watcher.js';
import { createSessionsRouter, registerSessionCleanupHook } from '../../web/routes/sessions.js';

registerSessionCleanupHook(purgeSessionRuntimeCaches);
import { createUploadRouter } from '../../web/routes/upload.js';
import { createMemoryTelemetryRouter } from '../../web/routes/memory-telemetry.js';
import { createSupervisorEventsRouter } from '../../web/routes/supervisor-events.js';
import { createMemoryExportRouter } from '../../web/routes/memory-export.js';
import { createMemoryFilesRouter } from '../../web/routes/memory-files.js';
import type { Server } from 'http';
import { registerGracefulShutdown } from '../graceful-shutdown.js';
import { disposeAllBackgroundTaskManagers } from '../../tools/background-task-manager.js';
import { c, warn } from '../utils/terminal-ui.js';
import { resolveDefaultApiPort } from '../serve-port.js';

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
  const setupState = { required: ctx.needsSetup };

  const app = await createServer({
    setupGate: () => setupState.required,
    routes: [
      { path: '/api/config', router: createConfigRouter({
        configPath: paths.configPath,
        setSetupRequired: (required) => { setupState.required = required; },
        onConfigSaved: (ready) => {
          reloadLLMAdapter(llmAdapter, paths.configPath).catch(err =>
            console.error('[serve] Failed to reload LLM adapter:', err));
          if (ready) {
            console.log('[iceCoder] 模型配置已完成，聊天功能已启用');
          }
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
  attachChatWebSocket(server, {
    orchestrator,
    toolRegistry,
    toolExecutor,
    isSetupRequired: () => setupState.required,
  });

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
  const port = getFlagNum(args.flags, 'port', 'p') ?? resolveDefaultApiPort();

  const { cleanup } = await startWebServer(ctx, port);

  if (ctx.needsSetup) {
    warn('首次使用：请在浏览器中完成模型配置');
    console.log(`  ${c.cyan}http://127.0.0.1:${port}/#/config${c.reset}`);
  }

  registerGracefulShutdown({
    message: 'iceCoder 正在退出...',
    cleanups: [
      () => { cleanup(); },
      () => { disposeAllBackgroundTaskManagers(); },
      () => ctx.mcpManager.shutdown(),
    ],
  });
}
