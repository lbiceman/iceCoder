/**
 * chat-ws 会话任务队列：入队、kickoff、串行 runSessionMessageLoop。
 */

import type { WebSocket } from 'ws';
import { formatFriendlyError } from '../cli/friendly-errors.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { MCPManager } from '../mcp/mcp-manager.js';
import type { StopReason } from '../harness/types.js';
import {
  getTaskQueueManager,
  type QueuedTask,
  type TaskEnqueueInput,
} from '../session/task-queue.js';
import { persistLastActiveSessionId } from './last-active-session.js';
import { applyFirstPromptSessionTitle } from './session-title.js';
import { buildUserMessageDisplayFields } from './user-message-display.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import {
  broadcastSessionUpdated,
  broadcastToSession,
  pickSessionWs,
} from './chat-ws-broadcast.js';
import { appendMessages, broadcastHarnessState } from './chat-ws-persist.js';
import { hasBusySessionRun, ensureRunningTurn } from './chat-ws-running-turn.js';
import {
  SESSIONS_DIR,
  beginSessionBatch,
  endSessionBatch,
  sessionProcessing,
} from './chat-ws-runtime.js';
import { handleChatMessage } from './chat-ws-turn.js';

export interface ChatRunDeps {
  orchestrator: Orchestrator;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutor;
  mcpManager?: MCPManager;
}

export interface PendingChatMessage {
  content: string;
  images: string[];
  referencePaths: string[];
  messageId?: string;
  source: 'implicit' | 'explicit';
  skipUserMessageAppend?: boolean;
  ws: WebSocket;
}

export function queuedTaskToPending(task: QueuedTask, ws: WebSocket): PendingChatMessage {
  return {
    content: task.text,
    images: task.images ?? [],
    referencePaths: task.referencePaths ?? [],
    messageId: task.messageId,
    source: task.source,
    skipUserMessageAppend: task.source === 'implicit' && !!task.messageId,
    ws,
  };
}

export async function publishTaskQueueState(sessionId: string): Promise<void> {
  const items = await getTaskQueueManager(SESSIONS_DIR).list(sessionId);
  broadcastToSession(sessionId, { type: 'task_queue_updated', sessionId, items });
}

export async function notifyTaskQueueUpdated(sessionId: string): Promise<void> {
  await publishTaskQueueState(sessionId);
}

export async function persistImplicitQueuedUserMessage(
  sessionId: string,
  ws: WebSocket,
  taskInput: TaskEnqueueInput,
): Promise<void> {
  if (taskInput.source !== 'implicit' || !taskInput.messageId) return;
  const display = buildUserMessageDisplayFields(
    taskInput.text,
    taskInput.referencePaths ?? [],
    taskInput.skills ?? [],
  );
  const message = {
    role: 'user',
    id: taskInput.messageId,
    content: display.content,
    ...(display.shellCommand ? { shellCommand: display.shellCommand } : {}),
    ...(display.skills ? { skills: display.skills } : {}),
    ...(display.referencePaths ? { referencePaths: display.referencePaths } : {}),
    ...(taskInput.images && taskInput.images.length > 0 ? { images: taskInput.images } : {}),
  };
  const persisted = await appendMessages([message], sessionId);
  if (!persisted) return;
  const autoTitle = await applyFirstPromptSessionTitle(sessionId, display.content || taskInput.text);
  broadcastSessionUpdated(
    'user_message',
    autoTitle ? { sessionId, title: autoTitle } : { sessionId },
    ws,
  );
  broadcastToSession(sessionId, {
    type: 'user_message_appended',
    sessionId,
    message,
  });
}

/**
 * 会话级运行循环：串行处理同一会话的任务队列。
 * 通过 `sessionProcessing` 防止同一会话被多个连接并发跑两个 harness（P1-9）。
 */
export async function enqueueAndMaybeKickoff(
  deps: ChatRunDeps,
  runSid: string,
  ws: WebSocket,
  taskInput: TaskEnqueueInput,
  queueInsertIndex?: number,
): Promise<void> {
  const taskQueue = getTaskQueueManager(SESSIONS_DIR);
  if (queueInsertIndex !== undefined) {
    await taskQueue.insertAt(runSid, queueInsertIndex, taskInput);
  } else {
    await taskQueue.enqueue(runSid, taskInput);
  }
  await publishTaskQueueState(runSid);

  if (!hasBusySessionRun(runSid)) {
    const next = await taskQueue.dequeue(runSid);
    await publishTaskQueueState(runSid);
    if (next) {
      const relayWs = pickSessionWs(runSid, ws);
      if (relayWs) {
        void runSessionMessageLoop(deps, runSid, relayWs, queuedTaskToPending(next, relayWs));
      }
    }
  }
}

export async function runSessionMessageLoop(
  deps: ChatRunDeps,
  runSid: string,
  ws: WebSocket,
  first: PendingChatMessage,
): Promise<void> {
  sessionProcessing.add(runSid);
  const taskQueue = getTaskQueueManager(SESSIONS_DIR);
  try {
    let current: PendingChatMessage | undefined = first;
    while (current) {
      void persistLastActiveSessionId(runSid);
      beginSessionBatch(runSid);
      broadcastHarnessState(runSid);
      ensureRunningTurn(runSid);
      broadcastToSession(runSid, { type: 'status', status: 'processing' });
      let stopReason: StopReason | undefined;
      try {
        stopReason = await handleChatMessage({
          ws: current.ws,
          message: current.content,
          orchestrator: deps.orchestrator,
          toolRegistry: deps.toolRegistry,
          toolExecutor: deps.toolExecutor,
          images: current.images,
          referencePaths: current.referencePaths,
          clientMessageId: current.messageId ?? null,
          mcpManager: deps.mcpManager,
          runSessionId: runSid,
          skipUserMessageAppend: current.skipUserMessageAppend,
          source: current.source,
        });
      } catch (err) {
        broadcastToSession(runSid, { type: 'error', message: formatFriendlyError(err) });
        break;
      } finally {
        endSessionBatch(runSid);
        broadcastHarnessState(runSid);
        broadcastToSession(runSid, { type: 'status', status: 'idle' });
      }

      if (stopReason !== 'model_done') {
        break;
      }

      const nextQueued = await taskQueue.dequeue(runSid);
      if (!nextQueued) break;

      await publishTaskQueueState(runSid);
      if (nextQueued.source === 'explicit') {
        broadcastToSession(runSid, {
          type: 'info',
          message: `📋 正在执行排队任务：${nextQueued.text}`,
        });
      }

      const relayWs = pickSessionWs(runSid, ws) ?? current.ws;
      current = queuedTaskToPending(nextQueued, relayWs);
    }
  } finally {
    sessionProcessing.delete(runSid);
  }
}
