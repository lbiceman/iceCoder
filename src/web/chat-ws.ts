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
import { loadMemoryPrompt } from '../memory/file-memory/index.js';
import { createFileMemoryManager } from '../memory/file-memory/file-memory-manager.js';
import { MemoryManager } from '../memory/memory-manager.js';
import type { UnifiedMessage } from '../llm/types.js';

const SYSTEM_PROMPT_PATH = path.resolve(process.env.ICE_SYSTEM_PROMPT_PATH ?? 'data/system-prompt.md');
const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR ?? 'data/sessions');
const MEMORY_DIR = path.resolve(process.env.ICE_MEMORY_DIR ?? 'data/memory-files');

/**
 * 会话级消息缓存。
 * 参考 claude-code 的 state.messages：跨轮次累积，包含完整的结构化对话历史。
 * 带 TTL 清理：超过 24 小时未访问的会话自动清除。
 */
const sessionMessages = new Map<string, { messages: UnifiedMessage[]; lastAccess: number }>();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小时
const SESSION_CLEANUP_INTERVAL = 30 * 60 * 1000; // 每 30 分钟清理一次

// 定期清理过期会话缓存
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessionMessages) {
    if (now - entry.lastAccess > SESSION_TTL) {
      sessionMessages.delete(id);
      console.log(`[session] 清理过期会话缓存: ${id}`);
    }
  }
}, SESSION_CLEANUP_INTERVAL);

/**
 * 全局记忆系统实例（进程级单例）。
 * 参考 claude-code：记忆系统在进程启动时初始化一次，所有会话共享。
 */
let globalFileMemoryManager: ReturnType<typeof createFileMemoryManager> | null = null;
let globalMemoryManager: MemoryManager | null = null;
let memoryInitialized = false;
let memoryDecayTimer: ReturnType<typeof setInterval> | null = null;

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

  try {
    // 初始化结构化记忆管理器
    globalMemoryManager = new MemoryManager();
    console.log('[memory] MemoryManager 初始化成功');

    // 启动记忆衰减后台调度器（每 5 分钟执行一次）
    if (!memoryDecayTimer) {
      memoryDecayTimer = setInterval(async () => {
        if (!globalMemoryManager) return;
        try {
          const decayed = await globalMemoryManager.decay();
          if (decayed > 0) {
            console.log(`[memory] 后台衰减: ${decayed} 条记忆受影响`);
          }
        } catch {
          // 衰减失败不阻塞
        }
      }, 5 * 60 * 1000);
    }
  } catch (err) {
    console.error('[memory] MemoryManager 初始化失败:', err);
    globalMemoryManager = null;
  }

  memoryInitialized = true;
}

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

  // 确保记忆系统已初始化
  await ensureMemoryInitialized();

  // 确定目标会话 ID
  const targetSessionId = sessionId || await getActiveSession() || undefined;

  // 记录活跃会话
  if (targetSessionId) {
    setActiveSession(targetSessionId).catch(err => console.error('[chat-ws] setActiveSession failed:', err));
  }

  // 写入用户消息到会话文件（用于前端展示和持久化）
  if (targetSessionId) {
    await appendMessages(targetSessionId, [{ role: 'user', content: message }]);
  }

  // ── 参考 claude-code：获取或初始化会话级消息缓存 ──
  // 如果缓存中有该会话的消息历史，直接复用（包含完整的 toolCalls/toolCallId 结构）
  // 如果没有（新会话或服务重启），传 undefined 让 Harness 从零构建
  const cached = targetSessionId ? sessionMessages.get(targetSessionId) : undefined;
  const existingMessages = cached?.messages;

  const harnessConfig: HarnessConfig = {
    context: {
      systemPrompt,
      tools: toolDefs,
      memoryPrompt: await loadMemoryPrompt({ memoryDir: MEMORY_DIR }) ?? undefined,
    },
    loop: {
      maxRounds: 800,
      timeout: 60 * 60 * 1000,
      tokenBudget: 500000,
    },
    permissions: [
      { pattern: 'delete_file', permission: 'confirm', reason: '删除文件需要用户确认' },
    ],
    compactionThreshold: 40,
    compactionKeepRecent: 10,
    compactionEnableLLMSummary: true,
    memoryDir: MEMORY_DIR,
    fileMemoryManager: globalFileMemoryManager ?? undefined,
    memoryManager: globalMemoryManager ?? undefined,
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
    message,
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
    existingMessages, // 参考 claude-code：传入已有消息历史
  );

  // ── 参考 claude-code：缓存完整的结构化消息历史 ──
  // result.messages 包含 system prompt + 所有 user/assistant/tool 消息（含 toolCalls/toolCallId）
  if (targetSessionId) {
    sessionMessages.set(targetSessionId, { messages: result.messages, lastAccess: Date.now() });
  }

  // 写入最终 AI 回复（不写入中间 step）
  if (targetSessionId && result.content) {
    await appendMessages(targetSessionId, [{ role: 'agent', content: result.content }]).catch(err => console.error('[chat-ws] appendMessages failed:', err));
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
  if (memoryDecayTimer) {
    clearInterval(memoryDecayTimer);
    memoryDecayTimer = null;
  }
  if (sessionCleanupTimer) {
    clearInterval(sessionCleanupTimer);
    sessionCleanupTimer = null;
  }
  sessionMessages.clear();
  console.log('[chat-ws] Resources cleaned up');
}
