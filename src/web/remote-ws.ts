/**
 * 远程控制 WebSocket 处理器。
 * 手机端通过 WebSocket 发送指令，服务端复用 Harness 执行并回传结果。
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { URL } from 'url';
import { promises as fsPromises } from 'node:fs';
import path from 'path';
import { getSession, markSessionConnected, removeSession } from './routes/remote.js';
import { Harness } from '../harness/harness.js';
import type { HarnessConfig } from '../harness/types.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

const SYSTEM_PROMPT_PATH = path.resolve('data/system-prompt.md');

async function loadSystemPrompt(): Promise<string> {
  try {
    return await fsPromises.readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch {
    return '你是一个智能助手，拥有工具能力。根据用户需求自主决定使用哪些工具。回答使用中文。';
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
        socket.destroy();
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

  const result = await harness.run(
    message,
    (msgs, opts) => llmAdapter.chat(msgs, opts),
    (event) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      sendJSON(ws, { type: 'step', step: event });
    },
  );

  if (ws.readyState === WebSocket.OPEN) {
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
}

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
