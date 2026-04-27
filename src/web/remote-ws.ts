/**
 * 远程控制 WebSocket 处理器。
 * 手机端通过 WebSocket 发送指令，服务端复用 Harness 执行并回传结果。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { URL } from 'url';
import { promises as fsPromises } from 'node:fs';
import path from 'path';
import { getSession, markSessionConnected } from './routes/remote.js';
import { Harness } from '../harness/harness.js';
import type { HarnessConfig } from '../harness/types.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

const SYSTEM_PROMPT_PATH = path.resolve('data/system-prompt.md');
const SESSIONS_DIR = path.resolve('data/sessions');
const SESSION_ID = 'default';

async function loadSystemPrompt(): Promise<string> {
  try {
    return await fsPromises.readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch {
    return '你是 iceCoder，一个拥有工具能力的智能编程助手。根据用户需求自主决定使用哪些工具。回答使用中文。';
  }
}

/** 将远程消息追加到会话文件（与 PC 端共享固定文件） */
async function appendToSession(userMsg: string, agentMsg: string, steps: string[]): Promise<void> {
  try {
    await fsPromises.mkdir(SESSIONS_DIR, { recursive: true });
    const sessionFile = path.join(SESSIONS_DIR, `${SESSION_ID}.json`);

    let existing: { role: string; content: string }[] = [];
    try {
      const data = await fsPromises.readFile(sessionFile, 'utf-8');
      existing = JSON.parse(data);
    } catch { /* file doesn't exist yet */ }

    for (const s of steps) {
      existing.push({ role: 'agent', content: s });
    }
    existing.push({ role: 'user', content: userMsg });
    if (agentMsg) {
      existing.push({ role: 'agent', content: agentMsg });
    }

    await fsPromises.writeFile(sessionFile, JSON.stringify(existing), 'utf-8');
  } catch (err) {
    console.error('[remote-ws] Failed to save to session:', err);
  }
}

export interface RemoteWSOptions {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
}

/**
 * 将 WebSocket 服务器附加到 HTTP 服务器上。
 * 路径: /api/remote/ws?token=xxx
 */
export function attachRemoteWebSocket(server: Server, options: RemoteWSOptions): void {
  const { orchestrator, toolRegistry, toolExecutor } = options;

  const wss = new WebSocketServer({ noServer: true });

  // 处理 HTTP 升级请求
  server.on('upgrade', (request, socket, head) => {
    try {
      const baseUrl = `http://${request.headers.host || 'localhost'}`;
      const url = new URL(request.url || '', baseUrl);

      if (url.pathname !== '/api/remote/ws') {
        // 不是本 handler 的路径，跳过（让其他 upgrade handler 处理）
        return;
      }

      const token = url.searchParams.get('token');
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const session = getSession(token);
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      // 标记会话已连接
      markSessionConnected(token);

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, token);
      });
    } catch {
      socket.destroy();
    }
  });

  // 处理 WebSocket 连接
  wss.on('connection', (ws: WebSocket, _request: unknown, token: string) => {
    console.log(`[Remote] Mobile client connected (token: ${token.slice(0, 8)}...)`);

    // 发送连接成功消息
    sendJSON(ws, { type: 'connected', message: '连接成功，可以开始发送指令' });

    let isProcessing = false;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ping') {
          sendJSON(ws, { type: 'pong' });
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
            await handleRemoteMessage(ws, msg.content, orchestrator, toolRegistry, toolExecutor);
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
      console.log(`[Remote] Mobile client disconnected (token: ${token.slice(0, 8)}...)`);
      // 不删除会话，允许刷新后重新连接。会话只在生成新二维码时才清除。
    });

    ws.on('error', () => {
      // 同上，不删除会话
    });
  });
}

/**
 * 处理来自手机端的消息，复用 Harness 执行 AI 对话。
 */
async function handleRemoteMessage(
  ws: WebSocket,
  message: string,
  orchestrator: Orchestrator,
  toolRegistry: ToolRegistry,
  toolExecutor: ToolExecutor,
): Promise<void> {
  const llmAdapter = orchestrator.getLLMAdapter();
  const toolDefs = toolRegistry.getDefinitions();
  const systemPrompt = await loadSystemPrompt();

  const harnessConfig: HarnessConfig = {
    context: {
      systemPrompt,
      tools: toolDefs,
    },
    loop: {
      maxRounds: 800,
      timeout: 60 * 60 * 1000, // 1 小时超时
    },
    permissions: [
      { pattern: 'delete_file', permission: 'confirm', reason: '删除文件需要用户确认' },
    ],
    compactionThreshold: 40,
    compactionKeepRecent: 10,
    onConfirm: (toolName, args) => {
      return new Promise<boolean>((resolve) => {
        sendJSON(ws, {
          type: 'confirm',
          toolName,
          args,
        });

        // 监听确认回复
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

        // 60 秒超时自动拒绝
        setTimeout(() => {
          ws.off('message', handler);
          resolve(false);
        }, 60_000);
      });
    },
  };

  const harness = new Harness(harnessConfig, toolExecutor);

  // 先把用户消息立即写入会话文件
  await appendToSession(message, '', []);

  // 用于实时追加 step 到会话文件的辅助函数
  let pendingSteps: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** 将积攒的 step 消息批量追加到会话文件（防止写入过于频繁） */
  async function flushSteps(): Promise<void> {
    if (pendingSteps.length === 0) return;
    const batch = pendingSteps.splice(0);
    try {
      const filePath = path.join(SESSIONS_DIR, `${SESSION_ID}.json`);
      let existing: { role: string; content: string }[] = [];
      try {
        const data = await fsPromises.readFile(filePath, 'utf-8');
        existing = JSON.parse(data);
      } catch { /* ignore */ }
      for (const s of batch) {
        existing.push({ role: 'agent', content: s });
      }
      await fsPromises.writeFile(filePath, JSON.stringify(existing), 'utf-8');
    } catch { /* ignore flush errors */ }
  }

  /** 将 step 消息加入待写入队列，每 2 秒批量写入一次 */
  function enqueueStep(msg: string): void {
    pendingSteps.push(msg);
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
      if (ws.readyState === WebSocket.OPEN) {
        sendJSON(ws, { type: 'step', step: event });
      }

      // 收集 step 消息并实时写入会话文件
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

  // 确保剩余的 step 消息写入
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await flushSteps();

  // 追加最终 AI 回复到会话文件
  if (result.content) {
    try {
      const filePath = path.join(SESSIONS_DIR, `${SESSION_ID}.json`);
      let existing: { role: string; content: string }[] = [];
      try {
        const data = await fsPromises.readFile(filePath, 'utf-8');
        existing = JSON.parse(data);
      } catch { /* ignore */ }
      existing.push({ role: 'agent', content: result.content });
      await fsPromises.writeFile(filePath, JSON.stringify(existing), 'utf-8');
    } catch { /* ignore */ }
  }

  if (ws.readyState === WebSocket.OPEN) {
    if (result.content) {
      sendJSON(ws, { type: 'response', content: result.content });
    }
    if (result.loopState.totalToolCalls > 0) {
      sendJSON(ws, { type: 'info', message: `共调用 ${result.loopState.totalToolCalls} 次工具` });
    }
    sendJSON(ws, {
      type: 'tokenUsage',
      inputTokens: result.loopState.lastInputTokens,
      outputTokens: result.loopState.lastOutputTokens,
      totalInputTokens: result.loopState.totalInputTokens,
      totalOutputTokens: result.loopState.totalOutputTokens,
    });
  }
}

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
