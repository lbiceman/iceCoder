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
  broadcastSessionRunState,
  broadcastSessionUpdated,
  broadcastToSession,
  getSubscribedSessionId,
  sendJSON,
  subscribeWsToSession,
} from './chat-ws-broadcast.js';
import { handleConfirmReply, replayPendingConfirmsToWs } from './chat-ws-confirm.js';
import {
  appendMessages,
  broadcastHarnessState,
  buildConnectedPayloadExtras,
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
  isSessionProcessing,
  resolveSessionWorkspacePayload,
  sessionProcessing,
  setActiveSessionId,
  setCachedMessages,
  setSessionRunPhase,
  getSessionRunPhase,
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

      if (msg.type === 'ack_session_run') {
        const sid = getSubscribedSessionId(ws);
        if (!sid) return;
        const target = typeof msg.sessionId === 'string' && msg.sessionId.trim()
          ? msg.sessionId.trim()
          : sid;
        if (target !== sid) return;
        const phase = getSessionRunPhase(target);
        if (phase !== 'done' && phase !== 'error') return;
        setSessionRunPhase(target, 'idle');
        broadcastSessionRunState({ type: 'session_run_state', sessionId: target, phase: 'idle' });
        return;
      }

      if (msg.type === 'clear_session') {
        const sid = getSubscribedSessionId(ws);
        if (!sid) {
          sendJSON(ws, { type: 'session_cleared', ok: false, error: '未订阅会话' });
          return;
        }
        try {
          stopAllShellWorkForSession(sid, 'clear_session');
          abortSession(sid);
          sessionProcessing.delete(sid);
          setSessionRunPhase(sid, 'idle');
          broadcastSessionRunState({ type: 'session_run_state', sessionId: sid, phase: 'idle' });
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
        const subscribedSid = getSubscribedSessionId(ws);
        if (!subscribedSid) return;
        handleConfirmReply(cid, !!msg.approved, subscribedSid);
        return;
      }

      if (msg.type === 'stop') {
        const sid = getSubscribedSessionId(ws);
        if (!sid) return;
        stopForegroundShellWorkForSession(sid, 'chat stop');
        if (abortSession(sid)) {
          console.log(`[chat-ws] 用户请求中断任务 session=${sid}`);
        }
        return;
      }

      if (msg.type === 'bg_task_stop') {
        const taskId = typeof msg.taskId === 'string' ? msg.taskId.trim() : '';
        await handleBgTaskStop(ws, taskId);
        return;
      }

      if (msg.type === 'restore_runtime') {
        const messageId = typeof msg.messageId === 'string' ? msg.messageId.trim() : '';
        if (!messageId) {
          sendJSON(ws, { type: 'restore_failed', error: '缺少 messageId。' });
          return;
        }
        const sid = getSubscribedSessionId(ws);
        if (!sid) {
          sendJSON(ws, { type: 'restore_failed', error: '未订阅会话' });
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
          const result = await getRuntimeRestoreCoordinator().restore({
            sessionDir: SESSIONS_DIR,
            sessionId: sid,
            messageId,
            defaultWorkDir: DEFAULT_WORK_DIR,
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
        if (!messageId) {
          sendJSON(ws, { type: 'delete_message_failed', error: '缺少 messageId。' });
          return;
        }
        const sid = getSubscribedSessionId(ws);
        if (!sid) {
          sendJSON(ws, { type: 'delete_message_failed', error: '未订阅会话' });
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
        const subscribedId = getSubscribedSessionId(ws);
        if (!targetId || targetId === subscribedId) {
          sendJSON(ws, { type: 'session_switched', ok: true, sessionId: subscribedId || getActiveSessionId() });
          return;
        }
        const leavingSessionId = subscribedId;
        const prevFocused = getActiveSessionId();
        try {
          if (leavingSessionId) {
            await flushStructuredMessagesNow(leavingSessionId);
          }
        } catch (err) {
          console.error('[chat-ws] switch_session flush failed:', err);
          sendJSON(ws, {
            type: 'session_switched',
            ok: false,
            reason: 'flush_failed',
            sessionId: leavingSessionId || prevFocused,
          });
          return;
        }
        try {
          setActiveSessionId(targetId);
          void persistLastActiveSessionId(targetId);
          let loaded: UnifiedMessage[] | undefined;
          try {
            loaded = await loadStructuredMessages(targetId);
          } catch (loadErr) {
            console.warn('[chat-ws] switch_session load structured failed, starting empty:', loadErr);
            loaded = undefined;
          }
          setCachedMessages(targetId, loaded ?? []);
          subscribeWsToSession(ws, targetId);
          try {
            await rebindBgTaskPusher(targetId);
          } catch (rebindErr) {
            console.warn('[chat-ws] switch_session rebind bg task failed:', rebindErr);
          }
          const newRunningTurn = snapshotRunningTurn(targetId);
          const workspace = await resolveSessionWorkspacePayload(targetId);
          const bgTasks = await buildBgTasksForSession(targetId);
          const shellCollabActive = await resolveShellCollabActive(targetId, SESSIONS_DIR);
          const runtimeExtras = await buildConnectedPayloadExtras(targetId);
          sendJSON(ws, {
            type: 'session_switched',
            ok: true,
            sessionId: targetId,
            shellCollabActive,
            ...workspace,
            ...runtimeExtras,
            ...(newRunningTurn ? { runningTurn: newRunningTurn } : {}),
            bgTasks,
          });
          replayPendingConfirmsToWs(ws, targetId);
          console.log(`[chat-ws] 切换到会话 ${targetId}`);
        } catch (err) {
          setActiveSessionId(prevFocused);
          console.error('[chat-ws] switch_session failed:', err);
          sendJSON(ws, {
            type: 'session_switched',
            ok: false,
            reason: 'switch_failed',
            sessionId: prevFocused,
          });
        }
        return;
      }

      if (msg.type === 'message' && (msg.content || (msg.images && msg.images.length > 0))) {
        const runSid = getSubscribedSessionId(ws);
        if (!runSid) {
          sendJSON(ws, { type: 'error', message: '未订阅会话' });
          return;
        }
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
            sendJSON(ws, { type: 'info', sessionId: runSid, message: PENDING_NOTE_USAGE_MESSAGE });
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
            sendJSON(ws, { type: 'info', sessionId: runSid, message: '当前有任务进行中，请稍后再试 /open' });
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

        const nextCmd = parseNextCommand(content);
        const taskText = nextCmd.matched ? nextCmd.text : content;
        if (nextCmd.matched && !taskText.trim() && !hasAttachments) {
          sendJSON(ws, { type: 'info', sessionId: runSid, message: NEXT_USAGE_MESSAGE });
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
          'implicit',
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
