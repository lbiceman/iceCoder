/**
 * 统一 WebSocket 聊天处理器。
 * PC 端和移动端共用同一套 WebSocket 通信逻辑。
 * 
 * 连接路径:
 *   - PC 端:   /api/chat/ws
 *   - 移动端:  /api/chat/ws?token=xxx
 * 
 * 区别仅在于移动端需要 token 验证（扫码场景），PC 端直接连接。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { URL } from 'url';
import { promises as fsPromises } from 'node:fs';
import path from 'path';
import { getSession, markSessionConnected } from './routes/remote.js';
import { getActiveSession, setActiveSession } from './routes/sessions.js';
import { Harness } from '../harness/harness.js';
import type { HarnessConfig } from '../harness/types.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

const SYSTEM_PROMPT_PATH = path.resolve('data/system-prompt.md');
const SESSIONS_DIR = path.resolve('data/sessions');

async function loadSystemPrompt(): Promise<string> {
  try {
    return await fsPromises.readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch {
    return '你是一个智能助手，拥有工具能力。根据用户需求自主决定使用哪些工具。回答使用中文。';
  }
}

/** 追加消息到会话文件 */
async function appendMessages(sessionId: string, msgs: { role: string; content: string }[]): Promise<void> {
  if (!sessionId || msgs.length === 0) return;
  try {
    await fsPromises.mkdir(SESSIONS_DIR, { recursive: true });
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(SESSIONS_DIR, `${safeId}.json`);

    let existing: { role: string; content: string }[] = [];
    try {
      const data = await fsPromises.readFile(filePath, 'utf-8');
      existing = JSON.parse(data);
    } catch { /* file doesn't exist yet */ }

    existing.push(...msgs);
    await fsPromises.writeFile(filePath, JSON.stringify(existing), 'utf-8');

    // 更新会话列表的 updatedAt
    const listFile = path.join(SESSIONS_DIR, '_list.json');
    let list: { id: string; title: string; updatedAt: number }[] = [];
    try {
      const listData = await fsPromises.readFile(listFile, 'utf-8');
      list = JSON.parse(listData);
    } catch { /* empty */ }
    const idx = list.findIndex(s => s.id === sessionId);
    if (idx >= 0) {
      list[idx].updatedAt = Date.now();
    } else {
      // 从消息中提取标题
      const userMsg = msgs.find(m => m.role === 'user');
      const title = userMsg ? (userMsg.content.length > 30 ? userMsg.content.substring(0, 30) + '…' : userMsg.content) : '新对话';
      list.unshift({ id: sessionId, title, updatedAt: Date.now() });
    }
    await fsPromises.writeFile(listFile, JSON.stringify(list), 'utf-8');
  } catch (err) {
    console.error('[chat-ws] appendMessages failed:', err);
  }
}

export interface ChatWSOptions {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
}

/**
 * 将统一 WebSocket 服务器附加到 HTTP 服务器上。
 * 路径: /api/chat/ws 或 /api/chat/ws?token=xxx
 */
export function attachChatWebSocket(server: Server, options: ChatWSOptions): void {
  const { orchestrator, toolRegistry, toolExecutor } = options;

  const wss = new WebSocketServer({ noServer: true });

  // 处理 HTTP 升级请求
  server.on('upgrade', (request, socket, head) => {
    try {
      const baseUrl = `http://${request.headers.host || 'localhost'}`;
      const url = new URL(request.url || '', baseUrl);

      // 同时支持旧路径（兼容）和新路径
      if (url.pathname !== '/api/chat/ws' && url.pathname !== '/api/remote/ws') {
        return;
      }

      const token = url.searchParams.get('token');

      // 有 token → 验证（移动端扫码场景）
      if (token) {
        const session = getSession(token);
        if (!session) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        markSessionConnected(token);
      }
      // 无 token → PC 端直接连接，不需要验证

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } catch {
      socket.destroy();
    }
  });

  // 处理 WebSocket 连接（PC 和移动端统一处理）
  wss.on('connection', (ws: WebSocket) => {
    console.log('[ChatWS] Client connected');

    sendJSON(ws, { type: 'connected', message: '连接成功' });

    let isProcessing = false;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ping') {
          sendJSON(ws, { type: 'pong' });
          return;
        }

        if (msg.type === 'stop') {
          // TODO: 支持中断正在执行的任务
          return;
        }

        if (msg.type === 'message' && msg.content) {
          if (isProcessing) {
            sendJSON(ws, { type: 'error', message: '正在处理上一条指令，请稍候' });
            return;
          }

          isProcessing = true;
          sendJSON(ws, { type: 'status', status: 'processing' });

          try {
            await handleChatMessage(ws, msg.content, orchestrator, toolRegistry, toolExecutor, msg.sessionId);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : '执行失败';
            sendJSON(ws, { type: 'error', message: errMsg });
          }

          isProcessing = false;
          sendJSON(ws, { type: 'status', status: 'idle' });
        }
      } catch {
        sendJSON(ws, { type: 'error', message: '消息格式错误' });
      }
    });

    ws.on('close', () => {
      console.log('[ChatWS] Client disconnected');
    });

    ws.on('error', () => { /* ignore */ });
  });
}

/**
 * 处理聊天消息，执行 AI 对话并实时推送进度。
 * PC 端和移动端共用此函数。
 */
async function handleChatMessage(
  ws: WebSocket,
  message: string,
  orchestrator: Orchestrator,
  toolRegistry: ToolRegistry,
  toolExecutor: ToolExecutor,
  sessionId?: string,
): Promise<void> {
  const llmAdapter = orchestrator.getLLMAdapter();
  const toolDefs = toolRegistry.getDefinitions();
  const systemPrompt = await loadSystemPrompt();

  // 确定目标会话 ID
  const targetSessionId = sessionId || await getActiveSession() || undefined;

  // 记录活跃会话
  if (targetSessionId) {
    setActiveSession(targetSessionId).catch(() => {});
  }

  // 立即写入用户消息到会话文件
  if (targetSessionId) {
    await appendMessages(targetSessionId, [{ role: 'user', content: message }]);
  }

  const harnessConfig: HarnessConfig = {
    context: { systemPrompt, tools: toolDefs },
    loop: {
      maxRounds: 800,
      timeout: 60 * 60 * 1000,
    },
    permissions: [
      { pattern: 'delete_file', permission: 'confirm', reason: '删除文件需要用户确认' },
    ],
    compactionThreshold: 40,
    compactionKeepRecent: 10,
    onConfirm: (toolName, args) => {
      return new Promise<boolean>((resolve) => {
        sendJSON(ws, { type: 'confirm', toolName, args });

        const handler = (data: Buffer | string) => {
          try {
            const reply = JSON.parse(data.toString());
            if (reply.type === 'confirm_reply') {
              ws.off('message', handler);
              resolve(!!reply.approved);
            }
          } catch { /* ignore */ }
        };
        ws.on('message', handler);

        setTimeout(() => {
          ws.off('message', handler);
          resolve(false);
        }, 60_000);
      });
    },
  };

  const harness = new Harness(harnessConfig, toolExecutor);

  // 实时写入 step 消息的批量队列
  let pendingSteps: { role: string; content: string }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushSteps(): Promise<void> {
    if (pendingSteps.length === 0 || !targetSessionId) return;
    const batch = pendingSteps.splice(0);
    await appendMessages(targetSessionId, batch).catch(() => {});
  }

  function enqueueStep(msg: string): void {
    pendingSteps.push({ role: 'agent', content: msg });
    if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        flushTimer = null;
        await flushSteps();
      }, 2000);
    }
  }

  const result = await harness.run(
    message,
    (msgs, opts) => llmAdapter.chat(msgs, opts),
    (event) => {
      // 推送到 WebSocket（如果还连着）
      sendJSON(ws, { type: 'step', step: event });

      // 格式化 step 消息并加入写入队列
      let stepMsg = '';
      if (event.type === 'tool_call') {
        const argsPreview = event.toolArgs ? JSON.stringify(event.toolArgs) : '';
        const truncated = argsPreview.length > 100 ? argsPreview.substring(0, 100) + '…' : argsPreview;
        stepMsg = `[call] ${event.toolName}(${truncated})`;
      } else if (event.type === 'tool_result') {
        const icon = event.toolSuccess ? '[ok]' : '[err]';
        const preview = event.toolOutput ? event.toolOutput.substring(0, 150) : (event.toolError || '');
        const truncated = preview.length > 150 ? preview.substring(0, 150) + '…' : preview;
        stepMsg = `${icon} ${event.toolName} → ${truncated}`;
      }
      if (stepMsg) {
        enqueueStep(stepMsg);
      }
    },
  );

  // 确保剩余 step 写入
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flushSteps();

  // 写入最终 AI 回复
  if (targetSessionId && result.content) {
    await appendMessages(targetSessionId, [{ role: 'agent', content: result.content }]).catch(() => {});
  }

  // 推送最终结果到 WebSocket
  if (result.content) {
    sendJSON(ws, { type: 'response', content: result.content });
  }
  if (result.loopState.totalToolCalls > 0) {
    sendJSON(ws, { type: 'info', message: `共调用 ${result.loopState.totalToolCalls} 次工具` });
  }
  sendJSON(ws, {
    type: 'tokenUsage',
    inputTokens: result.loopState.totalInputTokens,
    outputTokens: result.loopState.totalOutputTokens,
  });
}

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
