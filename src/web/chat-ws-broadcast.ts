/**
 * chat-ws 连接集合与广播：订阅、定向推送、全局 mcp/tunnel 快照。
 */

import { WebSocket } from 'ws';

/** 当前所有聊天 WebSocket 客户端（PC + 移动端），用于会话持久化后通知其它端拉取 default.json */
const chatClients = new Set<WebSocket>();

/**
 * 方案 B：按 sessionId 订阅的实时事件分发集合。
 * - 每个 WS 连上时默认订阅 `activeSessionId`
 * - `switch_session` 时换订阅
 * - WS 关闭时从所有订阅集移除
 *
 * 与 `chatClients` 并存：`chatClients` 用于全局通知（mcp_ready / tunnel_ready / session_updated），
 * `sessionSubscribers` 用于实时任务事件（step / stream / stream_end / response / pulse / tokenUsage / confirm 等）。
 */
const sessionSubscribers = new Map<string, Set<WebSocket>>();
/** WS → 当前订阅的 sessionId，便于 close / switch 时反查清理 */
const wsToSubscribedSession = new WeakMap<WebSocket, string>();

export function subscribeWsToSession(ws: WebSocket, sessionId: string): void {
  const prev = wsToSubscribedSession.get(ws);
  if (prev === sessionId) return;
  if (prev) {
    const prevSet = sessionSubscribers.get(prev);
    if (prevSet) {
      prevSet.delete(ws);
      if (prevSet.size === 0) sessionSubscribers.delete(prev);
    }
  }
  let set = sessionSubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    sessionSubscribers.set(sessionId, set);
  }
  set.add(ws);
  wsToSubscribedSession.set(ws, sessionId);
}

export function unsubscribeWsFromAll(ws: WebSocket): void {
  const sid = wsToSubscribedSession.get(ws);
  if (!sid) return;
  const set = sessionSubscribers.get(sid);
  if (set) {
    set.delete(ws);
    if (set.size === 0) sessionSubscribers.delete(sid);
  }
  wsToSubscribedSession.delete(ws);
}

export function getSubscribedSessionId(ws: WebSocket): string | undefined {
  return wsToSubscribedSession.get(ws);
}

export function addChatClient(ws: WebSocket): void {
  chatClients.add(ws);
}

export function removeChatClient(ws: WebSocket): void {
  chatClients.delete(ws);
}

export function pickSessionWs(sessionId: string, fallback?: WebSocket): WebSocket | undefined {
  if (fallback && fallback.readyState === WebSocket.OPEN) return fallback;
  const set = sessionSubscribers.get(sessionId);
  if (!set) return fallback;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) return ws;
  }
  return fallback;
}

/**
 * 向某 session 的所有订阅者广播一条 JSON。
 * 任务事件（step / stream 等）必须通过此函数下发，
 * 否则 F5 / 移动端扫码 / 切页面后新连上的 WS 将收不到当前任务进度。
 */
export function broadcastToSession(sessionId: string, data: unknown): void {
  const set = sessionSubscribers.get(sessionId);
  if (!set || set.size === 0) return;
  const body = JSON.stringify(data);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(body);
      } catch (err) {
        console.debug('[chat-ws] broadcastToSession 发送失败:', err instanceof Error ? err.message : err);
      }
    }
  }
}

/** 向 session 订阅者广播，可排除发送方（多端同步时发送端已有乐观 UI） */
export function broadcastToSessionExcept(
  sessionId: string,
  data: unknown,
  except?: WebSocket,
): void {
  const set = sessionSubscribers.get(sessionId);
  if (!set || set.size === 0) return;
  const body = JSON.stringify(data);
  for (const ws of set) {
    if (except && ws === except) continue;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(body);
      } catch (err) {
        console.debug('[chat-ws] broadcastToSessionExcept 发送失败:', err instanceof Error ? err.message : err);
      }
    }
  }
}

/** 向订阅者发送已序列化的 bg_task_update JSON（BgTaskPusher 回调） */
export function broadcastBgTaskJson(sessionId: string, jsonBody: string): void {
  const set = sessionSubscribers.get(sessionId);
  if (!set || set.size === 0) return;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(jsonBody);
      } catch (err) {
        console.debug('[chat-ws] broadcastBgTaskJson 发送失败:', err instanceof Error ? err.message : err);
      }
    }
  }
}

export function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function sendToAllChatClients(jsonBody: string): void {
  for (const client of chatClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(jsonBody);
      } catch {
        /* ignore */
      }
    }
  }
}

export function broadcastSessionUpdated(
  reason: string,
  meta?: { sessionId?: string; title?: string },
  except?: WebSocket,
): void {
  const payload = JSON.stringify({ type: 'session_updated', reason, ...meta });
  const notifyAll = Boolean(meta?.title);
  for (const client of chatClients) {
    if (!notifyAll && client === except) continue;
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

/** MCP 后台初始化完成后的最新状态（晚到的 WS 连接可从 connected 包中补齐） */
let mcpReadySnapshot: {
  ok: boolean;
  toolCount: number;
  readyServers: number;
  errorMessage?: string;
} | null = null;

/** Quick Tunnel 公网 URL 就绪后快照（晚到的 WS 可从 connected 补齐） */
let tunnelReadySnapshot: { url: string } | null = null;

export function getMcpReadySnapshot(): typeof mcpReadySnapshot {
  return mcpReadySnapshot;
}

export function getTunnelReadySnapshot(): typeof tunnelReadySnapshot {
  return tunnelReadySnapshot;
}

/** MCP 后台初始化结束（成功或失败）时广播给所有已连接的聊天客户端 */
export function broadcastMcpReady(payload: {
  ok: boolean;
  toolCount: number;
  readyServers: number;
  errorMessage?: string;
}): void {
  const snap = {
    ok: payload.ok,
    toolCount: payload.toolCount,
    readyServers: payload.readyServers,
    ...(payload.errorMessage ? { errorMessage: payload.errorMessage } : {}),
  };
  mcpReadySnapshot = snap;
  sendToAllChatClients(JSON.stringify({ type: 'mcp_ready', ...snap }));
}

/** Cloudflare Quick Tunnel 可用时广播给所有聊天 WS 客户端 */
export function broadcastTunnelReady(payload: { url: string }): void {
  tunnelReadySnapshot = { url: payload.url };
  sendToAllChatClients(JSON.stringify({
    type: 'tunnel_ready',
    url: payload.url,
  }));
}

export function clearBroadcastState(): void {
  chatClients.clear();
  sessionSubscribers.clear();
  mcpReadySnapshot = null;
  tunnelReadySnapshot = null;
}
