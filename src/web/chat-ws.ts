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
import { finalizeMessagesForApi } from '../harness/context-assembler.js';
import { buildTotalTokenUsageWithContext } from '../harness/context-usage-display.js';
import { evaluateIncompleteTaskStopHook } from '../harness/incomplete-task-stop-hook.js';
import type { HarnessConfig } from '../harness/types.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { MCPManager } from '../mcp/mcp-manager.js';
import { bootstrapActiveSessionIdFromIndex } from './routes/sessions.js';
import { persistLastActiveSessionId } from './last-active-session.js';
import { resolveWorkspaceToolContext } from '../harness/workspace-run-context.js';
import { addSessionReferenceReads } from '../harness/session-workspace-store.js';
import { resolveEffectiveWorkspaceRoot } from '../harness/session-workspace-store.js';
import { loadMemoryPrompt } from '../memory/file-memory/index.js';
import { createFileMemoryManager } from '../memory/file-memory/file-memory-manager.js';
import type { UnifiedMessage } from '../llm/types.js';
import { resolveFileReferences } from './routes/upload.js';
import { randomUUID } from 'node:crypto';

const CLIENT_MESSAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseClientMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return CLIENT_MESSAGE_ID_RE.test(id) ? id : null;
}
import { loadAssembledChatPrompt, shouldDisableRuntimeTools } from '../prompts/load-chat-prompt.js';
import type { AssembledPrompt } from '../prompts/types.js';
import { harnessOverlayToContextFields } from '../prompts/prompt-assembler.js';
import {
  getHarnessMaxRoundsFromEnv,
  getHarnessTimeoutMsFromEnv,
  getHarnessTokenBudget,
} from '../harness/token-budget-config.js';
import { loadHarnessSupervisorRuntime } from '../harness/supervisor/supervisor-config.js';
import {
  readSkipPermissionChecksFromMainConfig,
} from '../config/main-config-supervisor-mode.js';
import { readVerificationExemptDirsFromMainConfig } from '../harness/verification-exempt-config.js';
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
import { resolveDefaultChatModelMeta, resolveDefaultSupportsVision } from './routes/config.js';
import {
  buildUserMessageWithImages,
  deleteSessionImagesCache,
  persistInlineImages,
  persistUploadedImageFiles,
  buildSessionImageApiUrl,
} from './images-cache.js';
import {
  detectFileBrowserOpen,
  looksLikeFileAnalysisIntent,
  tryDirectFileBrowserTurn,
} from './file-browser-direct.js';
import { BgTaskPusher } from './bg-task-pusher.js';
import { getBackgroundTaskManagerFor, findBackgroundTaskManagerOwning, disposeBackgroundTaskManagerForSession } from '../tools/background-task-manager.js';
import {
  formatToolArgsDetailPreview,
  resolveToolCallInitialStatus,
  resolveToolTraceResultStatus,
} from './tool-trace-format.js';
import { extractDiffSource } from './tool-display-extract.js';
import {
  capToolTraceDiffSource,
  persistToolTraceDiff,
  resolveToolDiffForSession,
} from './session-tool-trace-diffs.js';
// isExecutionPlanEnabled removed (Phase 11)

import { applyRuntimeDataEnvDefaults } from '../cli/paths.js';
import { getSkillRegistry } from '../core/skill-registry.js';
import {
  beginSessionHarnessRun,
  clearHarnessRuntimeState,
  endSessionHarnessRun,
  getHarnessRuntimeState,
} from '../harness/harness-runtime-registry.js';
import {
  captureIntentCheckpoint,
  readUiSessionMessages,
} from '../harness/intent-checkpoint-capture.js';
import {
  beginIntentCheckpointTurn,
  finalizeIntentCheckpointTurn,
  clearIntentCheckpointTurnsForSession,
} from '../harness/intent-checkpoint-turn-snapshot.js';
import {
  loadCheckpointIndex,
  loadCheckpointMessageIds,
  loadIntentCheckpoint,
} from '../harness/intent-checkpoint-store.js';
import {
  getRuntimeRestoreCoordinator,
  RestoreFailedError,
  RestoreNotAllowedError,
} from '../harness/runtime-restore-coordinator.js';
import {
  deleteUserMessageConversation,
  DeleteMessageNotFoundError,
} from '../harness/conversation-delete.js';
import {
  canAcceptRuntimeRestore,
  registerSessionRuntimeBusyProbe,
} from './session-runtime-busy.js';

applyRuntimeDataEnvDefaults();
const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR!);
let activeSessionId = 'default';
let activeSessionBootstrapPromise: Promise<void> | null = null;

/** 会话级活跃 batch 计数（含排队消息处理中） */
const sessionActiveBatchCounts = new Map<string, number>();

function beginSessionBatch(sessionId: string): void {
  sessionActiveBatchCounts.set(sessionId, (sessionActiveBatchCounts.get(sessionId) ?? 0) + 1);
  beginSessionHarnessRun(sessionId);
}

function endSessionBatch(sessionId: string): void {
  const next = Math.max(0, (sessionActiveBatchCounts.get(sessionId) ?? 0) - 1);
  if (next === 0) sessionActiveBatchCounts.delete(sessionId);
  else sessionActiveBatchCounts.set(sessionId, next);
  endSessionHarnessRun(sessionId);
}

async function buildConnectedPayloadExtras(sessionId: string): Promise<{
  harnessState: string;
  canRestore: boolean;
  checkpointMessageIds: string[];
}> {
  const checkpointMessageIds = await loadCheckpointMessageIds(SESSIONS_DIR, sessionId);
  return {
    harnessState: getHarnessRuntimeState(sessionId),
    canRestore: canAcceptRuntimeRestore(sessionId),
    checkpointMessageIds,
  };
}

/** 后台 shell 任务 → WebSocket chip 推送（Phase 4b） */
let bgTaskPusher: BgTaskPusher | null = null;

/** UI 心跳间隔（比 LLM 摘要 5min 更密，便于聊天区看到 running 状态） */
const BG_TASK_UI_PUSH_INTERVAL_MS = 30_000;

/** 冷启动：选中 index 中 updatedAt 最近的会话，并预载 structured 缓存。 */
async function ensureActiveSessionBootstrapped(): Promise<void> {
  if (activeSessionBootstrapPromise) return activeSessionBootstrapPromise;
  activeSessionBootstrapPromise = (async () => {
    try {
      const id = await bootstrapActiveSessionIdFromIndex();
      if (id) {
        activeSessionId = id;
        void persistLastActiveSessionId(id);
      }
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
const MEMORY_DIR = path.resolve(process.env.ICE_MEMORY_DIR!);
const DATA_DIR = path.resolve(process.env.ICE_DATA_DIR!);
const MAIN_CONFIG_PATH = path.resolve(process.env.ICE_CONFIG_PATH!);
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

interface ToolTraceBatchEntry {
  toolName: string;
  detail: string;
  status: string;
  toolCallId?: string;
  /** 供刷新后 UI 还原 diff 面板（不依赖 .structured.json 对齐） */
  diffSource?: string | null;
}

function recordPersistedToolTraceDiff(
  sessionId: string,
  toolCallId: string | undefined,
  diffSource: string | null | undefined,
): void {
  if (!toolCallId || !diffSource) return;
  void persistToolTraceDiff(SESSIONS_DIR, sessionId, toolCallId, diffSource);
}

/** 导出活跃会话 ID，供会话路由等模块使用 */
export function getActiveSessionId(): string {
  return activeSessionId;
}

/** 正在执行任务的会话 id 列表（供 bootstrap 优先选中「最近工作」会话）。 */
export function getProcessingSessionIds(): string[] {
  const ids: string[] = [];
  for (const [sid, snap] of runningTurns) {
    if (snap.isProcessing) ids.push(sid);
  }
  return ids;
}

/**
 * 清理被删除会话在进程内的所有缓存。
 * 由 sessions REST DELETE 通过 `registerSessionCleanupHook` 注入；
 * 若删的是 active session，调用方应先 `switch_session` 到其它会话。
 */
export function purgeSessionRuntimeCaches(sessionId: string): void {
  structuredCache.delete(sessionId);
  fileBrowserStateBySession.delete(sessionId);
  clearHarnessRuntimeState(sessionId);
  sessionActiveBatchCounts.delete(sessionId);
  const pending = saveTimerMap.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    saveTimerMap.delete(sessionId);
  }
  // P1-11：清理此前未被回收的运行期资源，避免内存增长 / 后台进程残留。
  // 运行中快照
  runningTurns.delete(sessionId);
  // 进行中标记 + 排队消息 + abort 控制器
  if (abortSession(sessionId)) {
    // 已 abort：让其 cleanup 自行收尾，这里仅移除登记
  }
  sessionAbortControllers.delete(sessionId);
  sessionProcessing.delete(sessionId);
  clearSessionPending(sessionId);
  // 该会话的待确认对话框 + 60s 定时器
  for (const [cid, entry] of pendingConfirms) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pendingConfirms.delete(cid);
    try { entry.resolve(false); } catch { /* ignore */ }
  }
  // intent checkpoint 回合状态
  clearIntentCheckpointTurnsForSession(sessionId);
  // 后台任务管理器（终止后台进程）
  try { disposeBackgroundTaskManagerForSession(sessionId); } catch { /* ignore */ }
  if (sessionId === activeSessionId) {
    cachedMessages = undefined;
  }
  void deleteSessionImagesCache(sessionId).catch(() => {});
}

/** 获取会话目录路径 */
export function getSessionsDir(): string {
  return SESSIONS_DIR;
}

/**
 * 会话级 AbortController（用于用户中断正在执行的任务）。
 * 每次 handleChatMessage 开始时按 runSessionId 登记，结束时移除。
 * 改为会话级后，一次 stop 只会中止对应会话的运行，不会误中止其它标签/会话（P1-9）。
 */
const sessionAbortControllers = new Map<string, AbortController>();

/** 当前正在运行 harness 的会话集合（跨连接共享，防止同一会话被多标签并发跑两个 harness）。 */
const sessionProcessing = new Set<string>();

interface PendingChatMessage {
  content: string;
  images: string[];
  messageId?: string;
  ws: WebSocket;
}

/** 会话级待处理消息队列：同一会话运行中时，新消息（含其它标签页）排队，由持有运行的循环 drain。 */
const sessionPendingMessages = new Map<string, PendingChatMessage[]>();

function enqueueSessionPending(sessionId: string, msg: PendingChatMessage): void {
  const arr = sessionPendingMessages.get(sessionId);
  if (arr) arr.push(msg);
  else sessionPendingMessages.set(sessionId, [msg]);
}

function dequeueSessionPending(sessionId: string): PendingChatMessage | undefined {
  const arr = sessionPendingMessages.get(sessionId);
  if (!arr || arr.length === 0) return undefined;
  const next = arr.shift();
  if (arr.length === 0) sessionPendingMessages.delete(sessionId);
  return next;
}

function clearSessionPending(sessionId: string): void {
  sessionPendingMessages.delete(sessionId);
}

function abortSession(sessionId: string): boolean {
  const ctrl = sessionAbortControllers.get(sessionId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

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

/** 移动端扫码连入：将全局 activeSessionId 对齐到 QR 绑定的聊天 session */
async function ensureGlobalActiveSessionId(targetId: string): Promise<void> {
  if (!targetId || targetId === activeSessionId) return;
  const oldSessionId = activeSessionId;
  try {
    await flushStructuredMessagesNow(oldSessionId);
    activeSessionId = targetId;
    void persistLastActiveSessionId(targetId);
    let loaded: UnifiedMessage[] | undefined;
    try {
      loaded = await loadStructuredMessages(activeSessionId);
    } catch (loadErr) {
      console.warn('[chat-ws] remote join load structured failed, starting empty:', loadErr);
      loaded = undefined;
    }
    setCachedMessages(activeSessionId, loaded ?? []);
    try {
      resetSupervisorRuntimeCache();
    } catch (err) {
      console.warn('[chat-ws] supervisor reset on remote join failed:', err);
    }
    try {
      await rebindBgTaskPusher(activeSessionId);
    } catch (rebindErr) {
      console.warn('[chat-ws] remote join rebind bg task failed:', rebindErr);
    }
    console.log(`[chat-ws] 远程扫码对齐会话 ${activeSessionId}`);
  } catch (err) {
    activeSessionId = oldSessionId;
    console.error('[chat-ws] remote join session align failed:', err);
  }
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
    const repaired = finalizeMessagesForApi(parsed);
    console.log(`[chat-ws] 恢复 ${repaired.length} 条结构化消息`);
    return repaired;
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
  mcpManager?: MCPManager;
  /** 未完成主配置时拒绝 WebSocket 连接 */
  isSetupRequired?: () => boolean;
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
      } catch (err) {
        console.debug('[chat-ws] broadcastToSession 发送失败:', err instanceof Error ? err.message : err);
      }
    }
  }
}

/** 向 session 订阅者广播，可排除发送方（多端同步时发送端已有乐观 UI） */
function broadcastToSessionExcept(
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

function broadcastHarnessState(sessionId: string): void {
  void buildConnectedPayloadExtras(sessionId).then((extras) => {
    broadcastToSession(sessionId, {
      type: 'harness_state',
      sessionId,
      state: extras.harnessState,
      canRestore: extras.canRestore,
      checkpointMessageIds: extras.checkpointMessageIds,
    });
  });
}

async function getPriorTrackedPaths(sessionId: string): Promise<string[]> {
  const index = await loadCheckpointIndex(SESSIONS_DIR, sessionId);
  if (!index.cursorMessageId) return [];
  const archive = await loadIntentCheckpoint(SESSIONS_DIR, sessionId, index.cursorMessageId);
  return archive?.trackedPaths ?? [];
}

/** 向订阅者发送已序列化的 bg_task_update JSON（BgTaskPusher 回调） */
function broadcastBgTaskJson(sessionId: string, jsonBody: string): void {
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

function ensureBgTaskPusher(): BgTaskPusher {
  if (!bgTaskPusher) {
    bgTaskPusher = new BgTaskPusher(broadcastBgTaskJson, {
      intervalMs: BG_TASK_UI_PUSH_INTERVAL_MS,
    });
  }
  return bgTaskPusher;
}

/** 将推送器绑定到指定 session 的后台任务管理器（切换会话 / 开跑前调用） */
async function rebindBgTaskPusher(sessionId: string): Promise<void> {
  const workspace = await resolveSessionWorkspacePayload(sessionId);
  const workDir = workspace.workspaceRoot ?? DEFAULT_WORK_DIR;
  const mgr = getBackgroundTaskManagerFor(sessionId, workDir);
  ensureBgTaskPusher().attach(mgr);
  ensureBgTaskPusher().tick();
}

/** 用户从 UI 终止后台任务（bg task chip 关闭按钮） */
async function handleBgTaskStop(
  ws: WebSocket,
  taskId: string,
  fallbackSessionId: string,
): Promise<void> {
  const sid = wsToSubscribedSession.get(ws) || fallbackSessionId;
  console.log(`[chat-ws] 收到 bg_task_stop taskId=${taskId || '(empty)'} wsSession=${sid}`);

  if (!taskId) {
    sendJSON(ws, { type: 'bg_task_stop_result', ok: false, error: 'missing taskId' });
    return;
  }
  try {
    const workspace = await resolveSessionWorkspacePayload(sid);
    const workDir = workspace.workspaceRoot ?? DEFAULT_WORK_DIR;
    let mgr = getBackgroundTaskManagerFor(sid, workDir);
    let ok = mgr.kill(taskId);
    if (!ok) {
      const owner = findBackgroundTaskManagerOwning(taskId);
      if (owner) {
        console.log(
          `[chat-ws] bg_task_stop 在 session=${owner.sessionId} 找到任务（WS session=${sid}）`,
        );
        mgr = owner;
        ensureBgTaskPusher().attach(mgr);
        ok = mgr.kill(taskId);
      }
    } else {
      ensureBgTaskPusher().attach(mgr);
    }
    if (!ok) {
      console.warn(`[chat-ws] 终止后台任务失败 ${taskId} session=${sid}（未找到或已结束）`);
      sendJSON(ws, {
        type: 'bg_task_stop_result',
        ok: false,
        taskId,
        sessionId: sid,
        error: 'Task not found or not running',
      });
      return;
    }
    const stopped = mgr.getStatus(taskId);
    console.log(
      `[chat-ws] 用户终止后台任务 ${taskId}${stopped?.label ? ` (${stopped.label})` : ''} session=${mgr.sessionId}`,
    );
    ensureBgTaskPusher().tick();
    sendJSON(ws, { type: 'bg_task_stop_result', ok: true, taskId, sessionId: mgr.sessionId });
  } catch (err) {
    console.error('[chat-ws] bg_task_stop 异常:', err);
    sendJSON(ws, {
      type: 'bg_task_stop_result',
      ok: false,
      taskId,
      error: formatFriendlyError(err),
    });
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
  /** 当轮思考流（仅 UI，不入库） */
  streamingReasoningText: string;
  toolTimeline: { toolName: string; detail: string; status: string; toolCallId?: string; diffSource?: string | null }[];
  petState: string;
  petBubble: string;
  petStatusText: string;
  lastInputTokens: number;
  lastOutputTokens: number;
  /** 与压缩判定一致的有效占用（圆环分子） */
  lastEffectiveUsed: number;
  /** 上下文窗口上限（圆环分母） */
  contextWindow: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  startedAt: number;
  /** 重放的执行计划 / 任务图 / 执行模式相关 step 事件，前端按现有 bridge 喂回即可重建 UI */
  planEvents: Array<{ type: string; [k: string]: unknown }>;
}

const runningTurns = new Map<string, RunningTurnSnapshot>();

registerSessionRuntimeBusyProbe({
  getRunningTurn: (sessionId) => runningTurns.get(sessionId) ?? null,
  getPendingBatchCount: (sessionId) => sessionActiveBatchCounts.get(sessionId) ?? 0,
});

function createEmptyRunningTurn(): RunningTurnSnapshot {
  return {
    isProcessing: true,
    iteration: 0,
    streamingText: '',
    streamingReasoningText: '',
    toolTimeline: [],
    petState: 'thinking',
    petBubble: '',
    petStatusText: '',
    lastInputTokens: 0,
    lastOutputTokens: 0,
    lastEffectiveUsed: 0,
    contextWindow: 0,
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

function toolArgsDetailPreview(toolName: string, toolArgs: Record<string, unknown> | undefined): string {
  return formatToolArgsDetailPreview(toolName, toolArgs);
}

function toolResultStatusPreview(
  toolName: string,
  toolSuccess: boolean | undefined,
  toolOutcome: string | undefined,
  toolOutput: string | undefined,
): string {
  return resolveToolTraceResultStatus(toolName, toolSuccess, toolOutcome, toolOutput);
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
    if (typeof event.totalTokenUsage.effectiveUsed === 'number') {
      t.lastEffectiveUsed = event.totalTokenUsage.effectiveUsed;
    }
    if (typeof event.totalTokenUsage.contextWindow === 'number') {
      t.contextWindow = event.totalTokenUsage.contextWindow;
    }
  }

  switch (event.type) {
    case 'stream_delta':
      if (typeof event.delta === 'string') {
        t.streamingText += event.delta;
        t.petState = 'read';
      }
      break;
    case 'reasoning_stream_delta':
      if (typeof event.delta === 'string') {
        t.streamingReasoningText += event.delta;
        t.petState = 'thinking';
      }
      break;
    case 'thinking':
      t.petState = 'thinking';
      if (typeof event.content === 'string') t.petBubble = event.content;
      break;
    case 'tool_call':
      if (event.toolName) {
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
        t.toolTimeline.push({
          toolName: String(event.toolName),
          detail: toolArgsDetailPreview(String(event.toolName), event.toolArgs),
          status: resolveToolCallInitialStatus(String(event.toolName), event.toolArgs),
          toolCallId,
          diffSource: extractDiffSource(String(event.toolName), undefined, event.toolArgs as Record<string, unknown> | undefined),
        });
        t.petState = 'working';
      }
      break;
    case 'tool_result':
      if (event.toolName) {
        for (let i = t.toolTimeline.length - 1; i >= 0; i--) {
          const row = t.toolTimeline[i];
          const idMatch = typeof event.toolCallId === 'string' && event.toolCallId && row.toolCallId === event.toolCallId;
          const nameMatch = row.toolName === event.toolName && (row.status === 'pending' || row.status === 'background');
          if (idMatch || (!event.toolCallId && nameMatch)) {
            row.status = toolResultStatusPreview(
              String(event.toolName),
              event.toolSuccess,
              event.toolOutcome,
              event.toolOutput,
            );
            const fromOutput = extractDiffSource(
              String(event.toolName),
              typeof event.toolOutput === 'string' ? event.toolOutput : undefined,
              event.toolArgs as Record<string, unknown> | undefined,
            );
            if (fromOutput) {
              row.diffSource = fromOutput;
              recordPersistedToolTraceDiff(sessionId, row.toolCallId, fromOutput);
            }
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
      } else if (event.stopReason === 'model_done') {
        t.petState = 'success';
        t.petBubble = '已完成';
        t.petStatusText = '已完成';
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
  msgs: {
    role: string;
    content?: string;
    id?: string;
    parentId?: string;
    toolName?: string;
    detail?: string;
    status?: string;
    toolCallId?: string;
    images?: string[];
    sentAt?: number;
    completedAt?: number;
    turnTokenUsage?: { inputTokens: number; outputTokens: number };
  }[],
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
    const now = Date.now();
    const stamped = msgs.map((msg) => {
      if (msg.role === 'user' && msg.sentAt == null) {
        return { ...msg, sentAt: now };
      }
      if (msg.role === 'agent' && msg.completedAt == null) {
        return { ...msg, completedAt: now };
      }
      return msg;
    });
    existing.push(...stamped);
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
    toolTraceBatch: ToolTraceBatchEntry[];
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
        toolCallId: t.toolCallId,
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
  const { orchestrator, toolRegistry, toolExecutor, mcpManager } = options;

  /**
   * 会话级运行循环：串行处理同一会话的消息（含其它标签页排队的消息）。
   * 通过 `sessionProcessing` 防止同一会话被多个连接并发跑两个 harness（P1-9）。
   */
  async function runSessionMessageLoop(runSid: string, first: PendingChatMessage): Promise<void> {
    sessionProcessing.add(runSid);
    try {
      let current: PendingChatMessage | undefined = first;
      while (current) {
        void persistLastActiveSessionId(runSid);
        beginSessionBatch(runSid);
        broadcastHarnessState(runSid);
        ensureRunningTurn(runSid);
        broadcastToSession(runSid, { type: 'status', status: 'processing' });
        try {
          await handleChatMessage(
            current.ws,
            current.content,
            orchestrator,
            toolRegistry,
            toolExecutor,
            current.images,
            current.messageId ?? null,
            mcpManager,
            runSid,
          );
        } catch (err) {
          broadcastToSession(runSid, { type: 'error', message: formatFriendlyError(err) });
        } finally {
          endSessionBatch(runSid);
          broadcastHarnessState(runSid);
          broadcastToSession(runSid, { type: 'status', status: 'idle' });
        }
        current = dequeueSessionPending(runSid);
      }
    } finally {
      sessionProcessing.delete(runSid);
    }
  }

  void ensureActiveSessionBootstrapped().then(() => rebindBgTaskPusher(activeSessionId).catch(() => {}));

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

      if (options.isSetupRequired?.()) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\r\n');
        socket.write(JSON.stringify({ error: '请先完成模型配置', setupRequired: true }));
        socket.destroy();
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
    } catch (err) {
      console.warn('[chat-ws] WebSocket upgrade 失败:', err instanceof Error ? err.message : err);
      socket.destroy();
    }
  });

  // 处理 WebSocket 连接（PC 和移动端统一处理）
  wss.on('connection', async (ws: WebSocket, request) => {
    await ensureActiveSessionBootstrapped();

    try {
      const reqUrl = new URL(request.url || '', 'http://localhost');
      const token = reqUrl.searchParams.get('token');
      if (token) {
        const remoteSession = getSession(token);
        const chatSessionId = remoteSession?.chatSessionId;
        if (chatSessionId) {
          await ensureGlobalActiveSessionId(chatSessionId);
        }
      }
    } catch (err) {
      console.warn('[chat-ws] remote session align skipped:', err);
    }

    chatClients.add(ws);
    subscribeWsToSession(ws, activeSessionId);
    startChatRuntimePrewarm();
    ws.once('close', () => {
      chatClients.delete(ws);
      unsubscribeWsFromAll(ws);
    });

    const features = { executionPlan: true };
    const runningTurn = snapshotRunningTurn(activeSessionId);
    const runtimeExtras = await buildConnectedPayloadExtras(activeSessionId);
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
          ...runtimeExtras,
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
        ...runtimeExtras,
      });
    }
    if (runningTurn?.isProcessing) {
      sendJSON(ws, { type: 'status', status: 'processing' });
    }

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
          // 仅中断本连接当前订阅会话的运行，并丢弃该会话排队中的待发消息，
          // 避免误中止其它标签/会话（P1-9），也避免 abort 后自动再起一轮。
          const sid = wsToSubscribedSession.get(ws) || activeSessionId;
          clearSessionPending(sid);
          if (abortSession(sid)) {
            console.log(`[chat-ws] 用户请求中断任务 session=${sid}`);
          }
          return;
        }

        if (msg.type === 'bg_task_stop') {
          const taskId = typeof msg.taskId === 'string' ? msg.taskId.trim() : '';
          await handleBgTaskStop(ws, taskId, activeSessionId);
          return;
        }

        if (msg.type === 'restore_runtime') {
          const messageId = typeof msg.messageId === 'string' ? msg.messageId.trim() : '';
          const sid = wsToSubscribedSession.get(ws) || activeSessionId;
          if (!messageId) {
            sendJSON(ws, { type: 'restore_failed', error: '缺少 messageId。' });
            return;
          }
          if (!canAcceptRuntimeRestore(sid)) {
            sendJSON(ws, {
              type: 'restore_failed',
              error: '运行中，请等待当前任务完成后再回滚。',
            });
            return;
          }
          try {
            const supervisorRuntime = await getSupervisorRuntime();
            const result = await getRuntimeRestoreCoordinator().restore({
              sessionDir: SESSIONS_DIR,
              sessionId: sid,
              messageId,
              defaultWorkDir: DEFAULT_WORK_DIR,
              supervisorBridge: supervisorRuntime.bridge,
              getStructuredMessages: () => getCachedMessages(sid),
              setStructuredMessages: (m) => setCachedMessages(sid, m),
            });
            const systemMsgId = randomUUID();
            await appendMessages([{
              role: 'system',
              content: result.systemEventContent,
              id: systemMsgId,
              sentAt: Date.now(),
            }], sid);
            broadcastToSession(sid, {
              type: 'runtime_restored',
              sessionId: sid,
              messageId,
              checkpointMessageIds: await loadCheckpointMessageIds(SESSIONS_DIR, sid),
              systemEvent: {
                id: systemMsgId,
                content: result.systemEventContent,
                sentAt: Date.now(),
              },
              userMessageTime: result.userMessageTime,
            });
            broadcastHarnessState(sid);
            broadcastSessionUpdated('runtime_restored', { sessionId: sid }, ws);
          } catch (err) {
            const message = err instanceof RestoreNotAllowedError || err instanceof RestoreFailedError
              ? err.message
              : '回滚失败，运行时状态未改变。';
            console.error('[chat-ws] restore_runtime failed:', err);
            sendJSON(ws, { type: 'restore_failed', error: message });
          }
          return;
        }

        if (msg.type === 'delete_user_message') {
          const messageId = typeof msg.messageId === 'string' ? msg.messageId.trim() : '';
          const sid = wsToSubscribedSession.get(ws) || activeSessionId;
          if (!messageId) {
            sendJSON(ws, { type: 'delete_message_failed', error: '缺少 messageId。' });
            return;
          }
          if (!canAcceptRuntimeRestore(sid)) {
            sendJSON(ws, {
              type: 'delete_message_failed',
              error: '运行中，请等待当前任务完成后再删除。',
            });
            return;
          }
          try {
            await deleteUserMessageConversation({
              sessionDir: SESSIONS_DIR,
              sessionId: sid,
              messageId,
              getStructuredMessages: () => getCachedMessages(sid),
              setStructuredMessages: (m) => setCachedMessages(sid, m),
            });
            broadcastToSession(sid, {
              type: 'message_deleted',
              sessionId: sid,
              messageId,
              checkpointMessageIds: await loadCheckpointMessageIds(SESSIONS_DIR, sid),
            });
            broadcastHarnessState(sid);
            broadcastSessionUpdated('message_deleted', { sessionId: sid }, ws);
          } catch (err) {
            const message = err instanceof DeleteMessageNotFoundError
              ? err.message
              : '删除消息失败，请稍后重试。';
            console.error('[chat-ws] delete_user_message failed:', err);
            sendJSON(ws, { type: 'delete_message_failed', error: message });
          }
          return;
        }

        if (msg.type === 'switch_session') {
          const targetId = String(msg.sessionId || '');
          if (!targetId || targetId === activeSessionId) {
            sendJSON(ws, { type: 'session_switched', ok: true, sessionId: activeSessionId });
            return;
          }
          // 任务进行中切换：主动 abort 正在离开的会话的运行，让其 cleanup 写入旧 session
          // （已被 runSessionId 锁定），然后无阻塞切换到新 session。仅作用于该会话，避免误中止其它会话。
          const leavingSessionId = wsToSubscribedSession.get(ws) || activeSessionId;
          if (abortSession(leavingSessionId)) {
            console.log(`[chat-ws] switch_session 时中断会话 ${leavingSessionId} 的任务`);
            clearSessionPending(leavingSessionId);
          }
          const oldSessionId = activeSessionId;
          try {
            await flushStructuredMessagesNow(oldSessionId);
          } catch (err) {
            console.error('[chat-ws] switch_session flush failed:', err);
            sendJSON(ws, { type: 'session_switched', ok: false, reason: 'flush_failed', sessionId: oldSessionId });
            return;
          }
          let supervisorResetFailed = false;
          try {
            resetSupervisorRuntimeCache();
          } catch (err) {
            supervisorResetFailed = true;
            console.warn('[chat-ws] supervisor reset on switch_session failed:', err);
          }
          try {
            activeSessionId = targetId;
            void persistLastActiveSessionId(targetId);
            let loaded: UnifiedMessage[] | undefined;
            try {
              loaded = await loadStructuredMessages(activeSessionId);
            } catch (loadErr) {
              console.warn('[chat-ws] switch_session load structured failed, starting empty:', loadErr);
              loaded = undefined;
            }
            setCachedMessages(activeSessionId, loaded ?? []);
            // 把请求方的订阅切到新 session；其他端不动（保持原有视图）
            subscribeWsToSession(ws, activeSessionId);
            try {
              await rebindBgTaskPusher(activeSessionId);
            } catch (rebindErr) {
              console.warn('[chat-ws] switch_session rebind bg task failed:', rebindErr);
            }
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
          } catch (err) {
            activeSessionId = oldSessionId;
            console.error('[chat-ws] switch_session failed:', err);
            sendJSON(ws, {
              type: 'session_switched',
              ok: false,
              reason: 'switch_failed',
              sessionId: oldSessionId,
            });
          }
          return;
        }

        if (msg.type === 'message' && (msg.content || (msg.images && msg.images.length > 0))) {
          const runSid = wsToSubscribedSession.get(ws) || activeSessionId;
          const incoming: PendingChatMessage = {
            content: msg.content || '',
            images: Array.isArray(msg.images) ? msg.images : [],
            messageId: parseClientMessageId(msg.messageId) ?? undefined,
            ws,
          };
          // 会话级串行：若该会话已在运行（可能来自其它标签页），排队由持有运行的循环 drain。
          if (sessionProcessing.has(runSid)) {
            enqueueSessionPending(runSid, incoming);
            sendJSON(ws, { type: 'info', message: '已排队，当前任务完成后自动处理' });
            return;
          }
          void runSessionMessageLoop(runSid, incoming);
        }
      } catch {
        sendJSON(ws, { type: 'error', message: '消息格式错误' });
      }
    });

    ws.on('error', (err) => {
      console.debug('[chat-ws] WebSocket 连接错误:', err instanceof Error ? err.message : err);
    });
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
  clientMessageId: string | null = null,
  mcpManager?: MCPManager,
  runSessionId: string = activeSessionId,
): Promise<void> {
  // 关键：本次运行的 sessionId 由调用方（runSessionMessageLoop）锁定为该连接订阅的会话，
  // 而非全局 activeSessionId，避免某连接订阅会话 ≠ 全局活跃会话时把运行/持久化写到错误会话（P1-8）。
  // 用户在长任务中途切换 session 时，旧任务的 cleanup（持久化、记录工具调用）
  // 仍写入正确的旧 session 文件，不会污染新 session。
  await rebindBgTaskPusher(runSessionId);
  const llmAdapter = orchestrator.getLLMAdapter();
  let toolDefs = toolRegistry.getDefinitions();
  const assembled = await loadAssembledPrompt();
  const harnessDynamic = harnessOverlayToContextFields(assembled);

  // 解析消息中的文件引用 [file:xxx]，替换为实际文件路径
  const { text: resolvedMessage, filePaths, imageUrls } = resolveFileReferences(message);

  // 解析 #skill.md 引用，将技能正文注入发给模型的文本
  let harnessMessageText = resolvedMessage;
  const skillRegistry = getSkillRegistry();
  const skillResolved = await skillRegistry.resolveMessage(resolvedMessage);
  if (skillResolved) {
    harnessMessageText = skillResolved.augmentedText;
  }
  harnessMessageText = skillRegistry.applyCreationGuideIfNeeded(harnessMessageText, resolvedMessage);

  const supportsVision = await resolveDefaultSupportsVision(MAIN_CONFIG_PATH);

  const persistedInline = await persistInlineImages(inlineImages, runSessionId);
  const persistedUploads = await persistUploadedImageFiles(imageUrls, runSessionId);
  const allPersistedImages = [...persistedInline, ...persistedUploads];
  const imageAbsolutePaths = allPersistedImages.map((p) => p.absolutePath);

  if (imageAbsolutePaths.length > 0) {
    await addSessionReferenceReads({
      sessionDir: SESSIONS_DIR,
      sessionId: runSessionId,
      paths: imageAbsolutePaths,
    });
  }

  const uiImageUrls = allPersistedImages.map((p) => buildSessionImageApiUrl(runSessionId, p.absolutePath));

  const visionDataUrls: string[] = [...inlineImages];
  if (supportsVision) {
    for (const img of persistedUploads) {
      try {
        const imgData = await fsPromises.readFile(img.absolutePath);
        const ext = path.extname(img.absolutePath).toLowerCase().replace('.', '');
        const mimeType = ext === 'jpg' ? 'jpeg' : ext;
        visionDataUrls.push(`data:image/${mimeType};base64,${imgData.toString('base64')}`);
      } catch (err) {
        console.error('[chat-ws] 读取图片失败:', err);
      }
    }
  }

  const { content: userMessageContent, harnessUserMessage: builtHarnessUserMessage } =
    buildUserMessageWithImages({
      userText: harnessMessageText,
      filePaths,
      imageAbsolutePaths,
      imageDataUrls: supportsVision ? visionDataUrls : [],
      supportsVision,
    });

  let harnessUserMessage = builtHarnessUserMessage;

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
  const userMsgId = clientMessageId ?? randomUUID();
  const userSentAt = Date.now();
  const userPersisted = await appendMessages(
    [{
      role: 'user',
      content: message,
      id: userMsgId,
      sentAt: userSentAt,
      ...(uiImageUrls.length > 0 ? { images: uiImageUrls } : {}),
    }],
    runSessionId,
  );
  if (userPersisted) {
    const autoTitle = await applyFirstPromptSessionTitle(runSessionId, message);
    broadcastSessionUpdated(
      'user_message',
      autoTitle ? { sessionId: runSessionId, title: autoTitle } : { sessionId: runSessionId },
      ws,
    );
    // 多端实时同步：processing 期间其它端无法靠 session_updated 拉快照（前端会跳过），须直推用户消息
    broadcastToSessionExcept(runSessionId, {
      type: 'user_message_appended',
      sessionId: runSessionId,
      message: {
        role: 'user',
        id: userMsgId,
        content: message,
        sentAt: userSentAt,
        ...(uiImageUrls.length > 0 ? { images: uiImageUrls } : {}),
      },
    }, ws);
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
    hasImages: inlineImages.length > 0 || imageUrls.length > 0 || imageAbsolutePaths.length > 0,
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

  // 创建会话级 AbortController 用于用户中断
  const abortController = new AbortController();
  sessionAbortControllers.set(runSessionId, abortController);
  // 将中断信号传递给 LLMAdapter，支持重试等待期间中断
  llmAdapter.setAbortSignal?.(abortController.signal);

  const supervisorRuntime = await getSupervisorRuntime();
  const skipPermissionChecks = await readSkipPermissionChecksFromMainConfig(MAIN_CONFIG_PATH);
  const verificationExemptDirs = await readVerificationExemptDirsFromMainConfig(MAIN_CONFIG_PATH);
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
    mcpManager,
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
    verificationExemptDirs,
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

  // Intent Checkpoint — 每条 User Message 对应一个 Runtime Checkpoint（Harness 即将 Running）
  try {
    const priorTracked = await getPriorTrackedPaths(runSessionId);
    const uiMessages = await readUiSessionMessages(SESSIONS_DIR, runSessionId);
    const structuredBase = existingMessages ? [...existingMessages] : [];
    structuredBase.push({
      role: 'user',
      content: Array.isArray(userMessageContent) ? userMessageContent : harnessUserMessage,
    });
    const userUi = uiMessages.find((m) => m.id === userMsgId);
    await captureIntentCheckpoint({
      sessionDir: SESSIONS_DIR,
      sessionId: runSessionId,
      messageId: userMsgId,
      userMessageTime: userUi?.sentAt ?? Date.now(),
      workspaceRoot: effectiveWorkspace,
      workspaceState: wsCtx.workspace.state,
      structuredMessages: structuredBase,
      uiMessages,
      priorTrackedPaths: priorTracked,
    });
    broadcastToSession(runSessionId, {
      type: 'checkpoint_captured',
      sessionId: runSessionId,
      messageId: userMsgId,
    });
    broadcastHarnessState(runSessionId);
  } catch (err) {
    console.error('[chat-ws] intent checkpoint capture failed:', err);
    broadcastToSession(runSessionId, {
      type: 'checkpoint_capture_failed',
      sessionId: runSessionId,
      messageId: userMsgId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 注册默认停止钩子：模型自承未完成时拉回工具调用（意图过滤由 Harness 状态门控承担）
  harness.getStopHookManager().register(async (messages, lastContent) =>
    evaluateIncompleteTaskStopHook(messages, lastContent),
  );

  // 收集本轮工具调用记录（用于持久化到会话文件，不发送给 LLM）
  const toolTraceBatch: ToolTraceBatchEntry[] = [];

  // 方案 B2：本次任务的快照锚点（每条 message 一个）
  ensureRunningTurn(runSessionId);

  beginIntentCheckpointTurn(runSessionId, userMsgId, effectiveWorkspace);

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
        if (event.type === 'reasoning_stream_delta' && event.delta) {
          broadcastToSession(runSessionId, { type: 'reasoning_stream', delta: event.delta });
        }

        // 工具实时输出推送
        if (event.type === 'tool_output' && event.content) {
          broadcastToSession(runSessionId, {
            type: 'tool_output',
            toolCallId: event.toolCallId || '',
            toolName: event.toolName,
            content: event.content,
          });
        }

        // 收集工具调用记录
        if (event.type === 'tool_call' && event.toolName) {
          const detail = toolArgsDetailPreview(event.toolName, event.toolArgs);
          const callStatus = resolveToolCallInitialStatus(event.toolName, event.toolArgs);
          toolTraceBatch.push({
            toolName: event.toolName,
            detail: detail || '',
            status: callStatus,
            toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : '',
            diffSource: capToolTraceDiffSource(extractDiffSource(
              String(event.toolName),
              undefined,
              event.toolArgs as Record<string, unknown> | undefined,
            )),
          });
          const argsPreview = event.toolArgs ? JSON.stringify(event.toolArgs) : '';
          const truncated = argsPreview.length > 100 ? argsPreview.substring(0, 100) + '…' : argsPreview;
          console.log(`[step] [call] ${event.toolName}(${truncated})`);
        } else if (event.type === 'tool_result' && event.toolName) {
          const resultStatus = toolResultStatusPreview(
            event.toolName,
            event.toolSuccess,
            event.toolOutcome,
            event.toolOutput,
          );
          // 更新批次中最后一个匹配的工具状态
          for (let i = toolTraceBatch.length - 1; i >= 0; i--) {
            const row = toolTraceBatch[i];
            const idMatch = typeof event.toolCallId === 'string'
              && event.toolCallId
              && row.toolCallId === event.toolCallId;
            if (idMatch
              || (!event.toolCallId
                && row.toolName === event.toolName
                && (row.status === 'pending' || row.status === 'background'))) {
              toolTraceBatch[i].status = resultStatus;
              const fromOutput = extractDiffSource(
                String(event.toolName),
                typeof event.toolOutput === 'string' ? event.toolOutput : undefined,
                event.toolArgs as Record<string, unknown> | undefined,
              );
              if (fromOutput) {
                const capped = capToolTraceDiffSource(fromOutput);
                toolTraceBatch[i].diffSource = capped;
                recordPersistedToolTraceDiff(runSessionId, toolTraceBatch[i].toolCallId, capped);
              }
              break;
            }
          }
          const icon = resultStatus === 'error' ? '[err]' : resultStatus === 'background' ? '[bg]' : '[ok]';
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

    // 清空会话级 abort controller 和中断信号（仅当仍是本次运行登记的实例）
    if (sessionAbortControllers.get(runSessionId) === abortController) {
      sessionAbortControllers.delete(runSessionId);
    }
    llmAdapter.setAbortSignal?.(null);

    // 缓存完整的结构化消息历史并持久化到磁盘（写入本次运行锁定的 sessionId，
    // 即使用户在执行过程中切换了 activeSessionId，也确保历史归属正确的旧 session）
    setCachedMessages(runSessionId, result.messages);
    await flushStructuredSessionToDisk(SESSIONS_DIR, runSessionId, result.messages);
    saveStructuredMessages(result.messages, runSessionId);

    // 写入 AI 回复 + 工具调用记录到会话文件
    const agentMsgId = randomUUID();
    const sessionEntries: any[] = [];

    // write_file 输出常无 unified diff：从工作区合成并持久化索引，供历史区 F5 还原
    for (const trace of toolTraceBatch) {
      if (trace.toolName !== 'write_file' || trace.diffSource || !trace.toolCallId || !trace.detail) {
        continue;
      }
      const synthesized = await resolveToolDiffForSession({
        sessionsDir: SESSIONS_DIR,
        sessionId: runSessionId,
        defaultWorkDir: process.cwd(),
        toolCallId: trace.toolCallId,
        relPath: trace.detail,
        toolName: 'write_file',
      });
      if (!synthesized) continue;
      const capped = capToolTraceDiffSource(synthesized);
      trace.diffSource = capped;
      recordPersistedToolTraceDiff(runSessionId, trace.toolCallId, capped);
    }

    // 工具调用记录（role: 'tool_trace'，通过 parentId 关联到 agent 消息）
    for (const trace of toolTraceBatch) {
      const entry: Record<string, unknown> = {
        role: 'tool_trace',
        parentId: agentMsgId,
        toolName: trace.toolName,
        detail: trace.detail,
        status: trace.status,
        toolCallId: trace.toolCallId,
      };
      if (trace.diffSource) entry.diffSource = trace.diffSource;
      sessionEntries.push(entry as (typeof sessionEntries)[number]);
    }

    const turnTokenUsage = {
      inputTokens: result.loopState.totalInputTokens,
      outputTokens: result.loopState.totalOutputTokens,
    };

    // agent 消息（无文字但有工具时仍写入占位，避免孤儿 tool_trace）
    let turnAgentMsgId: string | undefined;
    if (result.content) {
      sessionEntries.push({ role: 'agent', content: result.content, id: agentMsgId, turnTokenUsage });
      turnAgentMsgId = agentMsgId;
    } else if (toolTraceBatch.length > 0) {
      sessionEntries.push({
        role: 'agent',
        content: '（本轮仅有工具调用，无文字回复）',
        id: agentMsgId,
        turnTokenUsage,
      });
      turnAgentMsgId = agentMsgId;
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
      ...buildTotalTokenUsageWithContext(result.messages, harnessConfig.context.tools ?? [], {
        lastInputTokens: result.loopState.lastInputTokens,
        lastOutputTokens: result.loopState.lastOutputTokens,
      }),
      totalInputTokens: result.loopState.totalInputTokens,
      totalOutputTokens: result.loopState.totalOutputTokens,
      ...(turnAgentMsgId ? { messageId: turnAgentMsgId } : {}),
    });
  } finally {
    clearInterval(pulseTimer);
    try {
      await finalizeIntentCheckpointTurn(SESSIONS_DIR, runSessionId, userMsgId);
    } catch (turnSnapErr) {
      console.error('[chat-ws] intent checkpoint turn snapshot finalize failed:', turnSnapErr);
    }
    if (sessionAbortControllers.get(runSessionId) === abortController) {
      sessionAbortControllers.delete(runSessionId);
    }
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
  if (bgTaskPusher) {
    bgTaskPusher.detach();
    bgTaskPusher = null;
  }
  for (const ctrl of sessionAbortControllers.values()) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  sessionAbortControllers.clear();
  sessionProcessing.clear();
  sessionPendingMessages.clear();
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
