/**
 * chat-ws 会话持久化：structured 缓存刷盘、UI 消息追加、记忆初始化。
 */

import { promises as fsPromises } from 'node:fs';
import { finalizeMessagesForApi } from '../harness/context-assembler.js';
import {
  loadCheckpointIndex,
  loadCheckpointMessageIds,
  loadIntentCheckpoint,
} from '../harness/intent-checkpoint-store.js';
import { getHarnessRuntimeState } from '../harness/harness-runtime-registry.js';
import { persistLastActiveSessionId } from './last-active-session.js';
import { canAcceptRuntimeRestore } from './session-runtime-busy.js';
import {
  flushStructuredSessionToDisk,
  readStructuredMessagesFile,
  writeStructuredMessagesFile,
} from './session-structured-io.js';
import { createFileMemoryManager } from '../memory/file-memory/file-memory-manager.js';
import type { UnifiedMessage } from '../llm/types.js';
import type { AssembledPrompt } from '../prompts/types.js';
import type { TaskEnqueueInput } from '../session/task-queue.js';
import { resolveFileReferences } from './routes/upload.js';
import {
  persistInlineImages,
  persistUploadedImageFiles,
  buildSessionImageApiUrl,
} from './images-cache.js';
import { isSessionImageApiUrl } from './chat-ws-helpers.js';
import {
  getOrLoadAssembledChatPrompt,
  prewarmChatRuntime,
} from './chat-ws-prewarm.js';
import { bootstrapActiveSessionIdFromIndex } from './routes/sessions.js';
import { resetSupervisorRuntimeCache } from '../harness/supervisor/supervisor-runtime-cache.js';
import {
  MEMORY_DIR,
  SESSIONS_DIR,
  getActiveSessionId,
  getCachedMessages,
  getSessionFile,
  getSupervisorRuntime,
  isSessionTombstoned,
  saveTimerMap,
  setActiveSessionId,
  setCachedMessages,
  structuredCache,
} from './chat-ws-runtime.js';
import { broadcastToSession } from './chat-ws-broadcast.js';
import { rebindBgTaskPusher } from './chat-ws-bg-tasks.js';

export async function buildConnectedPayloadExtras(sessionId: string): Promise<{
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

export function broadcastHarnessState(sessionId: string): void {
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

/** 立即将指定 session 的结构化缓存写入磁盘（switch_session 前须 await） */
export async function flushStructuredMessagesNow(sessionId: string): Promise<void> {
  if (isSessionTombstoned(sessionId)) return;
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

export function saveStructuredMessages(messages: UnifiedMessage[], sessionId?: string): void {
  const id = sessionId || getActiveSessionId();
  if (isSessionTombstoned(id)) return;
  structuredCache.set(id, messages);
  const existing = saveTimerMap.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    if (isSessionTombstoned(id)) return;
    try {
      await writeStructuredMessagesFile(SESSIONS_DIR, id, messages);
    } catch (err) {
      console.error('[chat-ws] 保存结构化消息失败:', err);
    }
  }, 1000);
  saveTimerMap.set(id, timer);
}

/** 从磁盘加载结构化消息（启动时调用一次） */
export async function loadStructuredMessages(sessionId?: string): Promise<UnifiedMessage[] | undefined> {
  const id = sessionId || getActiveSessionId();
  const parsed = await readStructuredMessagesFile(SESSIONS_DIR, id);
  if (parsed && parsed.length > 0) {
    const repaired = finalizeMessagesForApi(parsed);
    console.log(`[chat-ws] 恢复 ${repaired.length} 条结构化消息`);
    return repaired;
  }
  return undefined;
}

/** 移动端扫码连入：将全局 activeSessionId 对齐到 QR 绑定的聊天 session */
export async function ensureGlobalActiveSessionId(targetId: string): Promise<void> {
  if (!targetId || targetId === getActiveSessionId()) return;
  const oldSessionId = getActiveSessionId();
  try {
    await flushStructuredMessagesNow(oldSessionId);
    setActiveSessionId(targetId);
    void persistLastActiveSessionId(targetId);
    let loaded: UnifiedMessage[] | undefined;
    try {
      loaded = await loadStructuredMessages(getActiveSessionId());
    } catch (loadErr) {
      console.warn('[chat-ws] remote join load structured failed, starting empty:', loadErr);
      loaded = undefined;
    }
    setCachedMessages(getActiveSessionId(), loaded ?? []);
    try {
      resetSupervisorRuntimeCache();
    } catch (err) {
      console.warn('[chat-ws] supervisor reset on remote join failed:', err);
    }
    try {
      await rebindBgTaskPusher(getActiveSessionId());
    } catch (rebindErr) {
      console.warn('[chat-ws] remote join rebind bg task failed:', rebindErr);
    }
    console.log(`[chat-ws] 远程扫码对齐会话 ${getActiveSessionId()}`);
  } catch (err) {
    setActiveSessionId(oldSessionId);
    console.error('[chat-ws] remote join session align failed:', err);
  }
}

let activeSessionBootstrapPromise: Promise<void> | null = null;

/** 冷启动：选中 index 中 updatedAt 最近的会话，并预载 structured 缓存。 */
export async function ensureActiveSessionBootstrapped(): Promise<void> {
  if (activeSessionBootstrapPromise) return activeSessionBootstrapPromise;
  activeSessionBootstrapPromise = (async () => {
    try {
      const id = await bootstrapActiveSessionIdFromIndex();
      if (id) {
        setActiveSessionId(id);
        void persistLastActiveSessionId(id);
      }
      const sid = getActiveSessionId();
      if (!getCachedMessages(sid)) {
        const loaded = await loadStructuredMessages(sid);
        setCachedMessages(sid, loaded ?? []);
      }
      console.log(`[chat-ws] 活跃会话: ${sid}`);
    } catch (err) {
      console.warn('[chat-ws] 启动会话 bootstrap 失败:', err);
    }
  })();
  return activeSessionBootstrapPromise;
}

/**
 * 全局记忆系统实例（进程级单例）。
 * 记忆系统在进程启动时初始化一次，所有会话共享。
 */
let globalFileMemoryManager: ReturnType<typeof createFileMemoryManager> | null = null;
let memoryInitialized = false;

export function getGlobalFileMemoryManager(): ReturnType<typeof createFileMemoryManager> | null {
  return globalFileMemoryManager;
}

export async function ensureMemoryInitialized(): Promise<void> {
  if (memoryInitialized) return;

  try {
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

  const sid = getActiveSessionId();
  if (!getCachedMessages(sid)) {
    const loaded = await loadStructuredMessages(sid);
    setCachedMessages(sid, loaded);
  }

  memoryInitialized = true;
}

export async function loadAssembledPrompt(): Promise<AssembledPrompt> {
  return getOrLoadAssembledChatPrompt('[chat-ws]');
}

export function startChatRuntimePrewarm(): void {
  prewarmChatRuntime({
    ensureMemoryInitialized,
    getSupervisorRuntime,
    loadAssembledPrompt,
  });
}

export type AppendableSessionMessage = {
  role: string;
  content?: string;
  id?: string;
  parentId?: string;
  toolName?: string;
  detail?: string;
  status?: string;
  toolCallId?: string;
  images?: string[];
  skills?: string[];
  referencePaths?: string[];
  shellCommand?: string;
  alsoNote?: boolean;
  sentAt?: number;
  completedAt?: number;
  turnTokenUsage?: { inputTokens: number; outputTokens: number };
  diffSource?: string | null;
};

/**
 * 追加消息到指定会话的消息文件。
 *
 * `sessionId` 必须由调用方传入（通常是 handleChatMessage 启动时锁定的 `runSessionId`），
 * 这样即使用户在长任务中途切换 session，旧任务的 cleanup 仍写入正确的旧 session 文件。
 */
export async function appendMessages(
  msgs: AppendableSessionMessage[],
  sessionId: string = getActiveSessionId(),
): Promise<boolean> {
  if (isSessionTombstoned(sessionId)) return true;
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
    for (const msg of stamped) {
      const existingIndex = typeof msg.id === 'string' && msg.id
        ? existing.findIndex((item) => item && item.id === msg.id)
        : -1;
      if (existingIndex >= 0) {
        const prev = existing[existingIndex] as Record<string, unknown>;
        const incoming = msg as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...prev, ...incoming };
        if (!Array.isArray(incoming.referencePaths) || incoming.referencePaths.length === 0) {
          if (Array.isArray(prev.referencePaths) && prev.referencePaths.length > 0) {
            merged.referencePaths = prev.referencePaths;
          }
        }
        if (!Array.isArray(incoming.skills) || incoming.skills.length === 0) {
          if (Array.isArray(prev.skills) && prev.skills.length > 0) {
            merged.skills = prev.skills;
          }
        }
        if (!incoming.shellCommand && prev.shellCommand) {
          merged.shellCommand = prev.shellCommand;
        }
        existing[existingIndex] = merged;
      } else {
        existing.push(msg);
      }
    }
    await fsPromises.writeFile(file, JSON.stringify(existing), 'utf-8');
    return true;
  } catch (err) {
    console.error('[chat-ws] appendMessages failed:', err);
    return false;
  }
}

export async function getPriorTrackedPaths(sessionId: string): Promise<string[]> {
  const index = await loadCheckpointIndex(SESSIONS_DIR, sessionId);
  if (!index.cursorMessageId) return [];
  const archive = await loadIntentCheckpoint(SESSIONS_DIR, sessionId, index.cursorMessageId);
  return archive?.trackedPaths ?? [];
}

export function dropPersistCache(sessionId: string): void {
  setCachedMessages(sessionId, undefined);
}

export async function buildEnqueueInput(
  sessionId: string,
  content: string,
  images: string[],
  referencePaths: string[],
  messageId: string | undefined,
  source: 'implicit' | 'explicit',
  skills: string[] = [],
): Promise<TaskEnqueueInput> {
  const persistedInline = await persistInlineImages(
    images.filter((img) => !isSessionImageApiUrl(img)),
    sessionId,
  );
  const { imageUrls } = resolveFileReferences(content);
  const persistedUploads = await persistUploadedImageFiles(imageUrls, sessionId);
  const uiImageUrls = [...persistedInline, ...persistedUploads].map((p) =>
    buildSessionImageApiUrl(sessionId, p.absolutePath),
  );
  const storedApiUrls = images.filter((img) => isSessionImageApiUrl(img));
  const allImages = [...storedApiUrls, ...uiImageUrls];
  return {
    text: content,
    source,
    messageId,
    images: allImages.length > 0 ? allImages : undefined,
    referencePaths: referencePaths.length > 0 ? referencePaths : undefined,
    skills: skills.length > 0 ? skills : undefined,
  };
}
