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
import { evaluateIncompleteTaskStopHook } from '../harness/incomplete-task-stop-hook.js';
import type { HarnessConfig } from '../harness/types.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { bootstrapActiveSessionIdFromIndex } from './routes/sessions.js';
import { resolveWorkspaceToolContext } from '../harness/workspace-run-context.js';
import { resolveEffectiveWorkspaceRoot } from '../harness/session-workspace-store.js';
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
import { readSkipPermissionChecksFromMainConfig } from '../config/main-config-supervisor-mode.js';
import {
  registerSupervisorRuntimeReset,
  resetSupervisorRuntimeCache,
} from '../harness/supervisor/supervisor-runtime-cache.js';
import {
  flushStructuredSessionToDisk,
  readStructuredMessagesFile,
  writeStructuredMessagesFile,
} from './session-structured-io.js';
import { applyFirstPromptSessionTitle } from './session-title.js';
import {
  getOrLoadAssembledChatPrompt,
  prewarmChatRuntime,
} from './chat-ws-prewarm.js';
import type { ResolvedSupervisorConfig } from '../types/supervisor.js';
import { resolveDefaultChatModelMeta } from './routes/config.js';
import {
  detectFileBrowserOpen,
  looksLikeFileAnalysisIntent,
  tryDirectFileBrowserTurn,
} from './file-browser-direct.js';
// isExecutionPlanEnabled removed (Phase 11)

const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR ?? 'data/sessions');
let activeSessionId = 'default';
let activeSessionBootstrapPromise: Promise<void> | null = null;

/** 冷启动：选中 index 中 updatedAt 最近的会话，并预载 structured 缓存。 */
async function ensureActiveSessionBootstrapped(): Promise<void> {
  if (activeSessionBootstrapPromise) return activeSessionBootstrapPromise;
  activeSessionBootstrapPromise = (async () => {
    try {
      const id = await bootstrapActiveSessionIdFromIndex();
      if (id) activeSessionId = id;
      if (!getCachedMessages(activeSessionId)) {
        const loaded = await loadStructuredMessages(activeSessionId);
        setCachedMessages(activeSessionId, loaded ?? []);
      }
      console.log(`[chat-ws] 活跃会话: ${activeSessionId}`);
    } catch (err) {
      console.warn('[chat-ws] 启动会话 bootstrap 失败:', err);
    }
  })();
  return activeSessionBootstrapPromise;
}
const MEMORY_DIR = path.resolve(process.env.ICE_MEMORY_DIR ?? 'data/memory-files');
const DATA_DIR = path.resolve(process.env.ICE_DATA_DIR ?? 'data');
const MAIN_CONFIG_PATH = process.env.ICE_CONFIG_PATH
  ? path.resolve(process.env.ICE_CONFIG_PATH)
  : path.join(DATA_DIR, 'config.json');
function getSessionFile(sessionId: string = activeSessionId): string {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}
function getStructuredSessionFile(sessionId: string = activeSessionId): string {
  return path.join(SESSIONS_DIR, `${sessionId}.structured.json`);
}

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
 * 单会话消息缓存（legacy，保留兼容）。
 * 跨轮次累积，包含完整的结构化对话历史（含 toolCalls/toolCallId）。
 * 同时持久化到磁盘，服务重启后自动恢复。
 */
let cachedMessages: UnifiedMessage[] | undefined;

/** 多会话结构化消息缓存 Map<sessionId, UnifiedMessage[]> */
const structuredCache = new Map<string, UnifiedMessage[]>();

/** 获取指定会话的结构化消息缓存 */
function getCachedMessages(sessionId: string = activeSessionId): UnifiedMessage[] | undefined {
  return structuredCache.get(sessionId) ?? (sessionId === activeSessionId ? cachedMessages : undefined);
}

/** 设置指定会话的结构化消息缓存 */
function setCachedMessages(sessionId: string, messages: UnifiedMessage[] | undefined): void {
  if (messages === undefined) {
    structuredCache.delete(sessionId);
  } else {
    structuredCache.set(sessionId, messages);
  }
  if (sessionId === activeSessionId) {
    cachedMessages = messages;
  }
}

/** 每个会话独立的 fileBrowser 状态 */
interface FileBrowserState {
  active: boolean;
  lastBrowsedPath: string | null;
}
const fileBrowserStateBySession = new Map<string, FileBrowserState>();

function getFileBrowserState(sessionId: string = activeSessionId): FileBrowserState {
  let state = fileBrowserStateBySession.get(sessionId);
  if (!state) {
    state = { active: false, lastBrowsedPath: null };
    fileBrowserStateBySession.set(sessionId, state);
  }
  return state;
}

/** 导出活跃会话 ID，供 remote-ws.ts 等模块使用 */
export function getActiveSessionId(): string {
  return activeSessionId;
}

/**
 * 清理被删除会话在进程内的所有缓存。
 * 由 sessions REST DELETE 通过 `registerSessionCleanupHook` 注入；
 * 若删的是 active session，调用方应先 `switch_session` 到其它会话。
 */
export function purgeSessionRuntimeCaches(sessionId: string): void {
  structuredCache.delete(sessionId);
  fileBrowserStateBySession.delete(sessionId);
  const pending = saveTimerMap.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    saveTimerMap.delete(sessionId);
  }
  if (sessionId === activeSessionId) {
    cachedMessages = undefined;
  }
}

/** 获取会话目录路径（供 remote-ws.ts 使用） */
export function getSessionsDir(): string {
  return SESSIONS_DIR;
}

/**
 * 当前活跃的 AbortController（用于用户中断正在执行的任务）。
 * 每次 handleChatMessage 开始时创建，结束时清空。
 */
let activeAbortController: AbortController | null = null;

// ─────────────────────────────────────────────────────────────
// 方案 B4 — 多端 confirm：first-win 协议
// confirm 广播给所有订阅者，任意端 reply 一次即生效，并向所有端广播 confirm_resolved 关闭对话框。
// ─────────────────────────────────────────────────────────────
interface PendingConfirm {
  sessionId: string;
  toolName: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingConfirms = new Map<string, PendingConfirm>();
let nextConfirmIdCounter = 1;
function nextConfirmId(): string {
  return `c-${Date.now().toString(36)}-${(nextConfirmIdCounter++).toString(36)}`;
}
function resolveConfirm(confirmId: string, approved: boolean, reason: 'reply' | 'timeout'): void {
  const entry = pendingConfirms.get(confirmId);
  if (!entry) return;
  pendingConfirms.delete(confirmId);
  clearTimeout(entry.timer);
  broadcastToSession(entry.sessionId, {
    type: 'confirm_resolved',
    confirmId,
    toolName: entry.toolName,
    approved,
    reason,
  });
  entry.resolve(approved);
}

/** 保存结构化消息到磁盘（防抖，避免频繁写入） */
const saveTimerMap = new Map<string, ReturnType<typeof setTimeout>>();

/** 立即将指定 session 的结构化缓存写入磁盘（switch_session 前须 await） */
async function flushStructuredMessagesNow(sessionId: string): Promise<void> {
  await flushStructuredSessionToDisk(
    SESSIONS_DIR,
    sessionId,
    getCachedMessages(sessionId),
    () => {
      const pending = saveTimerMap.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        saveTimerMap.delete(sessionId);
      }
    },
  );
}

function saveStructuredMessages(messages: UnifiedMessage[], sessionId?: string): void {
  const id = sessionId || activeSessionId;
  structuredCache.set(id, messages);
  const existing = saveTimerMap.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    try {
      await writeStructuredMessagesFile(SESSIONS_DIR, id, messages);
    } catch (err) {
      console.error('[chat-ws] 保存结构化消息失败:', err);
    }
  }, 1000);
  saveTimerMap.set(id, timer);
}

/** 从磁盘加载结构化消息（启动时调用一次） */
async function loadStructuredMessages(sessionId?: string): Promise<UnifiedMessage[] | undefined> {
  const id = sessionId || activeSessionId;
  const parsed = await readStructuredMessagesFile(SESSIONS_DIR, id);
  if (parsed && parsed.length > 0) {
    console.log(`[chat-ws] 恢复 ${parsed.length} 条结构化消息`);
    return parsed;
  }
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
  if (!getCachedMessages(activeSessionId)) {
    const loaded = await loadStructuredMessages(activeSessionId);
    setCachedMessages(activeSessionId, loaded);
  }

  memoryInitialized = true;
}

async function loadAssembledPrompt(): Promise<AssembledPrompt> {
  return getOrLoadAssembledChatPrompt('[chat-ws]');
}

function startChatRuntimePrewarm(): void {
  prewarmChatRuntime({
    ensureMemoryInitialized,
    getSupervisorRuntime,
    loadAssembledPrompt,
  });
}

export interface ChatWSOptions {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
}

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

function subscribeWsToSession(ws: WebSocket, sessionId: string): void {
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

function unsubscribeWsFromAll(ws: WebSocket): void {
  const sid = wsToSubscribedSession.get(ws);
  if (!sid) return;
  const set = sessionSubscribers.get(sid);
  if (set) {
    set.delete(ws);
    if (set.size === 0) sessionSubscribers.delete(sid);
  }
  wsToSubscribedSession.delete(ws);
}

/**
 * 向某 session 的所有订阅者广播一条 JSON。
 * 任务事件（step / stream 等）必须通过此函数下发，
 * 否则 F5 / 移动端扫码 / 切页面后新连上的 WS 将收不到当前任务进度。
 */
function broadcastToSession(sessionId: string, data: unknown): void {
  const set = sessionSubscribers.get(sessionId);
  if (!set || set.size === 0) return;
  const body = JSON.stringify(data);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(body);
      } catch {
        /* ignore */
      }
    }
  }
}

const DEFAULT_WORK_DIR = process.cwd();

async function resolveSessionWorkspacePayload(sessionId: string) {
  return resolveEffectiveWorkspaceRoot(SESSIONS_DIR, sessionId, DEFAULT_WORK_DIR);
}

// ─────────────────────────────────────────────────────────────
// 方案 B2 — 运行中回合快照（per session）
// 新 WS 连上时随 `connected` 包发回，供前端无缝还原 UI（流式文本 / 冰豆 / 工具时间线 / 执行计划等）。
// ─────────────────────────────────────────────────────────────
interface RunningTurnSnapshot {
  isProcessing: boolean;
  iteration: number;
  streamingText: string;
  toolTimeline: { toolName: string; detail: string; status: string }[];
  petState: string;
  petBubble: string;
  petStatusText: string;
  lastInputTokens: number;
  lastOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  startedAt: number;
  /** 重放的执行计划 / 任务图 / 执行模式相关 step 事件，前端按现有 bridge 喂回即可重建 UI */
  planEvents: Array<{ type: string; [k: string]: unknown }>;
}

const runningTurns = new Map<string, RunningTurnSnapshot>();

function createEmptyRunningTurn(): RunningTurnSnapshot {
  return {
    isProcessing: true,
    iteration: 0,
    streamingText: '',
    toolTimeline: [],
    petState: 'thinking',
    petBubble: '',
    petStatusText: '',
    lastInputTokens: 0,
    lastOutputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    startedAt: Date.now(),
    planEvents: [],
  };
}

function getRunningTurn(sessionId: string): RunningTurnSnapshot | undefined {
  return runningTurns.get(sessionId);
}

function ensureRunningTurn(sessionId: string): RunningTurnSnapshot {
  let t = runningTurns.get(sessionId);
  if (!t) {
    t = createEmptyRunningTurn();
    runningTurns.set(sessionId, t);
  }
  return t;
}

function toolArgsDetailPreview(toolArgs: Record<string, unknown> | undefined): string {
  if (!toolArgs || typeof toolArgs !== 'object') return '';
  const direct = toolArgs.path || toolArgs.file || toolArgs.command || toolArgs.query;
  if (typeof direct === 'string' && direct) return direct;
  try {
    const argsStr = JSON.stringify(toolArgs);
    return argsStr.length > 80 ? argsStr.substring(0, 80) + '…' : argsStr;
  } catch {
    return '';
  }
}

function snapshotRunningTurn(sessionId: string): RunningTurnSnapshot | null {
  const t = getRunningTurn(sessionId);
  if (!t) return null;
  return {
    ...t,
    toolTimeline: t.toolTimeline.map((row) => ({ ...row })),
    planEvents: t.planEvents.map((ev) => ({ ...ev })),
  };
}

function clearRunningTurn(sessionId: string): void {
  runningTurns.delete(sessionId);
}

/** 把一条 step 事件 fold 进运行中快照，便于新订阅者重建 UI */
function foldStepIntoRunningTurn(sessionId: string, event: any): void {
  const t = ensureRunningTurn(sessionId);
  if (!event || typeof event !== 'object') return;

  if (typeof event.iteration === 'number' && event.iteration > t.iteration) {
    t.iteration = event.iteration;
  }
  if (event.totalTokenUsage) {
    if (typeof event.totalTokenUsage.inputTokens === 'number') {
      t.lastInputTokens = event.totalTokenUsage.inputTokens;
    }
    if (typeof event.totalTokenUsage.outputTokens === 'number') {
      t.lastOutputTokens = event.totalTokenUsage.outputTokens;
    }
  }

  switch (event.type) {
    case 'stream_delta':
      if (typeof event.delta === 'string') {
        t.streamingText += event.delta;
        t.petState = 'read';
      }
      break;
    case 'thinking':
      t.petState = 'thinking';
      if (typeof event.content === 'string') t.petBubble = event.content;
      break;
    case 'tool_call':
      if (event.toolName) {
        t.toolTimeline.push({
          toolName: String(event.toolName),
          detail: toolArgsDetailPreview(event.toolArgs),
          status: 'pending',
        });
        t.petState = 'working';
      }
      break;
    case 'tool_result':
      if (event.toolName) {
        for (let i = t.toolTimeline.length - 1; i >= 0; i--) {
          const row = t.toolTimeline[i];
          if (row.toolName === event.toolName && row.status === 'pending') {
            row.status = event.toolOutcome === 'policy_block'
              ? 'warn'
              : (event.toolSuccess ? 'success' : 'error');
            break;
          }
        }
      }
      break;
    case 'tool_progress':
      if (typeof event.content === 'string') {
        t.petBubble = event.content;
        t.petStatusText = event.content;
      }
      t.petState = 'working';
      break;
    case 'execution_plan_init':
    case 'execution_plan_update':
    case 'execution_plan_clear':
    case 'task_graph_init':
    case 'task_graph_node':
    case 'task_graph_update':
    case 'task_graph_branch':
    case 'task_graph_done':
    case 'execution_mode_enter':
    case 'execution_mode_exit':
      t.planEvents.push({ ...event });
      if (t.planEvents.length > 200) {
        t.planEvents.splice(0, t.planEvents.length - 200);
      }
      break;
    case 'final':
      if (event.stopReason === 'user_checkpoint') {
        t.petState = 'crying';
        t.petBubble = '监管已暂停，需要你介入啦';
        t.petStatusText = '监管已暂停，需要你介入啦';
      }
      break;
    default:
      break;
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

function broadcastSessionUpdated(
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

/**
 * 追加消息到指定会话的消息文件。
 *
 * `sessionId` 必须由调用方传入（通常是 handleChatMessage 启动时锁定的 `runSessionId`），
 * 这样即使用户在长任务中途切换 session，旧任务的 cleanup 仍写入正确的旧 session 文件。
 */
async function appendMessages(
  msgs: { role: string; content?: string; id?: string; parentId?: string; toolName?: string; detail?: string; status?: string }[],
  sessionId: string = activeSessionId,
): Promise<boolean> {
  if (msgs.length === 0) return true;
  try {
    await fsPromises.mkdir(SESSIONS_DIR, { recursive: true });
    const file = getSessionFile(sessionId);
    let existing: any[] = [];
    try {
      const data = await fsPromises.readFile(file, 'utf-8');
      existing = JSON.parse(data);
    } catch { /* file doesn't exist yet */ }
    existing.push(...msgs);
    await fsPromises.writeFile(file, JSON.stringify(existing), 'utf-8');
    return true;
  } catch (err) {
    console.error('[chat-ws] appendMessages failed:', err);
    return false;
  }
}

/** 目录列举确定性回合结束：更新结构化缓存、持久化、推送 WS（无 LLM） */
async function finalizeDirectBrowserTurn(
  ws: WebSocket,
  opts: {
    userStructuredContent: string;
    assistantContent: string;
    toolTraceBatch: { toolName: string; detail: string; status: string }[];
    syntheticTool?: { toolName: string; toolDetail: string; success: boolean };
    sessionId: string;
  },
): Promise<void> {
  const sid = opts.sessionId;
  const cached = getCachedMessages(sid);
  const base = cached ? [...cached] : [];
  base.push({ role: 'user', content: opts.userStructuredContent });
  base.push({ role: 'assistant', content: opts.assistantContent });
  setCachedMessages(sid, base);
  saveStructuredMessages(base, sid);

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
  await appendMessages(entries, sid);
  broadcastSessionUpdated('turn_complete', undefined, ws);

  if (opts.syntheticTool) {
    broadcastToSession(sid, {
      type: 'step',
      step: {
        type: 'tool_call',
        toolName: opts.syntheticTool.toolName,
        toolArgs: opts.syntheticTool.toolDetail ? { path: opts.syntheticTool.toolDetail } : {},
      },
    });
    broadcastToSession(sid, {
      type: 'step',
      step: {
        type: 'tool_result',
        toolName: opts.syntheticTool.toolName,
        toolSuccess: opts.syntheticTool.success,
        toolOutput: opts.assistantContent.substring(0, 800),
      },
    });
  }

  broadcastToSession(sid, { type: 'stream_end' });
  broadcastToSession(sid, { type: 'response', content: opts.assistantContent });
  broadcastToSession(sid, {
    type: 'tokenUsage',
    inputTokens: 0,
    outputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  });
  // 确定性短路不进入 handleChatMessage 的 lifecycle，必须显式清理快照
  clearRunningTurn(sid);
}

/**
 * 将统一 WebSocket 服务器附加到 HTTP 服务器上。
 * 路径: /api/chat/ws 或 /api/chat/ws?token=xxx
 */
export function attachChatWebSocket(server: Server, options: ChatWSOptions): void {
  const { orchestrator, toolRegistry, toolExecutor } = options;

  void ensureActiveSessionBootstrapped();

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
    await ensureActiveSessionBootstrapped();
    chatClients.add(ws);
    subscribeWsToSession(ws, activeSessionId);
    startChatRuntimePrewarm();
    ws.once('close', () => {
      chatClients.delete(ws);
      unsubscribeWsFromAll(ws);
    });

    const features = { executionPlan: true };
    const runningTurn = snapshotRunningTurn(activeSessionId);
    try {
      const [meta, workspace] = await Promise.all([
        resolveDefaultChatModelMeta(),
        resolveSessionWorkspacePayload(activeSessionId),
      ]);
        sendJSON(ws, {
          type: 'connected',
          message: '连接成功',
          features,
          activeSessionId,
          ...(meta ? { modelContext: meta } : {}),
          ...workspace,
          ...(mcpReadySnapshot ? { mcpReady: mcpReadySnapshot } : {}),
          ...(tunnelReadySnapshot ? { tunnelReady: tunnelReadySnapshot } : {}),
          ...(runningTurn ? { runningTurn } : {}),
      });
    } catch {
      sendJSON(ws, {
        type: 'connected',
        message: '连接成功',
        features,
        activeSessionId,
        workspaceRoot: DEFAULT_WORK_DIR,
        defaultWorkDir: DEFAULT_WORK_DIR,
        ...(mcpReadySnapshot ? { mcpReady: mcpReadySnapshot } : {}),
        ...(tunnelReadySnapshot ? { tunnelReady: tunnelReadySnapshot } : {}),
        ...(runningTurn ? { runningTurn } : {}),
      });
    }
    if (runningTurn?.isProcessing) {
      sendJSON(ws, { type: 'status', status: 'processing' });
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

        // 方案 B4：confirm 多端 first-win
        if (msg.type === 'confirm_reply') {
          const cid = typeof msg.confirmId === 'string' ? msg.confirmId : '';
          if (cid && pendingConfirms.has(cid)) {
            resolveConfirm(cid, !!msg.approved, 'reply');
          } else if (!cid && pendingConfirms.size > 0) {
            // 兼容旧客户端（不带 confirmId）：取该 session 下最早的一个 pending
            const subscribedSid = wsToSubscribedSession.get(ws) || activeSessionId;
            for (const [k, entry] of pendingConfirms) {
              if (entry.sessionId === subscribedSid) {
                resolveConfirm(k, !!msg.approved, 'reply');
                break;
              }
            }
          }
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

        if (msg.type === 'switch_session') {
          const targetId = String(msg.sessionId || '');
          if (!targetId || targetId === activeSessionId) {
            sendJSON(ws, { type: 'session_switched', ok: true, sessionId: activeSessionId });
            return;
          }
          // 任务进行中切换：主动 abort 旧任务，让其 cleanup 写入旧 session（已被 runSessionId 锁定），
          // 然后无阻塞切换到新 session。
          if (isProcessing && activeAbortController) {
            console.log('[chat-ws] switch_session 时中断当前任务');
            activeAbortController.abort();
            activeAbortController = null;
          }
          const oldSessionId = activeSessionId;
          try {
            await flushStructuredMessagesNow(oldSessionId);
          } catch (err) {
            console.error('[chat-ws] switch_session flush failed:', err);
            sendJSON(ws, { type: 'session_switched', ok: false, reason: 'flush_failed' });
            return;
          }
          let supervisorResetFailed = false;
          try {
            resetSupervisorRuntimeCache();
          } catch (err) {
            supervisorResetFailed = true;
            console.warn('[chat-ws] supervisor reset on switch_session failed:', err);
          }
          activeSessionId = targetId;
          const loaded = await loadStructuredMessages(activeSessionId);
          setCachedMessages(activeSessionId, loaded ?? []);
          // 把请求方的订阅切到新 session；其他端不动（保持原有视图）
          subscribeWsToSession(ws, activeSessionId);
          const newRunningTurn = snapshotRunningTurn(activeSessionId);
          const workspace = await resolveSessionWorkspacePayload(activeSessionId);
          sendJSON(ws, {
            type: 'session_switched',
            ok: true,
            sessionId: activeSessionId,
            ...workspace,
            ...(supervisorResetFailed ? { reason: 'supervisor_reset_failed' } : {}),
            ...(newRunningTurn ? { runningTurn: newRunningTurn } : {}),
          });
          console.log(`[chat-ws] 切换到会话 ${activeSessionId}`);
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
          const runSid = activeSessionId;
          ensureRunningTurn(runSid);
          broadcastToSession(runSid, { type: 'status', status: 'processing' });

          try {
            const inlineImages: string[] = Array.isArray(msg.images) ? msg.images : [];
            await handleChatMessage(ws, msg.content || '', orchestrator, toolRegistry, toolExecutor, inlineImages);
          } catch (err) {
            broadcastToSession(runSid, { type: 'error', message: formatFriendlyError(err) });
          }

          // 处理队列中的待发消息
          while (pendingMessages.length > 0) {
            const pending = pendingMessages.shift()!;
            const nextSid = activeSessionId;
            ensureRunningTurn(nextSid);
            broadcastToSession(nextSid, { type: 'status', status: 'processing' });
            try {
              await handleChatMessage(ws, pending.content, orchestrator, toolRegistry, toolExecutor, pending.images);
            } catch (err) {
              broadcastToSession(nextSid, { type: 'error', message: formatFriendlyError(err) });
            }
          }

          isProcessing = false;
          // 整批结束：runningTurn 已在每条任务 finally 中清空；广播 idle 给该批起始的订阅者
          broadcastToSession(runSid, { type: 'status', status: 'idle' });
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
  // 关键：锁定本次运行的 sessionId。
  // 用户在长任务中途切换 session 时，旧任务的 cleanup（持久化、记录工具调用）
  // 仍写入正确的旧 session 文件，不会污染新 session。
  const runSessionId = activeSessionId;
  const llmAdapter = orchestrator.getLLMAdapter();
  let toolDefs = toolRegistry.getDefinitions();
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

  const fbs = getFileBrowserState(runSessionId);
  const opensBrowser = detectFileBrowserOpen(message);
  if (opensBrowser) {
    fbs.active = true;
    fbs.lastBrowsedPath = null;
  }

  // 确保记忆系统已初始化
  await ensureMemoryInitialized();

  const existingMessages = getCachedMessages(runSessionId);

  // 写入用户消息到会话文件
  const userMsgId = randomUUID();
  const userPersisted = await appendMessages(
    [{ role: 'user', content: message, id: userMsgId }],
    runSessionId,
  );
  if (userPersisted) {
    const autoTitle = await applyFirstPromptSessionTitle(runSessionId, message);
    broadcastSessionUpdated(
      'user_message',
      autoTitle ? { sessionId: runSessionId, title: autoTitle } : undefined,
      ws,
    );
  }

  const resolvedForDirect =
    typeof userMessageContent === 'string' ? userMessageContent : resolvedMessage;

  // ── 目录列举：服务端直接执行 list_drives / browse_directory，避免模型假列表 ──
  const direct = await tryDirectFileBrowserTurn({
    toolExecutor,
    resolvedText: resolvedForDirect,
    opensBrowser,
    lastBrowsedPath: fbs.lastBrowsedPath,
    platform: process.platform,
    hasImages: inlineImages.length > 0 || Array.isArray(userMessageContent),
    active: fbs.active,
  });

  if (direct.handled && direct.variant === 'deterministic') {
    fbs.lastBrowsedPath = direct.newLastBrowsedPath;
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
      sessionId: runSessionId,
    });
    return;
  }

  if (direct.handled && direct.variant === 'harness_augment') {
    fbs.lastBrowsedPath = direct.newLastBrowsedPath;
    harnessUserMessage = direct.augmentedUserText;
    console.log('[chat-ws] file-browser-direct harness_augment (browse_directory output injected)');
  }

  if (
    fbs.lastBrowsedPath
    && typeof harnessUserMessage === 'string'
    && looksLikeFileAnalysisIntent(message)
  ) {
    harnessUserMessage += `\n\n（服务端提示：最近一次列出的文件夹为 \`${fbs.lastBrowsedPath}\`。用户若只给出文件名，请与该路径拼接为完整绝对路径后调用 parse_document / parse_pptx_deep / open_file。）`;
  }

  // 创建 AbortController 用于用户中断
  const abortController = new AbortController();
  activeAbortController = abortController;
  // 将中断信号传递给 LLMAdapter，支持重试等待期间中断
  llmAdapter.setAbortSignal?.(abortController.signal);

  const supervisorRuntime = await getSupervisorRuntime();
  const skipPermissionChecks = await readSkipPermissionChecksFromMainConfig(MAIN_CONFIG_PATH);
  const modelMeta = await resolveDefaultChatModelMeta(MAIN_CONFIG_PATH);

  const workspaceMessage = typeof harnessUserMessage === 'string'
    ? harnessUserMessage
    : resolvedMessage;
  const wsCtx = await resolveWorkspaceToolContext({
    sessionDir: SESSIONS_DIR,
    sessionId: runSessionId,
    userMessage: workspaceMessage,
    defaultWorkDir: process.cwd(),
    defaultToolExecutor: toolExecutor,
    defaultToolRegistry: toolRegistry,
    fileParser: orchestrator.getFileParser(),
    llmAdapter,
  });
  toolDefs = wsCtx.toolDefs;
  const effectiveWorkspace = wsCtx.effectiveWorkspaceRoot;
  const runToolExecutor = wsCtx.toolExecutor;

  if (wsCtx.workspace.detection.changed) {
    broadcastToSession(runSessionId, {
      type: 'workspace_updated',
      sessionId: runSessionId,
      workspaceRoot: effectiveWorkspace,
      defaultWorkDir: DEFAULT_WORK_DIR,
    });
  }

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
      maxOutputTokens: modelMeta?.maxOutputTokens,
      signal: abortController.signal,
    },
    permissions: [
      { pattern: 'fs_operation', permission: 'confirm', reason: 'File system operations require confirmation' },
    ],
    skipPermissionChecks,
    compactionThreshold: 40,
    compactionKeepRecent: 10,
    compactionEnableLLMSummary: true,
    memoryDir: MEMORY_DIR,
    fileMemoryManager: globalFileMemoryManager ?? undefined,
    sessionDir: SESSIONS_DIR,
    sessionId: runSessionId,
    workspaceRoot: effectiveWorkspace,
    supervisorConfig: supervisorRuntime.supervisorConfig,
    globalPolicy: supervisorRuntime.globalPolicy,
    supervisorBridge: supervisorRuntime.bridge,
    onConfirm: (toolName, args) => {
      return new Promise<boolean>((resolve) => {
        const confirmId = nextConfirmId();
        const timer = setTimeout(() => {
          if (pendingConfirms.has(confirmId)) {
            broadcastToSession(runSessionId, { type: 'confirm_timeout', confirmId, toolName });
            resolveConfirm(confirmId, false, 'timeout');
          }
        }, 60_000);
        pendingConfirms.set(confirmId, {
          sessionId: runSessionId,
          toolName,
          resolve,
          timer,
        });
        // 广播给该 session 所有订阅者（PC + 移动端），任何一端回复即生效
        broadcastToSession(runSessionId, { type: 'confirm', confirmId, toolName, args });
      });
    },
  };

  const harness = new Harness(harnessConfig, runToolExecutor);

  // 注册默认停止钩子：模型自承未完成时拉回工具调用（意图过滤由 Harness 状态门控承担）
  harness.getStopHookManager().register(async (messages, lastContent) =>
    evaluateIncompleteTaskStopHook(messages, lastContent),
  );

  // 收集本轮工具调用记录（用于持久化到会话文件，不发送给 LLM）
  const toolTraceBatch: { toolName: string; detail: string; status: string }[] = [];

  // 方案 B2：本次任务的快照锚点（每条 message 一个）
  ensureRunningTurn(runSessionId);

  const pulseTimer = setInterval(() => {
    broadcastToSession(runSessionId, { type: 'pulse', ts: Date.now() });
  }, 10_000);

  try {
    const result = await harness.run(
      harnessUserMessage,
      (msgs, opts) => llmAdapter.chat(msgs, opts),
      (event) => {
        // 同步 fold 进 runningTurn 快照（供 F5/扫码后新订阅者还原）
        foldStepIntoRunningTurn(runSessionId, event);

        // 推送 step 到 WebSocket（按 session 广播给所有订阅者）
        broadcastToSession(runSessionId, { type: 'step', step: event });

        // 流式增量文本直接推送
        if (event.type === 'stream_delta' && event.delta) {
          broadcastToSession(runSessionId, { type: 'stream', delta: event.delta });
        }

        // 工具实时输出推送
        if (event.type === 'tool_output' && event.content) {
          broadcastToSession(runSessionId, { type: 'tool_output', toolName: event.toolName, content: event.content });
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

    // 缓存完整的结构化消息历史并持久化到磁盘（写入本次运行锁定的 sessionId，
    // 即使用户在执行过程中切换了 activeSessionId，也确保历史归属正确的旧 session）
    setCachedMessages(runSessionId, result.messages);
    saveStructuredMessages(result.messages, runSessionId);

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
      const persisted = await appendMessages(sessionEntries, runSessionId);
      if (persisted) broadcastSessionUpdated('turn_complete', undefined, ws);
    }

    // 推送最终结果到 WebSocket（stream_end 通知前端流式结束）
    broadcastToSession(runSessionId, { type: 'stream_end' });

    // v4 被动确认：附加记忆提取通知
    const extractionNotices = harness.flushExtractionNotices();
    if (extractionNotices.length > 0) {
      broadcastToSession(runSessionId, { type: 'memory_notice', notices: extractionNotices });
    }

    if (result.content) {
      broadcastToSession(runSessionId, { type: 'response', content: result.content });
    }
    if (result.loopState.stopReason === 'user_abort') {
      broadcastToSession(runSessionId, { type: 'info', message: '任务已被用户中断' });
    } else if (result.loopState.totalToolCalls > 0) {
      broadcastToSession(runSessionId, { type: 'info', message: `共调用 ${result.loopState.totalToolCalls} 次工具` });
    }
    broadcastToSession(runSessionId, {
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
    // 任务（或本次 abort）落幕：清空运行中快照
    clearRunningTurn(runSessionId);
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
  setCachedMessages(activeSessionId, undefined);
  fileBrowserStateBySession.delete(activeSessionId);
  chatClients.clear();
  sessionSubscribers.clear();
  runningTurns.clear();
  // pending confirms：解决为 false，让任何挂起的 promise 不会泄漏
  for (const [cid, entry] of pendingConfirms) {
    clearTimeout(entry.timer);
    pendingConfirms.delete(cid);
    try { entry.resolve(false); } catch { /* ignore */ }
  }
  mcpReadySnapshot = null;
  tunnelReadySnapshot = null;
  console.log('[chat-ws] Resources cleaned up');
}
