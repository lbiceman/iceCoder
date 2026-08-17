/**
 * ice serve — 启动 Web 服务器。
 * 复用现有的 Express + WebSocket 逻辑。
 */

import type { BootstrapResult } from '../bootstrap.js';
import { reloadLLMAdapter, watchConfigChanges } from '../bootstrap.js';
import type { ParsedArgs } from '../utils/args-parser.js';
import { getFlagNum } from '../utils/args-parser.js';
import { createServer, startServer } from '../../web/server.js';
import { createConfigRouter } from '../../web/routes/config.js';
import { createToolsRouter } from '../../web/routes/tools.js';
import { createRemoteRouter } from '../../web/routes/remote.js';
import {
  attachChatWebSocket,
  broadcastMcpReady,
  broadcastTunnelReady,
  cleanupChatResources,
  getActiveSessionId,
  getProcessingSessionIds,
  purgeSessionRuntimeCaches,
} from '../../web/chat-ws.js';
import { registerBootstrapSessionHints } from '../../web/last-active-session.js';
import { startTunnelReadyWatcher } from '../../web/tunnel-ready-watcher.js';
import { createSessionsRouter, registerSessionCleanupHook } from '../../web/routes/sessions.js';

registerSessionCleanupHook(purgeSessionRuntimeCaches);
registerBootstrapSessionHints({
  getRuntimeActiveId: getActiveSessionId,
  getProcessingSessionIds,
});
import { createUploadRouter, purgeAllUploadedFiles } from '../../web/routes/upload.js';
import { createMemoryTelemetryRouter } from '../../web/routes/memory-telemetry.js';
import { createSupervisorEventsRouter } from '../../web/routes/supervisor-events.js';
import { createMemoryExportRouter } from '../../web/routes/memory-export.js';
import { createMemoryFilesRouter } from '../../web/routes/memory-files.js';
import { createMemoryDreamRouter } from '../../web/routes/memory-dream.js';
import { createSkillsRouter } from '../../web/routes/skills.js';
import { createMcpStatusRouter } from '../../web/routes/mcp-status.js';
import { createWorkspaceBrowseRouter } from '../../web/routes/workspace-browse.js';
import type { Server } from 'http';
import { registerGracefulShutdown } from '../graceful-shutdown.js';
import { disposeAllBackgroundTaskManagers } from '../../tools/background-task-manager.js';
import { stopAllShellWork } from '../../tools/session-shell-control.js';
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
  const { orchestrator, toolRegistry, toolExecutor, llmAdapter, paths, mcpManager } = ctx;
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
      { path: '/api/skills', router: createSkillsRouter() },
      { path: '/api/mcp', router: createMcpStatusRouter({
        mcpManager,
        registry: toolRegistry,
        onReloaded: (r) => {
          broadcastMcpReady({
            ok: r.ok,
            toolCount: r.toolCount,
            readyServers: r.readyServers,
            ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
          });
        },
      }) },
      { path: '/api/workspace', router: createWorkspaceBrowseRouter() },
      { path: '/api/memory/dream', router: createMemoryDreamRouter(llmAdapter) },
      { path: '/api/memory', router: createMemoryExportRouter(llmAdapter) },
    ],
  });

  const server = await startServer(app, port);
  attachChatWebSocket(server, {
    orchestrator,
    toolRegistry,
    toolExecutor,
    mcpManager,
    isSetupRequired: () => setupState.required,
  });

  const stopTunnelWatcher = startTunnelReadyWatcher({
    onReady: (url) => broadcastTunnelReady({ url }),
  });
  const stopConfigWatch = watchConfigChanges(llmAdapter, paths.configPath);

  const cleanup = () => {
    stopConfigWatch();
    stopTunnelWatcher();
    cleanupChatResources();
    server.close();
  };

  return { server, port, cleanup };
}

/**
 * Electron / `npm start` / `iceCoder web` 共用的退出清理（停 HTTP、Shell、上传缓存、MCP）。
 */
export function registerWebRuntimeShutdown(ctx: BootstrapResult, cleanup: () => void): void {
  registerGracefulShutdown({
    message: 'iceCoder 正在退出...',
    cleanups: [
      () => { cleanup(); },
      () => { stopAllShellWork('shutdown'); },
      () => { disposeAllBackgroundTaskManagers(); },
      () => { purgeAllUploadedFiles(); },
      () => ctx.mcpManager.shutdown(),
    ],
  });
}

/**
 * ice serve 命令入口。
 */
export async function runServe(ctx: BootstrapResult, args: ParsedArgs): Promise<void> {
  const port = getFlagNum(args.flags, 'port', 'p') ?? resolveDefaultApiPort();

  const { cleanup } = await startWebServer(ctx, port);

  if (ctx.needsSetup) {
    warn('首次使用：请在浏览器中完成模型配置');
    console.log(`  ${c.cyan}http://127.0.0.1:${port}/#/settings${c.reset}`);
  }

  registerWebRuntimeShutdown(ctx, cleanup);
}
