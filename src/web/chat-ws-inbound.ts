/**
 * chat-ws 入站路由器：消化全部 msg.type（含 message 内 /also /shell /next /open）。
 */

import { promises as fsPromises } from 'node:fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  parseNextCommand,
  parseAlsoCommand,
  parseShellCommand,
  PENDING_NOTE_USAGE_MESSAGE,
  queueAlsoNote,
  clearPendingNotesForSession,
} from '../session/pending-note.js';
import { getTaskQueueManager } from '../session/task-queue.js';
import { clearSessionBgTasks } from '../session/bg-tasks-store.js';
import { persistLastActiveSessionId } from './last-active-session.js';
import { updateSessionMetadataAfterMessageDelete } from './session-title.js';
import { writeStructuredMessagesFile } from './session-structured-io.js';
import { resetSupervisorRuntimeCache } from '../harness/supervisor/supervisor-runtime-cache.js';
import { clearHarnessRuntimeState } from '../harness/harness-runtime-registry.js';
import { loadCheckpointMessageIds } from '../harness/intent-checkpoint-store.js';
import {
  getRuntimeRestoreCoordinator,
  RestoreFailedError,
  RestoreNotAllowedError,
} from '../harness/runtime-restore-coordinator.js';
import {
  deleteUserMessageConversation,
  DeleteMessageNotFoundError,
} from '../harness/conversation-delete.js';
import { canAcceptRuntimeRestore } from './session-runtime-busy.js';
import { resolveShellCollabActive } from '../session/shell-collab-store.js';
import {
  stopAllShellWorkForSession,
  stopForegroundShellWorkForSession,
} from '../tools/session-shell-control.js';
import type { UnifiedMessage } from '../llm/types.js';
import { parseClientMessageId, isOpenLegacyCommand } from './chat-ws-helpers.js';
import { handleBgTaskStop, rebindBgTaskPusher, unwireBgTasksDiskSync, buildBgTasksForSession } from './chat-ws-bg-tasks.js';
import {
  broadcastSessionUpdated,
  broadcastToSession,
  getSubscribedSessionId,
  sendJSON,
  subscribeWsToSession,
} from './chat-ws-broadcast.js';
import { handleConfirmReply } from './chat-ws-confirm.js';
import {
  appendMessages,
  broadcastHarnessState,
  buildEnqueueInput,
  flushStructuredMessagesNow,
  loadStructuredMessages,
} from './chat-ws-persist.js';
import { handleShellCollabRoute, queueShellCollabTransition, waitForShellCollabTransition } from './chat-ws-shell.js';
import {
  clearRunningTurn,
  getRunningTurn,
  snapshotRunningTurn,
} from './chat-ws-running-turn.js';
import {
  DEFAULT_WORK_DIR,
  SESSIONS_DIR,
  abortSession,
  getActiveSessionId,
  getCachedMessages,
  getSupervisorRuntime,
  hasActiveSessionRun,
  isSessionProcessing,
  resolveSessionWorkspacePayload,
  sessionProcessing,
  setActiveSessionId,
  setCachedMessages,
} from './chat-ws-runtime.js';
import {
  enqueueAndMaybeKickoff,
  persistImplicitQueuedUserMessage,
  runSessionMessageLoop,
  type ChatRunDeps,
  type PendingChatMessage,
} from './chat-ws-loop.js';

const NEXT_USAGE_MESSAGE = '用法: /next <任务描述>';

export function createInboundMessageHandler(deps: ChatRunDeps) {
  return async function handleInboundMessage(ws: WebSocket, data: WebSocket.RawData): Promise<void> {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'ping') {
        sendJSON(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'clear_session') {
        const sid = getSubscribedSessionId(ws) || getActiveSessionId();
        try {
          stopAllShellWorkForSession(sid, 'clear_session');
          abortSession(sid);
          sessionProcessing.delete(sid);
          clearRunningTurn(sid);
          setCachedMessages(sid, []);
          await writeStructuredMessagesFile(SESSIONS_DIR, sid, []);
          await fsPromises.writeFile(
            path.join(SESSIONS_DIR, `${sid}.json`),
            '[]',
            'utf-8',
          );
          await getTaskQueueManager(SESSIONS_DIR).clearSession(sid);
          clearPendingNotesForSession(sid);
          await clearSessionBgTasks(SESSIONS_DIR, sid);
          unwireBgTasksDiskSync(sid);
          sendJSON(ws, { type: 'session_cleared', ok: true, sessionId: sid, bgTasks: [] });
        } catch (err) {
          console.error('[chat-ws] clear_session failed:', err);
          sendJSON(ws, {
            type: 'session_cleared',
            ok: false,
            sessionId: sid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      if (msg.type === 'confirm_reply') {
        const cid = typeof msg.confirmId === 'string' ? msg.confirmId : '';
        const subscribedSid = getSubscribedSessionId(ws) || getActiveSessionId();
        handleConfirmReply(cid, !!msg.approved, subscribedSid);
        return;
      }

      if (msg.type === 'stop') {
        const sid = getSubscribedSessionId(ws) || getActiveSessionId();
        stopForegroundShellWorkForSession(sid, 'chat stop');
        if (abortSession(sid)) {
          console.log(`[chat-ws] 用户请求中断任务 session=${sid}`);
        }
        return;
      }

      if (msg.type === 'bg_task_stop') {
        const taskId = typeof msg.taskId === 'string' ? msg.taskId.trim() : '';
        await handleBgTaskStop(ws, taskId, getActiveSessionId());
        return;
      }

      if (msg.type === 'restore_runtime') {
        const messageId = typeof msg.messageId === 'string' ? msg.messageId.trim() : '';
        const sid = getSubscribedSessionId(ws) || getActiveSessionId();
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
        console.log(`[chat-ws] restore_runtime session=${sid} messageId=${messageId}`);
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
        const sid = getSubscribedSessionId(ws) || getActiveSessionId();
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
          await flushStructuredMessagesNow(sid);
          const deletion = await deleteUserMessageConversation({
            sessionDir: SESSIONS_DIR,
            sessionId: sid,
            messageId,
            getStructuredMessages: () => getCachedMessages(sid),
            setStructuredMessages: (m) => setCachedMessages(sid, m),
          });
          clearHarnessRuntimeState(sid);
          let updatedTitle: string | null = null;
          try {
            updatedTitle = await updateSessionMetadataAfterMessageDelete(sid, {
              deletedPrompt: deletion.deletedUserContent,
              firstRemainingPrompt: deletion.firstRemainingUserContent,
              remainingUserCount: deletion.remainingUserCount,
            });
          } catch (metadataErr) {
            console.warn('[chat-ws] 删除后同步会话元数据失败:', metadataErr);
          }
          broadcastToSession(sid, {
            type: 'message_deleted',
            sessionId: sid,
            messageId,
            checkpointMessageIds: await loadCheckpointMessageIds(SESSIONS_DIR, sid),
          });
          broadcastHarnessState(sid);
          broadcastSessionUpdated(
            'message_deleted',
            updatedTitle ? { sessionId: sid, title: updatedTitle } : { sessionId: sid },
            ws,
          );
        } catch (err) {
          const message = err instanceof DeleteMessageNotFoundError
            ? err.message
            : '删除消息失败，请稍后重试。';
          console.error('[chat-ws] delete_user_message failed:', err);
          sendJSON(ws, {
            type: 'delete_message_failed',
            error: message,
            ...(err instanceof DeleteMessageNotFoundError ? { code: err.code } : {}),
          });
        }
        return;
      }

      if (msg.type === 'switch_session') {
        const targetId = String(msg.sessionId || '');
        if (!targetId || targetId === getActiveSessionId()) {
          sendJSON(ws, { type: 'session_switched', ok: true, sessionId: getActiveSessionId() });
          return;
        }
        const leavingSessionId = getSubscribedSessionId(ws) || getActiveSessionId();
        const shouldStopLeavingShells = hasActiveSessionRun(leavingSessionId);
        if (shouldStopLeavingShells) {
          stopForegroundShellWorkForSession(leavingSessionId, 'session switch');
        }
        if (abortSession(leavingSessionId)) {
          console.log(`[chat-ws] switch_session 时中断会话 ${leavingSessionId} 的任务`);
        }
        const oldSessionId = getActiveSessionId();
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
          setActiveSessionId(targetId);
          void persistLastActiveSessionId(targetId);
          let loaded: UnifiedMessage[] | undefined;
          try {
            loaded = await loadStructuredMessages(getActiveSessionId());
          } catch (loadErr) {
            console.warn('[chat-ws] switch_session load structured failed, starting empty:', loadErr);
            loaded = undefined;
          }
          setCachedMessages(getActiveSessionId(), loaded ?? []);
          subscribeWsToSession(ws, getActiveSessionId());
          try {
            await rebindBgTaskPusher(getActiveSessionId());
          } catch (rebindErr) {
            console.warn('[chat-ws] switch_session rebind bg task failed:', rebindErr);
          }
          const newRunningTurn = snapshotRunningTurn(getActiveSessionId());
          const workspace = await resolveSessionWorkspacePayload(getActiveSessionId());
          const bgTasks = await buildBgTasksForSession(getActiveSessionId());
          const shellCollabActive = await resolveShellCollabActive(getActiveSessionId(), SESSIONS_DIR);
          sendJSON(ws, {
            type: 'session_switched',
            ok: true,
            sessionId: getActiveSessionId(),
            shellCollabActive,
            ...workspace,
            ...(supervisorResetFailed ? { reason: 'supervisor_reset_failed' } : {}),
            ...(newRunningTurn ? { runningTurn: newRunningTurn } : {}),
            bgTasks,
          });
          console.log(`[chat-ws] 切换到会话 ${getActiveSessionId()}`);
        } catch (err) {
          setActiveSessionId(oldSessionId);
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
        const runSid = getSubscribedSessionId(ws) || getActiveSessionId();
        const content = typeof msg.content === 'string' ? msg.content : '';
        const images = Array.isArray(msg.images) ? msg.images : [];
        const referencePaths = Array.isArray(msg.referencePaths)
          ? msg.referencePaths.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
          : [];
        const skills = Array.isArray(msg.skills)
          ? msg.skills.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
          : [];
        const messageId = parseClientMessageId(msg.messageId) ?? undefined;
        const queueInsertIndex = typeof msg.queueInsertIndex === 'number'
          ? msg.queueInsertIndex
          : undefined;
        const hasAttachments = images.length > 0;

        const alsoCmd = parseAlsoCommand(content);
        if (alsoCmd.matched) {
          if (!alsoCmd.text) {
            sendJSON(ws, { type: 'info', message: PENDING_NOTE_USAGE_MESSAGE });
            return;
          }
          const runningTurn = getRunningTurn(runSid);
          if (!runningTurn) {
            sendJSON(ws, {
              type: 'also_rejected',
              sessionId: runSid,
              message: '当前没有运行中的任务，/also 只对当前任务的下一轮 LLM 调用生效',
            });
            return;
          }
          const alsoMessageId = messageId ?? randomUUID();
          const sentAt = Date.now();
          queueAlsoNote(runSid, {
            text: alsoCmd.text,
            runId: runningTurn.runId,
            messageId: alsoMessageId,
          });
          const uiMessage = {
            role: 'user',
            content: alsoCmd.text,
            id: alsoMessageId,
            alsoNote: true,
            sentAt,
          };
          void appendMessages([uiMessage], runSid);
          console.log(`[chat-ws] /also 备注已入队 session=${runSid.slice(0, 8)} note="${alsoCmd.text.slice(0, 60)}"`);
          broadcastToSession(runSid, {
            type: 'also_note_appended',
            sessionId: runSid,
            message: uiMessage,
          });
          return;
        }

        const shellCmd = parseShellCommand(content);
        if (shellCmd.matched && shellCmd.action) {
          const shellMessageId = messageId ?? randomUUID();
          let shellRouteOk = false;
          await queueShellCollabTransition(runSid, async () => {
            shellRouteOk = await handleShellCollabRoute(
              ws,
              runSid,
              shellCmd.action!,
              content,
              shellMessageId,
              shellCmd.prompt,
              referencePaths,
              skills,
              images,
            );
          });
          if (shellRouteOk && shellCmd.action === 'enter' && shellCmd.prompt.trim()) {
            const taskInput = await buildEnqueueInput(
              runSid,
              shellCmd.prompt,
              images,
              referencePaths,
              shellMessageId,
              'implicit',
              skills,
            );
            await enqueueAndMaybeKickoff(deps, runSid, ws, taskInput, queueInsertIndex);
          }
          return;
        }
        await waitForShellCollabTransition(runSid);

        if (isOpenLegacyCommand(content)) {
          if (isSessionProcessing(runSid)) {
            sendJSON(ws, { type: 'info', message: '当前有任务进行中，请稍后再试 /open' });
            return;
          }
          const direct: PendingChatMessage = {
            content,
            images,
            referencePaths,
            messageId,
            source: 'implicit',
            ws,
          };
          void runSessionMessageLoop(deps, runSid, ws, direct);
          return;
        }

        const requestedSource = msg.source === 'explicit' || msg.command === 'next' ? 'explicit' : undefined;
        const nextCmd = parseNextCommand(content);
        const isExplicitNext = requestedSource === 'explicit' || nextCmd.matched;
        const taskText = nextCmd.matched ? nextCmd.text : content;
        if (isExplicitNext && !taskText.trim() && !hasAttachments) {
          sendJSON(ws, { type: 'info', message: NEXT_USAGE_MESSAGE });
          return;
        }
        if (!taskText.trim() && !hasAttachments) {
          return;
        }

        const taskInput = await buildEnqueueInput(
          runSid,
          taskText,
          images,
          referencePaths,
          messageId,
          isExplicitNext ? 'explicit' : 'implicit',
          skills,
        );
        await persistImplicitQueuedUserMessage(runSid, ws, taskInput);
        await enqueueAndMaybeKickoff(deps, runSid, ws, taskInput, queueInsertIndex);
      }
    } catch {
      sendJSON(ws, { type: 'error', message: '消息格式错误' });
    }
  };
}
