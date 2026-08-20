/**
 * 统一 WebSocket 聊天处理器。
 * PC 端和移动端共用同一套 WebSocket 通信逻辑。
 *
 * 连接路径:
 *   - PC 端:   /api/chat/ws
 *   - 移动端:  /api/chat/ws?token=xxx
 *
 * 区别仅在于移动端需要 token 验证（扫码场景），PC 端直接连接。
 *
 * 本文件是公共入口：HTTP upgrade、connected 载荷、purge/cleanup 编排、对外 re-export。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { URL } from 'url';
import { getSession, markSessionConnected } from './routes/remote.js';
import { readFirstSessionIdFromIndex, registerSessionListLiveSync } from './routes/sessions.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { MCPManager } from '../mcp/mcp-manager.js';
import { resolveDefaultChatModelMeta } from './routes/config.js';
import { deleteSessionImagesCache } from './images-cache.js';
import { clearSessionBgTasks } from '../session/bg-tasks-store.js';
import { disposeBackgroundTaskManagerForSession } from '../tools/background-task-manager.js';
import { stopAllShellWorkForSession, stopAllShellWork } from '../tools/session-shell-control.js';
import { getTaskQueueManager } from '../session/task-queue.js';
import { clearPendingNotesForSession } from '../session/pending-note.js';
import { clearHarnessRuntimeState } from '../harness/harness-runtime-registry.js';
import { clearIntentCheckpointTurnsForSession } from '../harness/intent-checkpoint-turn-snapshot.js';
import {
  addChatClient,
  broadcastMcpReady,
  broadcastTunnelReady,
  clearBroadcastState,
  getMcpReadySnapshot,
  getSubscribedSessionId,
  getTunnelReadySnapshot,
  removeChatClient,
  sendJSON,
  subscribeWsToSession,
  unsubscribeWsFromAll,
  broadcastSessionsIndexUpdated,
} from './chat-ws-broadcast.js';
import { detachBgTaskPusher, rebindBgTaskPusher, unwireBgTasksDiskSync, buildBgTasksForSession } from './chat-ws-bg-tasks.js';
import { clearAllConfirms, purgeSessionConfirms, replayPendingConfirmsToWs } from './chat-ws-confirm.js';
import { createInboundMessageHandler } from './chat-ws-inbound.js';
import { notifyTaskQueueUpdated } from './chat-ws-loop.js';
import {
  buildConnectedPayloadExtras,
  ensureActiveSessionBootstrapped,
  startChatRuntimePrewarm,
} from './chat-ws-persist.js';
import { buildShellCollabWsExtras } from './chat-ws-shell.js';
import {
  clearAllRunningTurns,
  getProcessingSessionIds,
  purgeRunningTurn,
  snapshotRunningTurn,
} from './chat-ws-running-turn.js';
import {
  DEFAULT_WORK_DIR,
  SESSIONS_DIR,
  clearRuntimeOnShutdown,
  dropSessionRunLocks,
  getActiveSessionId,
  buildSessionRunStatesSnapshot,
  getSessionsDir,
  isSessionTombstoned,
  purgeSessionMaps,
  resolveSessionWorkspacePayload,
} from './chat-ws-runtime.js';

export interface ChatWSOptions {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  mcpManager?: MCPManager;
  /** 未完成主配置时拒绝 WebSocket 连接 */
  isSetupRequired?: () => boolean;
}

export {
  getActiveSessionId,
  getSessionsDir,
  isSessionTombstoned,
};
export { getProcessingSessionIds };
export { broadcastMcpReady, broadcastTunnelReady };
export { notifyTaskQueueUpdated };

/**
 * 清理被删除会话在进程内的所有缓存。
 * 由 sessions REST DELETE 通过 `registerSessionCleanupHook` 注入；
 * 若删的是 active session，调用方应先 `switch_session` 到其它会话。
 */
export function purgeSessionRuntimeCaches(sessionId: string): void {
  purgeSessionMaps(sessionId);
  clearHarnessRuntimeState(sessionId);
  // 先杀 shell 子进程（前台 + 后台），再 abort harness，避免 abort 收尾期间命令仍在跑。
  try { stopAllShellWorkForSession(sessionId, 'session delete'); } catch { /* ignore */ }
  purgeRunningTurn(sessionId);
  dropSessionRunLocks(sessionId);
  purgeSessionConfirms(sessionId);
  clearIntentCheckpointTurnsForSession(sessionId);
  try { disposeBackgroundTaskManagerForSession(sessionId); } catch { /* ignore */ }
  unwireBgTasksDiskSync(sessionId);
  void clearSessionBgTasks(SESSIONS_DIR, sessionId).catch(() => {});
  try { void getTaskQueueManager(SESSIONS_DIR).clearSession(sessionId); } catch { /* ignore */ }
  clearPendingNotesForSession(sessionId);
  void deleteSessionImagesCache(sessionId).catch(() => {});
}

/**
 * 将统一 WebSocket 服务器附加到 HTTP 服务器上。
 * 路径: /api/chat/ws 或 /api/chat/ws?token=xxx
 */
export function attachChatWebSocket(server: Server, options: ChatWSOptions): void {
  const { orchestrator, toolRegistry, toolExecutor, mcpManager } = options;
  const inbound = createInboundMessageHandler({
    orchestrator,
    toolRegistry,
    toolExecutor,
    mcpManager,
  });

  registerSessionListLiveSync({
    getRunStates: buildSessionRunStatesSnapshot,
    notifyIndexUpdated: broadcastSessionsIndexUpdated,
  });

  void ensureActiveSessionBootstrapped().then(() => rebindBgTaskPusher(getActiveSessionId()).catch(() => {}));

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    try {
      const baseUrl = `http://${request.headers.host || 'localhost'}`;
      const url = new URL(request.url || '', baseUrl);

      if (url.pathname !== '/api/chat/ws' && url.pathname !== '/api/remote/ws') {
        return;
      }

      if (options.isSetupRequired?.()) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n');
        socket.write(JSON.stringify({ error: '请先完成模型配置', setupRequired: true }));
        socket.destroy();
        return;
      }

      const token = url.searchParams.get('token');

      if (token) {
        const session = getSession(token);
        if (!session) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        markSessionConnected(token);
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch (err) {
      console.warn('[chat-ws] WebSocket upgrade 失败:', err instanceof Error ? err.message : err);
      socket.destroy();
    }
  });

  wss.on('connection', async (ws: WebSocket, request) => {
    await ensureActiveSessionBootstrapped();

    let isRemote = false;
    try {
      const reqUrl = new URL(request.url || '', 'http://localhost');
      isRemote = Boolean(reqUrl.searchParams.get('token'));
    } catch (err) {
      console.warn('[chat-ws] remote session detect skipped:', err);
    }

    // 扫码连接只订阅列表第一项，不改进程级聚焦，避免打断 PC 正在看的会话流式。
    const subscribeSid = isRemote
      ? await readFirstSessionIdFromIndex()
      : getActiveSessionId();

    addChatClient(ws);
    subscribeWsToSession(ws, subscribeSid);
    void rebindBgTaskPusher(subscribeSid).catch(() => {});
    startChatRuntimePrewarm();
    ws.once('close', () => {
      removeChatClient(ws);
      unsubscribeWsFromAll(ws);
    });

    const features = { executionPlan: true };
    const sid = getSubscribedSessionId(ws) || subscribeSid;
    const runningTurn = snapshotRunningTurn(sid);
    const runtimeExtras = await buildConnectedPayloadExtras(sid);
    const bgTasks = await buildBgTasksForSession(sid);
    const shellCollabExtras = await buildShellCollabWsExtras(sid);
    const mcpReadySnapshot = getMcpReadySnapshot();
    const tunnelReadySnapshot = getTunnelReadySnapshot();
    const sessionRunStates = buildSessionRunStatesSnapshot();
    try {
      const [meta, workspace] = await Promise.all([
        resolveDefaultChatModelMeta(),
        resolveSessionWorkspacePayload(sid),
      ]);
      sendJSON(ws, {
        type: 'connected',
        message: '连接成功',
        features,
        activeSessionId: sid,
        sessionRunStates,
        ...(meta ? { modelContext: meta } : {}),
        ...workspace,
        ...shellCollabExtras,
        ...(mcpReadySnapshot ? { mcpReady: mcpReadySnapshot } : {}),
        ...(tunnelReadySnapshot ? { tunnelReady: tunnelReadySnapshot } : {}),
        ...(runningTurn ? { runningTurn } : {}),
        bgTasks,
        ...runtimeExtras,
      });
    } catch {
      sendJSON(ws, {
        type: 'connected',
        message: '连接成功',
        features,
        activeSessionId: sid,
        sessionRunStates,
        workspaceRoot: DEFAULT_WORK_DIR,
        defaultWorkDir: DEFAULT_WORK_DIR,
        ...shellCollabExtras,
        ...(mcpReadySnapshot ? { mcpReady: mcpReadySnapshot } : {}),
        ...(tunnelReadySnapshot ? { tunnelReady: tunnelReadySnapshot } : {}),
        ...(runningTurn ? { runningTurn } : {}),
        bgTasks,
        ...runtimeExtras,
      });
    }
    if (runningTurn?.isProcessing) {
      sendJSON(ws, { type: 'status', status: 'processing', sessionId: sid });
    }
    replayPendingConfirmsToWs(ws, sid);

    ws.on('message', (data) => {
      void inbound(ws, data);
    });

    ws.on('error', (err) => {
      console.debug('[chat-ws] WebSocket 连接错误:', err instanceof Error ? err.message : err);
    });
  });
}

/**
 * 清理聊天系统资源（优雅关闭时调用）。
 */
export function cleanupChatResources(): void {
  try { stopAllShellWork('app shutdown'); } catch { /* ignore */ }
  detachBgTaskPusher();
  clearRuntimeOnShutdown();
  clearBroadcastState();
  clearAllRunningTurns();
  clearAllConfirms();
  console.log('[chat-ws] Resources cleaned up');
}
