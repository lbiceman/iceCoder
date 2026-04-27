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
import { Harness } from '../harness/harness.js';
import type { HarnessConfig } from '../harness/types.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { loadMemoryPrompt } from '../memory/file-memory/index.js';
import { createFileMemoryManager } from '../memory/file-memory/file-memory-manager.js';
import type { UnifiedMessage } from '../llm/types.js';
import { resolveFileReferences } from './routes/upload.js';

const SYSTEM_PROMPT_PATH = path.resolve(process.env.ICE_SYSTEM_PROMPT_PATH ?? 'data/system-prompt.md');
const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR ?? 'data/sessions');
const MEMORY_DIR = path.resolve(process.env.ICE_MEMORY_DIR ?? 'data/memory-files');
const SESSION_FILE = path.join(SESSIONS_DIR, 'default.json');

/**
 * 单会话消息缓存。
 * 跨轮次累积，包含完整的结构化对话历史（含 toolCalls/toolCallId）。
 * 服务重启后丢失，harness 从零构建，记忆系统提供上下文连续性。
 */
let cachedMessages: UnifiedMessage[] | undefined;

/**
 * 全局记忆系统实例（进程级单例）。
 * 记忆系统在进程启动时初始化一次，所有会话共享。
 */
let globalFileMemoryManager: ReturnType<typeof createFileMemoryManager> | null = null;
let memoryInitialized = false;

async function ensureMemoryInitialized(): Promise<void> {
  if (memoryInitialized) return;

  try {
    // 初始化文件记忆管理器
    globalFileMemoryManager = createFileMemoryManager({
      memory: { memoryDir: 'data/memory-files' },
      enableAutoExtraction: true,
      enableAsyncPrefetch: true,
    });
    await globalFileMemoryManager.initialize();
    console.log('[memory] FileMemoryManager 初始化成功');
  } catch (err) {
    console.error('[memory] FileMemoryManager 初始化失败:', err);
    globalFileMemoryManager = null;
  }

  memoryInitialized = true;
}

async function loadSystemPrompt(): Promise<string> {
  try {
    return await fsPromises.readFile(SYSTEM_PROMPT_PATH, 'utf-8');
  } catch {
    return '你是 iceCoder，一个拥有工具能力的智能编程助手。根据用户需求自主决定使用哪些工具。回答使用中文。';
  }
}

export interface ChatWSOptions {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
}

/** 追加消息到会话文件（后端是唯一写入者） */
async function appendMessages(msgs: { role: string; content: string }[]): Promise<void> {
  if (msgs.length === 0) return;
  try {
    await fsPromises.mkdir(SESSIONS_DIR, { recursive: true });
    let existing: { role: string; content: string }[] = [];
    try {
      const data = await fsPromises.readFile(SESSION_FILE, 'utf-8');
      existing = JSON.parse(data);
    } catch { /* file doesn't exist yet */ }
    existing.push(...msgs);
    await fsPromises.writeFile(SESSION_FILE, JSON.stringify(existing), 'utf-8');
  } catch (err) {
    console.error('[chat-ws] appendMessages failed:', err);
  }
}

/** 清空会话文件（~clear 时调用） */
async function clearSessionFile(): Promise<void> {
  try {
    await fsPromises.mkdir(SESSIONS_DIR, { recursive: true });
    await fsPromises.writeFile(SESSION_FILE, '[]', 'utf-8');
  } catch { /* ignore */ }
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

        if (msg.type === 'clear_session') {
          // 前端 ~clear 命令：清除后端消息缓存和会话文件
          cachedMessages = undefined;
          clearSessionFile().catch(() => {});
          console.log('[chat-ws] 清除会话缓存和文件');
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
            await handleChatMessage(ws, msg.content, orchestrator, toolRegistry, toolExecutor);
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
      // 静默处理，不刷屏
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
): Promise<void> {
  const llmAdapter = orchestrator.getLLMAdapter();
  const toolDefs = toolRegistry.getDefinitions();
  const systemPrompt = await loadSystemPrompt();

  // 解析消息中的文件引用 [file:xxx]，替换为实际文件路径
  const { text: resolvedMessage, filePaths } = resolveFileReferences(message);
  const finalMessage = filePaths.length > 0
    ? `${resolvedMessage}\n\n请使用 parse_document 或 read_file 工具读取上述文件路径来分析文件内容。`
    : resolvedMessage;

  // 确保记忆系统已初始化
  await ensureMemoryInitialized();

  const existingMessages = cachedMessages;

  // 写入用户消息到会话文件
  await appendMessages([{ role: 'user', content: message }]);

  // ── 获取或初始化会话级消息缓存 ──
  // 如果缓存中有该会话的消息历史，直接复用（包含完整的 toolCalls/toolCallId 结构）
  // 如果没有（新会话或服务重启），传 undefined 让 Harness 从零构建

  const harnessConfig: HarnessConfig = {
    context: {
      systemPrompt,
      tools: toolDefs,
      memoryPrompt: await loadMemoryPrompt({ memoryDir: MEMORY_DIR }) ?? undefined,
    },
    loop: {
      maxRounds: 800,
      timeout: 60 * 60 * 1000,
      tokenBudget: 900000,
    },
    permissions: [
      { pattern: 'delete_file', permission: 'confirm', reason: '删除文件需要用户确认' },
    ],
    compactionThreshold: 40,
    compactionKeepRecent: 10,
    compactionEnableLLMSummary: true,
    memoryDir: MEMORY_DIR,
    fileMemoryManager: globalFileMemoryManager ?? undefined,
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

  // 注册默认停止钩子：检查模型是否过早停止
  harness.getStopHookManager().register(async (_messages, lastContent) => {
    // 如果模型回复中包含"我需要"、"接下来"等未完成信号，提示继续
    const incompleteSignals = ['我需要继续', '接下来我会', '下一步是', '还需要', '未完成'];
    const hasIncomplete = incompleteSignals.some(s => lastContent.includes(s));
    return {
      shouldContinue: hasIncomplete,
      message: hasIncomplete ? '你提到了还有未完成的工作，请继续执行。' : undefined,
      hookName: 'incomplete_task_check',
    };
  });
  const result = await harness.run(
    finalMessage,
    (msgs, opts) => llmAdapter.chat(msgs, opts),
    (event) => {
      // 推送 step 到 WebSocket（仅用于前端 token 用量更新，不写入聊天记录）
      sendJSON(ws, { type: 'step', step: event });

      // step 信息仅在服务端日志输出，不写入会话文件
      if (event.type === 'tool_call') {
        const argsPreview = event.toolArgs ? JSON.stringify(event.toolArgs) : '';
        const truncated = argsPreview.length > 100 ? argsPreview.substring(0, 100) + '…' : argsPreview;
        console.log(`[step] [call] ${event.toolName}(${truncated})`);
      } else if (event.type === 'tool_result') {
        const icon = event.toolSuccess ? '[ok]' : '[err]';
        const preview = event.toolOutput ? event.toolOutput.substring(0, 150) : (event.toolError || '');
        console.log(`[step] ${icon} ${event.toolName} → ${preview.substring(0, 150)}`);
      }
    },
    existingMessages,
  );

  // 缓存完整的结构化消息历史
  cachedMessages = result.messages;

  // 写入 AI 回复到会话文件
  if (result.content) {
    await appendMessages([{ role: 'agent', content: result.content }]).catch(() => {});
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
    inputTokens: result.loopState.lastInputTokens,
    outputTokens: result.loopState.lastOutputTokens,
    totalInputTokens: result.loopState.totalInputTokens,
    totalOutputTokens: result.loopState.totalOutputTokens,
  });
}

function sendJSON(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * 清理聊天系统资源（优雅关闭时调用）。
 */
export function cleanupChatResources(): void {
  cachedMessages = undefined;
  console.log('[chat-ws] Resources cleaned up');
}
