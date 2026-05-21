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
import { randomUUID } from 'node:crypto';
import { loadAssembledChatPrompt, shouldDisableRuntimeTools } from '../prompts/load-chat-prompt.js';
import type { AssembledPrompt } from '../prompts/types.js';
import { harnessOverlayToContextFields } from '../prompts/prompt-assembler.js';
import {
  getHarnessMaxRoundsFromEnv,
  getHarnessTimeoutMsFromEnv,
  getHarnessTokenBudget,
} from '../harness/token-budget-config.js';
import { loadHarnessSupervisorRuntime } from '../harness/supervisor/supervisor-config.js';
import { registerSupervisorRuntimeReset } from '../harness/supervisor/supervisor-runtime-cache.js';
import type { ResolvedSupervisorConfig } from '../types/supervisor.js';
import { resolveDefaultChatModelMeta } from './routes/config.js';
import {
  detectFileBrowserOpen,
  looksLikeFileAnalysisIntent,
  tryDirectFileBrowserTurn,
} from './file-browser-direct.js';
// isExecutionPlanEnabled removed (Phase 11)

const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR ?? 'data/sessions');
const MEMORY_DIR = path.resolve(process.env.ICE_MEMORY_DIR ?? 'data/memory-files');
const DATA_DIR = path.resolve(process.env.ICE_DATA_DIR ?? 'data');
const MAIN_CONFIG_PATH = process.env.ICE_CONFIG_PATH
  ? path.resolve(process.env.ICE_CONFIG_PATH)
  : path.join(DATA_DIR, 'config.json');
const SESSION_FILE = path.join(SESSIONS_DIR, 'default.json');

/** F2 — supervisor runtime 进程级缓存：避免每个 WS 连接重复读盘。 */
let supervisorRuntimePromise: ReturnType<typeof loadHarnessSupervisorRuntime> | null = null;

registerSupervisorRuntimeReset(() => {
  supervisorRuntimePromise = null;
});

function getSupervisorRuntime(): ReturnType<typeof loadHarnessSupervisorRuntime> {
  if (!supervisorRuntimePromise) {
    supervisorRuntimePromise = loadHarnessSupervisorRuntime({
      dataDir: DATA_DIR,
      mainConfigPath: MAIN_CONFIG_PATH,
    });
  }
  return supervisorRuntimePromise;
}

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

/** ~open 后启用目录列举快捷导航（进程级，仅随 clear_session / 进程退出重置；无单独「退出」命令） */
let fileBrowserModeActive = false;
/** 最近一次 browse_directory 成功的目录（Windows，以 \\ 结尾） */
let fileBrowserLastBrowsedPath: string | null = null;

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
      memory: { memoryDir: MEMORY_DIR },
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

async function loadAssembledPrompt(): Promise<AssembledPrompt> {
  return loadAssembledChatPrompt({ logPrefix: '[chat-ws]' });
}

export interface ChatWSOptions {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
}

/** 当前所有聊天 WebSocket 客户端（PC + 移动端），用于会话持久化后通知其它端拉取 default.json */
const chatClients = new Set<WebSocket>();

/** MCP 后台初始化完成后的最新状态（晚到的 WS 连接可从 connected 包中补齐） */
let mcpReadySnapshot: {
  ok: boolean;
  toolCount: number;
  readyServers: number;
  errorMessage?: string;
} | null = null;

/** Quick Tunnel 公网 URL 就绪后快照（晚到的 WS 可从 connected 补齐） */
let tunnelReadySnapshot: { url: string } | null = null;

function sendToAllChatClients(jsonBody: string): void {
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

function broadcastSessionUpdated(reason: string, except?: WebSocket): void {
  const payload = JSON.stringify({ type: 'session_updated', reason });
  for (const client of chatClients) {
    if (client === except) continue;
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
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

/** 追加消息到会话文件（后端是唯一写入者）；失败返回 false */
async function appendMessages(msgs: { role: string; content?: string; id?: string; parentId?: string; toolName?: string; detail?: string; status?: string }[]): Promise<boolean> {
  if (msgs.length === 0) return true;
  try {
    await fsPromises.mkdir(SESSIONS_DIR, { recursive: true });
    let existing: any[] = [];
    try {
      const data = await fsPromises.readFile(SESSION_FILE, 'utf-8');
      existing = JSON.parse(data);
    } catch { /* file doesn't exist yet */ }
    existing.push(...msgs);
    await fsPromises.writeFile(SESSION_FILE, JSON.stringify(existing), 'utf-8');
    return true;
  } catch (err) {
    console.error('[chat-ws] appendMessages failed:', err);
    return false;
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

/** 目录列举确定性回合结束：更新结构化缓存、持久化、推送 WS（无 LLM） */
async function finalizeDirectBrowserTurn(
  ws: WebSocket,
  opts: {
    userStructuredContent: string;
    assistantContent: string;
    toolTraceBatch: { toolName: string; detail: string; status: string }[];
    syntheticTool?: { toolName: string; toolDetail: string; success: boolean };
  },
): Promise<void> {
  const base = cachedMessages ? [...cachedMessages] : [];
  base.push({ role: 'user', content: opts.userStructuredContent });
  base.push({ role: 'assistant', content: opts.assistantContent });
  cachedMessages = base;
  saveStructuredMessages(base);

  const agentMsgId = randomUUID();
  const entries: Parameters<typeof appendMessages>[0] = [];
  for (const t of opts.toolTraceBatch) {
    entries.push({
      role: 'tool_trace',
      parentId: agentMsgId,
      toolName: t.toolName,
      detail: t.detail,
      status: t.status,
    });
  }
  entries.push({ role: 'agent', content: opts.assistantContent, id: agentMsgId });
  await appendMessages(entries);
  broadcastSessionUpdated('turn_complete', ws);

  if (opts.syntheticTool) {
    sendJSON(ws, {
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: opts.syntheticTool.toolName,
        toolArgs: opts.syntheticTool.toolDetail ? { path: opts.syntheticTool.toolDetail } : {},
      },
    });
    sendJSON(ws, {
      type: 'step',
      step: {
        type: 'tool_result',
        toolName: opts.syntheticTool.toolName,
        toolSuccess: opts.syntheticTool.success,
        toolOutput: opts.assistantContent.substring(0, 800),
      },
    });
  }

  sendJSON(ws, { type: 'stream_end' });
  sendJSON(ws, { type: 'response', content: opts.assistantContent });
  sendJSON(ws, {
    type: 'tokenUsage',
    inputTokens: 0,
    outputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  });
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
  wss.on('connection', async (ws: WebSocket) => {
    chatClients.add(ws);
    ws.once('close', () => {
      chatClients.delete(ws);
    });

    const features = { executionPlan: true };
    try {
      const meta = await resolveDefaultChatModelMeta();
      sendJSON(ws, {
        type: 'connected',
        message: '连接成功',
        features,
        ...(meta ? { modelContext: meta } : {}),
        ...(mcpReadySnapshot ? { mcpReady: mcpReadySnapshot } : {}),
        ...(tunnelReadySnapshot ? { tunnelReady: tunnelReadySnapshot } : {}),
      });
    } catch {
      sendJSON(ws, {
        type: 'connected',
        message: '连接成功',
        features,
        ...(mcpReadySnapshot ? { mcpReady: mcpReadySnapshot } : {}),
        ...(tunnelReadySnapshot ? { tunnelReady: tunnelReadySnapshot } : {}),
      });
    }

    let isProcessing = false;
    /** 处理期间用户发来的消息队列（处理完后自动发送） */
    const pendingMessages: Array<{ content: string; images: string[] }> = [];

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
          fileBrowserModeActive = false;
          fileBrowserLastBrowsedPath = null;
          // 取消防抖写入，防止旧的 cachedMessages 覆盖清空操作
          if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
          await clearSessionFile();
          broadcastSessionUpdated('cleared', ws);
          console.log('[chat-ws] 清除会话缓存和文件');
          return;
        }

        if (msg.type === 'message' && (msg.content || (msg.images && msg.images.length > 0))) {
          if (isProcessing) {
            // 缓存消息到队列，处理完后自动发送
            pendingMessages.push({ content: msg.content || '', images: Array.isArray(msg.images) ? msg.images : [] });
            sendJSON(ws, { type: 'info', message: '已排队，当前任务完成后自动处理' });
            return;
          }

          isProcessing = true;
          sendJSON(ws, { type: 'status', status: 'processing' });

          try {
            const inlineImages: string[] = Array.isArray(msg.images) ? msg.images : [];
            await handleChatMessage(ws, msg.content || '', orchestrator, toolRegistry, toolExecutor, inlineImages);
          } catch (err) {
            sendJSON(ws, { type: 'error', message: formatFriendlyError(err) });
          }

          // 处理队列中的待发消息
          while (pendingMessages.length > 0) {
            const pending = pendingMessages.shift()!;
            sendJSON(ws, { type: 'status', status: 'processing' });
            try {
              await handleChatMessage(ws, pending.content, orchestrator, toolRegistry, toolExecutor, pending.images);
            } catch (err) {
              sendJSON(ws, { type: 'error', message: formatFriendlyError(err) });
            }
          }

          isProcessing = false;
          sendJSON(ws, { type: 'status', status: 'idle' });
        }
      } catch {
        sendJSON(ws, { type: 'error', message: '消息格式错误' });
      }
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
  inlineImages: string[] = [],
): Promise<void> {
  const llmAdapter = orchestrator.getLLMAdapter();
  const toolDefs = toolRegistry.getDefinitions();
  const assembled = await loadAssembledPrompt();
  const harnessDynamic = harnessOverlayToContextFields(assembled);

  // 解析消息中的文件引用 [file:xxx]，替换为实际文件路径
  const { text: resolvedMessage, filePaths, imageUrls } = resolveFileReferences(message);

  // 构建用户消息（可能包含图片的多模态消息）
  let userMessageContent: string | import('../llm/types.js').ContentBlock[];

  // 合并所有图片来源：文件上传的图片 + 前端直接发送的 base64 图片
  const allImageDataUrls: string[] = [...inlineImages]; // 前端粘贴/拖拽的 base64 图片

  // 处理文件上传中的图片（读取文件转 base64）
  for (const imgPath of imageUrls) {
    try {
      const imgData = await fsPromises.readFile(imgPath);
      const ext = path.extname(imgPath).toLowerCase().replace('.', '');
      const mimeType = ext === 'jpg' ? 'jpeg' : ext;
      const dataUrl = `data:image/${mimeType};base64,${imgData.toString('base64')}`;
      allImageDataUrls.push(dataUrl);
    } catch (err) {
      console.error('[chat-ws] 读取图片失败:', err);
    }
  }

  if (allImageDataUrls.length > 0) {
    // 多模态消息：文本 + 图片
    const blocks: import('../llm/types.js').ContentBlock[] = [];
    const textPart = filePaths.length > 0
      ? `${resolvedMessage}\n\n请使用 parse_document 或 read_file 工具读取上述文件路径来分析文件内容。`
      : resolvedMessage || '请分析这些图片';
    blocks.push({ type: 'text', text: textPart });

    for (const dataUrl of allImageDataUrls) {
      blocks.push({ type: 'image', imageUrl: dataUrl });
    }
    userMessageContent = blocks;
  } else {
    userMessageContent = filePaths.length > 0
      ? `${resolvedMessage}\n\n请使用 parse_document 或 read_file 工具读取上述文件路径来分析文件内容。`
      : resolvedMessage;
  }
  let harnessUserMessage =
    typeof userMessageContent === 'string' ? userMessageContent : resolvedMessage;

  const opensBrowser = detectFileBrowserOpen(message);
  if (opensBrowser) {
    fileBrowserModeActive = true;
    fileBrowserLastBrowsedPath = null;
  }

  // 确保记忆系统已初始化
  await ensureMemoryInitialized();

  const existingMessages = cachedMessages;

  // 写入用户消息到会话文件
  const userMsgId = randomUUID();
  const userPersisted = await appendMessages([{ role: 'user', content: message, id: userMsgId }]);
  if (userPersisted) broadcastSessionUpdated('user_message', ws);

  const resolvedForDirect =
    typeof userMessageContent === 'string' ? userMessageContent : resolvedMessage;

  // ── 目录列举：服务端直接执行 list_drives / browse_directory，避免模型假列表 ──
  const direct = await tryDirectFileBrowserTurn({
    toolExecutor,
    resolvedText: resolvedForDirect,
    opensBrowser,
    lastBrowsedPath: fileBrowserLastBrowsedPath,
    platform: process.platform,
    hasImages: inlineImages.length > 0 || Array.isArray(userMessageContent),
    active: fileBrowserModeActive,
  });

  if (direct.handled && direct.variant === 'deterministic') {
    fileBrowserLastBrowsedPath = direct.newLastBrowsedPath;
    console.log(`[chat-ws] file-browser-direct ${direct.toolName} ok=${direct.success}`);
    await finalizeDirectBrowserTurn(ws, {
      userStructuredContent: harnessUserMessage,
      assistantContent: direct.assistantMarkdown,
      toolTraceBatch: [
        {
          toolName: direct.toolName,
          detail: direct.toolDetail,
          status: direct.success ? 'success' : 'error',
        },
      ],
      syntheticTool: {
        toolName: direct.toolName,
        toolDetail: direct.toolDetail,
        success: direct.success,
      },
    });
    return;
  }

  if (direct.handled && direct.variant === 'harness_augment') {
    fileBrowserLastBrowsedPath = direct.newLastBrowsedPath;
    harnessUserMessage = direct.augmentedUserText;
    console.log('[chat-ws] file-browser-direct harness_augment (browse_directory output injected)');
  }

  if (
    fileBrowserLastBrowsedPath
    && typeof harnessUserMessage === 'string'
    && looksLikeFileAnalysisIntent(message)
  ) {
    harnessUserMessage += `\n\n（服务端提示：最近一次列出的文件夹为 \`${fileBrowserLastBrowsedPath}\`。用户若只给出文件名，请与该路径拼接为完整绝对路径后调用 parse_document / parse_pptx_deep / open_file。）`;
  }

  // 创建 AbortController 用于用户中断
  const abortController = new AbortController();
  activeAbortController = abortController;
  // 将中断信号传递给 LLMAdapter，支持重试等待期间中断
  llmAdapter.setAbortSignal?.(abortController.signal);

  const supervisorRuntime = await getSupervisorRuntime();

  const harnessConfig: HarnessConfig = {
    context: {
      systemPrompt: assembled.systemPrompt,
      tools: shouldDisableRuntimeTools() ? [] : toolDefs,
      memoryPrompt: await loadMemoryPrompt({ memoryDir: MEMORY_DIR }) ?? undefined,
      ...harnessDynamic,
    },
    loop: {
      maxRounds: getHarnessMaxRoundsFromEnv(),
      timeout: getHarnessTimeoutMsFromEnv(),
      tokenBudget: getHarnessTokenBudget(),
      signal: abortController.signal,
    },
    permissions: [
      { pattern: 'fs_operation', permission: 'confirm', reason: 'File system operations require confirmation' },
    ],
    compactionThreshold: 40,
    compactionKeepRecent: 10,
    compactionEnableLLMSummary: true,
    memoryDir: MEMORY_DIR,
    fileMemoryManager: globalFileMemoryManager ?? undefined,
    sessionDir: SESSIONS_DIR,
    supervisorConfig: supervisorRuntime.supervisorConfig,
    globalPolicy: supervisorRuntime.globalPolicy,
    supervisorBridge: supervisorRuntime.bridge,
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
          sendJSON(ws, { type: 'confirm_timeout', toolName });
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

  // 收集本轮工具调用记录（用于持久化到会话文件，不发送给 LLM）
  const toolTraceBatch: { toolName: string; detail: string; status: string }[] = [];

  const pulseTimer = setInterval(() => {
    sendJSON(ws, { type: 'pulse', ts: Date.now() });
  }, 10_000);

  try {
    const result = await harness.run(
      harnessUserMessage,
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

        // 收集工具调用记录
        if (event.type === 'tool_call' && event.toolName) {
          const argsPreview = event.toolArgs ? JSON.stringify(event.toolArgs) : '';
          const detail = event.toolArgs?.path || event.toolArgs?.file || event.toolArgs?.command || event.toolArgs?.query
            || (argsPreview.length > 80 ? argsPreview.substring(0, 80) + '…' : argsPreview);
          toolTraceBatch.push({ toolName: event.toolName, detail: detail || '', status: 'pending' });
          const truncated = argsPreview.length > 100 ? argsPreview.substring(0, 100) + '…' : argsPreview;
          console.log(`[step] [call] ${event.toolName}(${truncated})`);
        } else if (event.type === 'tool_result' && event.toolName) {
          // 更新批次中最后一个匹配的工具状态
          for (let i = toolTraceBatch.length - 1; i >= 0; i--) {
            if (toolTraceBatch[i].toolName === event.toolName && toolTraceBatch[i].status === 'pending') {
              toolTraceBatch[i].status = event.toolSuccess ? 'success' : 'error';
              break;
            }
          }
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

    // 清空 abort controller 和中断信号
    activeAbortController = null;
    llmAdapter.setAbortSignal?.(null);

    // 缓存完整的结构化消息历史并持久化到磁盘
    cachedMessages = result.messages;
    saveStructuredMessages(result.messages);

    // 写入 AI 回复 + 工具调用记录到会话文件
    const agentMsgId = randomUUID();
    const sessionEntries: any[] = [];

    // 工具调用记录（role: 'tool_trace'，通过 parentId 关联到 agent 消息）
    for (const trace of toolTraceBatch) {
      sessionEntries.push({
        role: 'tool_trace',
        parentId: agentMsgId,
        toolName: trace.toolName,
        detail: trace.detail,
        status: trace.status,
      });
    }

    // agent 消息（无文字但有工具时仍写入占位，避免孤儿 tool_trace）
    if (result.content) {
      sessionEntries.push({ role: 'agent', content: result.content, id: agentMsgId });
    } else if (toolTraceBatch.length > 0) {
      sessionEntries.push({
        role: 'agent',
        content: '（本轮仅有工具调用，无文字回复）',
        id: agentMsgId,
      });
    }

    if (sessionEntries.length > 0) {
      const persisted = await appendMessages(sessionEntries);
      if (persisted) broadcastSessionUpdated('turn_complete', ws);
    }

    // 推送最终结果到 WebSocket（stream_end 通知前端流式结束）
    sendJSON(ws, { type: 'stream_end' });

    // v4 被动确认：附加记忆提取通知
    const extractionNotices = harness.flushExtractionNotices();
    if (extractionNotices.length > 0) {
      sendJSON(ws, { type: 'memory_notice', notices: extractionNotices });
    }

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
  } finally {
    clearInterval(pulseTimer);
    activeAbortController = null;
    llmAdapter.setAbortSignal?.(null);
  }
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
  fileBrowserModeActive = false;
  fileBrowserLastBrowsedPath = null;
  chatClients.clear();
  mcpReadySnapshot = null;
  tunnelReadySnapshot = null;
  console.log('[chat-ws] Resources cleaned up');
}
