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
import { formatFriendlyError } from '../cli/friendly-errors.js';
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
 * 同时持久化到磁盘，服务重启后自动恢复。
 */
let cachedMessages: UnifiedMessage[] | undefined;

/** 结构化消息持久化文件路径 */
const STRUCTURED_SESSION_FILE = path.join(SESSIONS_DIR, 'default.structured.json');

/**
 * 当前活跃的 AbortController（用于用户中断正在执行的任务）。
 * 每次 handleChatMessage 开始时创建，结束时清空。
 */
let activeAbortController: AbortController | null = null;

/** 保存结构化消息到磁盘（防抖，避免频繁写入） */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveStructuredMessages(messages: UnifiedMessage[]): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fsPromises.mkdir(SESSIONS_DIR, { recursive: true });
      await fsPromises.writeFile(STRUCTURED_SESSION_FILE, JSON.stringify(messages), 'utf-8');
    } catch (err) {
      console.error('[chat-ws] 保存结构化消息失败:', err);
    }
  }, 1000);
}

/** 从磁盘加载结构化消息（启动时调用一次） */
async function loadStructuredMessages(): Promise<UnifiedMessage[] | undefined> {
  try {
    const data = await fsPromises.readFile(STRUCTURED_SESSION_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed) && parsed.length > 0) {
      console.log(`[chat-ws] 恢复 ${parsed.length} 条结构化消息`);
      return parsed;
    }
  } catch { /* 文件不存在或解析失败，正常情况 */ }
  return undefined;
}

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

  // 恢复结构化消息（服务重启后恢复对话上下文）
  if (!cachedMessages) {
    cachedMessages = await loadStructuredMessages();
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
    // 同时清除结构化消息文件
    await fsPromises.writeFile(STRUCTURED_SESSION_FILE, '[]', 'utf-8').catch(() => {});
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
          // 中断正在执行的任务
          if (activeAbortController) {
            activeAbortController.abort();
            console.log('[chat-ws] 用户请求中断任务');
          }
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
            sendJSON(ws, { type: 'error', message: formatFriendlyError(err) });
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
  const { text: resolvedMessage, filePaths, imageUrls } = resolveFileReferences(message);

  // 构建用户消息（可能包含图片的多模态消息）
  let userMessageContent: string | import('../llm/types.js').ContentBlock[];
  if (imageUrls.length > 0) {
    // 多模态消息：文本 + 图片
    const blocks: import('../llm/types.js').ContentBlock[] = [];
    const textPart = filePaths.length > 0
      ? `${resolvedMessage}\n\n请使用 parse_document 或 read_file 工具读取上述文件路径来分析文件内容。`
      : resolvedMessage;
    blocks.push({ type: 'text', text: textPart });

    for (const imgPath of imageUrls) {
      try {
        const imgData = await fsPromises.readFile(imgPath);
        const ext = path.extname(imgPath).toLowerCase().replace('.', '');
        const mimeType = ext === 'jpg' ? 'jpeg' : ext;
        const dataUrl = `data:image/${mimeType};base64,${imgData.toString('base64')}`;
        blocks.push({ type: 'image', imageUrl: dataUrl });
      } catch (err) {
        console.error('[chat-ws] 读取图片失败:', err);
      }
    }
    userMessageContent = blocks;
  } else {
    userMessageContent = filePaths.length > 0
      ? `${resolvedMessage}\n\n请使用 parse_document 或 read_file 工具读取上述文件路径来分析文件内容。`
      : resolvedMessage;
  }
  const finalMessage = typeof userMessageContent === 'string' ? userMessageContent : resolvedMessage;

  // 确保记忆系统已初始化
  await ensureMemoryInitialized();

  const existingMessages = cachedMessages;

  // 写入用户消息到会话文件
  await appendMessages([{ role: 'user', content: message }]);

  // 创建 AbortController 用于用户中断
  const abortController = new AbortController();
  activeAbortController = abortController;

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
      signal: abortController.signal,
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
      // 推送 step 到 WebSocket
      sendJSON(ws, { type: 'step', step: event });

      // 流式增量文本直接推送
      if (event.type === 'stream_delta' && event.delta) {
        sendJSON(ws, { type: 'stream', delta: event.delta });
      }

      // 工具实时输出推送
      if (event.type === 'tool_output' && event.content) {
        sendJSON(ws, { type: 'tool_output', toolName: event.toolName, content: event.content });
      }

      // step 信息仅在服务端日志输出
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
    // 流式调用函数
    (msgs, callback, opts) => llmAdapter.stream(msgs, callback, opts),
    // 多模态内容块（图片等）
    Array.isArray(userMessageContent) ? userMessageContent : undefined,
  );

  // 清空 abort controller
  activeAbortController = null;

  // 缓存完整的结构化消息历史并持久化到磁盘
  cachedMessages = result.messages;
  saveStructuredMessages(result.messages);

  // 写入 AI 回复到会话文件
  if (result.content) {
    await appendMessages([{ role: 'agent', content: result.content }]).catch(() => {});
  }

  // 推送最终结果到 WebSocket（stream_end 通知前端流式结束）
  sendJSON(ws, { type: 'stream_end' });

  if (result.content) {
    sendJSON(ws, { type: 'response', content: result.content });
  }
  if (result.loopState.stopReason === 'user_abort') {
    sendJSON(ws, { type: 'info', message: '任务已被用户中断' });
  } else if (result.loopState.totalToolCalls > 0) {
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
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  cachedMessages = undefined;
  console.log('[chat-ws] Resources cleaned up');
}
