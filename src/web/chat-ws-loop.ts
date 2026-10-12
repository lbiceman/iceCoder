/**
 * chat-ws 会话任务队列：入队、kickoff、串行 runSessionMessageLoop。
 */

import type { WebSocket } from 'ws';
import { formatFriendlyError } from '../cli/friendly-errors.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { MCPManager } from '../mcp/mcp-manager.js';
import type { StopReason } from '../harness/types.js';
import { parseReasoningEffort, type ReasoningEffort } from '../llm/reasoning-effort.js';
import {
  getTaskQueueManager,
  type QueuedTask,
  type TaskEnqueueInput,
} from '../session/task-queue.js';
import {
  describeScheduledTaskStop,
  notifyScheduledTaskResult,
} from '../session/scheduled-task-events.js';
import { applyFirstPromptSessionTitle } from './session-title.js';
import { buildUserMessageDisplayFields } from './user-message-display.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import {
  broadcastSessionRunState,
  broadcastSessionUpdated,
  broadcastToSession,
  pickSessionWs,
} from './chat-ws-broadcast.js';
import { appendMessages, broadcastHarnessState } from './chat-ws-persist.js';
import { hasBusySessionRun, ensureRunningTurn, clearRunningTurn } from './chat-ws-running-turn.js';
import {
  SESSIONS_DIR,
  beginSessionBatch,
  endSessionBatch,
  clearBackgroundWake,
  getSessionAgentSpawner,
  sessionBackgroundWakeTimers,
  sessionProcessing,
  setSessionRunPhase,
  type SessionRunPhase,
} from './chat-ws-runtime.js';
import { handleChatMessage } from './chat-ws-turn.js';
import { setSessionUnattended } from './chat-ws-confirm.js';

/** 后台子 Agent 完成后的唤醒轮询间隔。 */
const BACKGROUND_WAKE_INTERVAL_MS = 3_000;

/**
 * 后台子 Agent 完成后的续跑提示。不产生用户气泡（skipUserMessageAppend），
 * 只作为一次致动让主 Agent 继续；真正的报告由 Harness 轮次预处理注入。
 */
const BACKGROUND_CONTINUATION_TEXT =
  '[System] Background sub-agent results are ready. Review the injected reports and continue the task.';

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
  reasoningEffort?: ReasoningEffort;
  scheduledTaskId?: string;
  continuation?: boolean;
  ws: WebSocket;
}

export function queuedTaskToPending(task: QueuedTask, ws: WebSocket): PendingChatMessage {
  const reasoningEffort = parseReasoningEffort(task.reasoningEffort);
  return {
    content: task.text,
    images: task.images ?? [],
    referencePaths: task.referencePaths ?? [],
    messageId: task.messageId,
    source: task.source,
    skipUserMessageAppend: task.continuation === true
      || (task.source === 'implicit' && !!task.messageId),
    ws,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(task.scheduledTaskId ? { scheduledTaskId: task.scheduledTaskId } : {}),
    ...(task.continuation ? { continuation: true } : {}),
  };
}

/**
 * 定时任务触发的轮次进入无人值守（确认自动通过）；用户亲自发的消息退出无人值守。
 * 后台子 Agent 的续跑沿用上一轮的状态，让定时任务派生的子 Agent 也不被确认卡住。
 */
function applyUnattendedMode(runSid: string, pending: PendingChatMessage): void {
  if (pending.scheduledTaskId) setSessionUnattended(runSid, true);
  else if (!pending.continuation) setSessionUnattended(runSid, false);
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
    ...(display.planCommand ? { planCommand: display.planCommand } : {}),
    ...(display.openCommand ? { openCommand: display.openCommand } : {}),
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

const ERROR_LIKE_STOP = new Set<StopReason>([
  'error',
  'timeout',
  'circuit_breaker',
  'max_output_tokens',
  'max_rounds',
  'token_budget',
  'stop_hook',
]);

/**
 * 本轮已经收口、可以 dequeue 下一条的 stopReason。
 * ask 任务几乎总是 model_done；带写文件 / 后台命令的任务常被 D′ 收成
 * completion_paused（后台未退出、审批未决）或 completion_failed（写失败），
 * UI 仍会走「整理结论」并释放会话锁，这两类也必须接力，否则队列会卡住。
 * user_abort / user_checkpoint / 资源上限等仍按规格不自动接力。
 */
const QUEUE_RELAY_STOP = new Set<StopReason>([
  'model_done',
  'completion_paused',
  'completion_failed',
]);

function shouldRelayQueuedTask(stopReason?: StopReason): boolean {
  return !!stopReason && QUEUE_RELAY_STOP.has(stopReason);
}

function publishRunState(
  sessionId: string,
  phase: SessionRunPhase,
  stopReason?: StopReason,
): void {
  setSessionRunPhase(sessionId, phase, stopReason);
  broadcastSessionRunState({
    type: 'session_run_state',
    sessionId,
    phase,
    ...(stopReason ? { stopReason } : {}),
  });
}

function resolveTerminalPhase(stopReason?: StopReason): SessionRunPhase {
  if (stopReason === 'model_done' || stopReason === 'completion_paused') return 'done';
  if (stopReason === 'user_abort') return 'idle';
  if (stopReason === 'user_checkpoint') return 'running';
  if (!stopReason || ERROR_LIKE_STOP.has(stopReason)) return 'error';
  return 'error';
}

/**
 * 认领会话锁后再出队。必须在 `hasBusySessionRun` 判定之后同步 `sessionProcessing.add`，
 * 避免两个空闲 kickoff 同时 dequeue 开出两条 harness。
 */
async function claimNextQueuedTask(
  runSid: string,
  ws: WebSocket,
  announceQueued: boolean,
): Promise<PendingChatMessage | null> {
  if (hasBusySessionRun(runSid)) return null;
  sessionProcessing.add(runSid);
  const taskQueue = getTaskQueueManager(SESSIONS_DIR);
  let next: QueuedTask | undefined;
  try {
    next = await taskQueue.dequeue(runSid);
  } catch (err) {
    sessionProcessing.delete(runSid);
    throw err;
  }
  if (!next) {
    sessionProcessing.delete(runSid);
    return null;
  }
  await publishTaskQueueState(runSid);
  if (announceQueued) {
    broadcastToSession(runSid, {
      type: 'info',
      message: `📋 正在执行排队任务：${next.text}`,
    });
  }
  const relayWs = pickSessionWs(runSid, ws);
  const loopWs = relayWs ?? ws;
  return queuedTaskToPending(next, loopWs);
}

/**
 * 后台子 Agent 完成后的唤醒：会话空闲时投递一次续跑（无用户气泡），
 * 让主 Agent 收到注入的后台报告并继续。停止条件：无常驻后台工作、或结果已注入。
 */
function scheduleBackgroundWake(deps: ChatRunDeps, runSid: string, ws: WebSocket): void {
  const spawner = getSessionAgentSpawner(runSid);
  if (!spawner || !spawner.hasBackgroundWork()) return;
  if (sessionBackgroundWakeTimers.has(runSid)) return;

  const timer = setInterval(() => {
    const active = getSessionAgentSpawner(runSid);
    if (!active) {
      clearBackgroundWake(runSid);
      return;
    }
    // 会话忙碌（用户在跑别的任务）时让路，等空闲再投递。
    if (hasBusySessionRun(runSid) || sessionProcessing.has(runSid)) return;
    if (active.hasPendingBackgroundResults()) {
      clearBackgroundWake(runSid);
      void enqueueAndMaybeKickoff(deps, runSid, ws, {
        text: BACKGROUND_CONTINUATION_TEXT,
        source: 'implicit',
        continuation: true,
      });
      return;
    }
    if (!active.hasBackgroundWork()) clearBackgroundWake(runSid);
  }, BACKGROUND_WAKE_INTERVAL_MS);
  sessionBackgroundWakeTimers.set(runSid, timer);
}

async function tryKickoffSessionLoop(
  deps: ChatRunDeps,
  runSid: string,
  ws: WebSocket,
  announceQueued = false,
): Promise<boolean> {
  const next = await claimNextQueuedTask(runSid, ws, announceQueued);
  if (!next) return false;
  void runSessionMessageLoop(deps, runSid, next.ws, next);
  return true;
}

/**
 * 会话级运行循环：一次只跑一条。收口后（见 QUEUE_RELAY_STOP）释放锁再扫队列 kickoff 下一条。
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
  await tryKickoffSessionLoop(deps, runSid, ws);
}

export async function runSessionMessageLoop(
  deps: ChatRunDeps,
  runSid: string,
  ws: WebSocket,
  first: PendingChatMessage,
): Promise<void> {
  sessionProcessing.add(runSid);
  applyUnattendedMode(runSid, first);
  let terminalPhase: SessionRunPhase | null = null;
  let terminalReason: StopReason | undefined;
  let terminalError: string | undefined;
  try {
    publishRunState(runSid, 'running');
    beginSessionBatch(runSid);
    broadcastHarnessState(runSid);
    ensureRunningTurn(runSid);
    broadcastToSession(runSid, { type: 'status', status: 'processing' });
    let stopReason: StopReason | undefined;
    let finalContent: string | undefined;
    try {
      stopReason = await handleChatMessage({
        ws: first.ws,
        message: first.content,
        orchestrator: deps.orchestrator,
        toolRegistry: deps.toolRegistry,
        toolExecutor: deps.toolExecutor,
        images: first.images,
        referencePaths: first.referencePaths,
        clientMessageId: first.messageId ?? null,
        mcpManager: deps.mcpManager,
        runSessionId: runSid,
        skipUserMessageAppend: first.skipUserMessageAppend,
        source: first.source,
        reasoningEffort: first.reasoningEffort,
        ...(first.scheduledTaskId ? { onFinalContent: (content: string) => { finalContent = content; } } : {}),
      });
    } catch (err) {
      terminalError = formatFriendlyError(err);
      broadcastToSession(runSid, { type: 'error', message: terminalError });
      terminalPhase = 'error';
    } finally {
      endSessionBatch(runSid);
      broadcastHarnessState(runSid);
      broadcastToSession(runSid, { type: 'status', status: 'idle' });
      // handleChatMessage 若在自身 try/finally 之前抛错，这里兜底清 runningTurns，
      // 否则 hasBusySessionRun 会一直为 true，队列再也 kickoff 不了。
      clearRunningTurn(runSid);
    }

    if (terminalPhase === 'error') {
      // 已在 catch 里标记
    } else if (stopReason !== 'model_done') {
      terminalPhase = resolveTerminalPhase(stopReason);
      terminalReason = stopReason;
      if (stopReason === 'error' && finalContent?.trim()) terminalError = finalContent.trim();
    } else {
      terminalPhase = 'done';
      terminalReason = 'model_done';
    }
  } finally {
    sessionProcessing.delete(runSid);
    // user_checkpoint 的会话仍是 running（等人接管），但定时任务这一次已经结束，同样要回写。
    if (first.scheduledTaskId && terminalPhase) {
      await notifyScheduledTaskResult({
        taskId: first.scheduledTaskId,
        success: terminalPhase === 'done',
        error: terminalPhase === 'done' ? null : describeScheduledTaskStop(terminalReason, terminalError),
      });
    }
    // 只在循环结束后扫一次：漏网项和队列里的下一条走同一条 kickoff。
    let relayed = false;
    if (shouldRelayQueuedTask(terminalReason)) {
      const next = await claimNextQueuedTask(runSid, ws, true);
      if (next) {
        relayed = true;
        await runSessionMessageLoop(deps, runSid, next.ws, next);
      }
    }
    if (!relayed && terminalPhase && terminalPhase !== 'running') {
      publishRunState(runSid, terminalPhase, terminalReason);
    }
    // 有后台子 Agent 在跑或结果待注入：空闲后自动续跑。
    scheduleBackgroundWake(deps, runSid, ws);
  }
}
