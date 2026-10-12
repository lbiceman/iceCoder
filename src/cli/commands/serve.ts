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
  recordSessionDeferredToolCall,
} from '../../web/chat-ws.js';
import { registerBootstrapSessionHints } from '../../web/last-active-session.js';
import { startTunnelReadyWatcher } from '../../web/tunnel-ready-watcher.js';
import {
  backfillScheduledTaskSessions,
  createSessionRecord,
  createSessionsRouter,
  markScheduledTaskSession,
  notifySessionListChanged,
  registerSessionCleanupHook,
} from '../../web/routes/sessions.js';
import { createScheduledTasksRouter } from '../../web/routes/scheduled-tasks.js';
import {
  createScheduledTaskExecutor,
  ensureScheduledTaskSession,
  isScheduledTaskBusy,
  migrateLegacyScheduledTaskImages,
  scheduledTaskSessionExists,
} from '../../web/scheduled-task-runtime.js';
import { createScheduledTaskAttachments } from '../../web/scheduled-task-attachments.js';
import { createScheduledTaskService } from '../../web/scheduled-task-service.js';
import { SCHEDULED_TASK_TOOL_NAME, createScheduledTaskTool } from '../../web/scheduled-task-tool.js';
import { registerSessionToolProvider } from '../../tools/session-tool-providers.js';
import { enableOsSchedulerGuard } from '../../tools/shell-os-scheduler-guard.js';
import { ScheduledTaskStore } from '../../session/scheduled-task-store.js';
import { ScheduledTaskScheduler } from '../../session/scheduled-task-scheduler.js';
import { registerScheduledTaskResultHandler } from '../../session/scheduled-task-events.js';
import path from 'node:path';

registerSessionCleanupHook(purgeSessionRuntimeCaches);
registerBootstrapSessionHints({
  getRuntimeActiveId: getActiveSessionId,
  getProcessingSessionIds,
});
import { createUploadRouter, purgeAllUploadedFiles } from '../../web/routes/upload.js';
import { createMemoryTelemetryRouter } from '../../web/routes/memory-telemetry.js';
import { createSupervisorEventsRouter } from '../../web/routes/supervisor-events.js';
import { createTokenUsageRouter } from '../../web/routes/token-usage.js';
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

  const scheduledTaskStore = new ScheduledTaskStore(path.join(paths.dataDir, 'scheduled-tasks.json'));
  scheduledTaskStore.onChange(notifySessionListChanged);
  const scheduledTaskSessionDeps = {
    store: scheduledTaskStore,
    createSession: createSessionRecord,
    markSession: markScheduledTaskSession,
  };
  const scheduledTaskAttachments = createScheduledTaskAttachments({
    filesRoot: path.join(paths.dataDir, 'scheduled-task-files'),
  });
  const executeScheduledTask = createScheduledTaskExecutor({
    chatDeps: { orchestrator, toolRegistry, toolExecutor, mcpManager },
    prepareSession: (task) => ensureScheduledTaskSession(task, scheduledTaskSessionDeps),
  });
  const scheduledTaskScheduler = new ScheduledTaskScheduler({
    store: scheduledTaskStore,
    execute: async (task) => {
      if (setupState.required) throw new Error('请先完成模型配置');
      await executeScheduledTask(task);
    },
    isBusy: isScheduledTaskBusy,
  });
  const scheduledTaskServiceDeps = {
    store: scheduledTaskStore,
    scheduler: scheduledTaskScheduler,
    attachments: scheduledTaskAttachments,
  };
  const scheduledTaskService = createScheduledTaskService(scheduledTaskServiceDeps);
  const unregisterScheduledTaskTool = registerSessionToolProvider(async ({ sessionId }) => {
    const tasks = await scheduledTaskStore.list();
    return [createScheduledTaskTool({
      service: scheduledTaskService,
      inTaskSession: tasks.some((t) => t.sessionId === sessionId),
    })];
  });
  const disableOsSchedulerGuard = enableOsSchedulerGuard({
    onBlocked: (sessionId) => recordSessionDeferredToolCall(sessionId, SCHEDULED_TASK_TOOL_NAME),
  });

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
      { path: '/api/sessions', router: createSessionsRouter({ listScheduledTasks: () => scheduledTaskStore.list() }) },
      { path: '/api/chat', router: createUploadRouter() },
      { path: '/api/memory/telemetry', router: createMemoryTelemetryRouter() },
      { path: '/api/supervisor/events', router: createSupervisorEventsRouter() },
      { path: '/api/token-usage', router: createTokenUsageRouter() },
      { path: '/api/memory/files', router: createMemoryFilesRouter() },
      { path: '/api/skills', router: createSkillsRouter() },
      { path: '/api/scheduled-tasks', router: createScheduledTasksRouter({
        ...scheduledTaskServiceDeps,
        sessionExists: scheduledTaskSessionExists,
      }) },
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

  registerScheduledTaskResultHandler(async ({ taskId, success, error }) => {
    if (!(await scheduledTaskStore.get(taskId))) return;
    await scheduledTaskStore.updateRunState(taskId, {
      lastStatus: success ? 'success' : 'error',
      lastError: error,
    });
  });
  try {
    await migrateLegacyScheduledTaskImages(scheduledTaskStore, scheduledTaskAttachments);
  } catch (err) {
    console.warn('[scheduled-tasks] 旧版本任务图片迁移失败，下次启动重试:', err);
  }
  try {
    await backfillScheduledTaskSessions(await scheduledTaskStore.list());
  } catch (err) {
    console.warn('[scheduled-tasks] 任务会话标记回填失败，下次启动重试:', err);
  }
  await scheduledTaskScheduler.start();

  const stopTunnelWatcher = startTunnelReadyWatcher({
    onReady: (url) => broadcastTunnelReady({ url }),
  });
  const stopConfigWatch = watchConfigChanges(llmAdapter, paths.configPath);

  const cleanup = () => {
    scheduledTaskScheduler.stop();
    unregisterScheduledTaskTool();
    disableOsSchedulerGuard();
    registerScheduledTaskResultHandler(null);
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
