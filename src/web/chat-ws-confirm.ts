/**
 * chat-ws 多端 confirm：first-win 协议（普通工具确认 + shell mandatory）。
 * 无订阅者时暂停超时；新订阅者在 session_switched / connected 之后再 replay。
 */

import type { WebSocket } from 'ws';
import type { ShellMandatoryConfirmRequest } from '../harness/harness-permission-runtime.js';
import { redactToolArguments } from '../tools/tool-argument-redaction.js';
import {
  broadcastToSession,
  hasSessionSubscribers,
  onAfterSubscribe,
  onAfterUnsubscribe,
  sendJSON,
} from './chat-ws-broadcast.js';

const CONFIRM_TIMEOUT_MS = 60_000;

interface PendingConfirm {
  sessionId: string;
  toolName: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  deadline: number;
  paused: boolean;
  confirmKind?: 'shell_mandatory';
  payload: Record<string, unknown>;
}

const pendingConfirms = new Map<string, PendingConfirm>();
let nextConfirmIdCounter = 1;
let hooksWired = false;

function nextConfirmId(): string {
  return `c-${Date.now().toString(36)}-${(nextConfirmIdCounter++).toString(36)}`;
}

function armTimer(confirmId: string, entry: PendingConfirm): void {
  entry.timer = setTimeout(() => {
    if (!pendingConfirms.has(confirmId)) return;
    broadcastToSession(entry.sessionId, {
      type: 'confirm_timeout',
      confirmId,
      toolName: entry.toolName,
      ...(entry.confirmKind ? { confirmKind: entry.confirmKind } : {}),
    });
    resolveConfirm(confirmId, false, 'timeout');
  }, entry.remainingMs);
  entry.deadline = Date.now() + entry.remainingMs;
  entry.paused = false;
}

function pauseSessionConfirmTimers(sessionId: string): void {
  for (const [, entry] of pendingConfirms) {
    if (entry.sessionId !== sessionId || entry.paused || !entry.timer) continue;
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.remainingMs = Math.max(0, entry.deadline - Date.now());
    entry.paused = true;
  }
}

function resumeSessionConfirmTimers(sessionId: string): void {
  for (const [confirmId, entry] of pendingConfirms) {
    if (entry.sessionId !== sessionId || !entry.paused) continue;
    armTimer(confirmId, entry);
  }
}

export function replayPendingConfirmsToWs(ws: WebSocket, sessionId: string): void {
  for (const entry of pendingConfirms.values()) {
    if (entry.sessionId !== sessionId) continue;
    sendJSON(ws, entry.payload);
  }
}

function tryWireConfirmHooks(): void {
  if (hooksWired) return;
  if (typeof onAfterSubscribe !== 'function' || typeof onAfterUnsubscribe !== 'function') return;
  hooksWired = true;
  onAfterSubscribe((_ws, sessionId) => {
    const wasPaused = [...pendingConfirms.values()].some(
      (e) => e.sessionId === sessionId && e.paused,
    );
    if (wasPaused) resumeSessionConfirmTimers(sessionId);
  });
  onAfterUnsubscribe((_ws, sessionId) => {
    if (!hasSessionSubscribers(sessionId)) {
      pauseSessionConfirmTimers(sessionId);
    }
  });
}

tryWireConfirmHooks();

function startPendingConfirm(
  sessionId: string,
  toolName: string,
  payload: Record<string, unknown>,
  resolve: (approved: boolean) => void,
  confirmKind?: 'shell_mandatory',
): string {
  tryWireConfirmHooks();
  const confirmId = nextConfirmId();
  const entry: PendingConfirm = {
    sessionId,
    toolName,
    resolve,
    timer: null,
    remainingMs: CONFIRM_TIMEOUT_MS,
    deadline: Date.now() + CONFIRM_TIMEOUT_MS,
    paused: true,
    payload: { ...payload, confirmId, sessionId },
    ...(confirmKind ? { confirmKind } : {}),
  };
  pendingConfirms.set(confirmId, entry);
  if (typeof hasSessionSubscribers === 'function' && hasSessionSubscribers(sessionId)) {
    armTimer(confirmId, entry);
  }
  broadcastToSession(sessionId, entry.payload);
  return confirmId;
}

export function resolveConfirm(confirmId: string, approved: boolean, reason: 'reply' | 'timeout'): void {
  const entry = pendingConfirms.get(confirmId);
  if (!entry) return;
  pendingConfirms.delete(confirmId);
  if (entry.timer) clearTimeout(entry.timer);
  broadcastToSession(entry.sessionId, {
    type: 'confirm_resolved',
    confirmId,
    toolName: entry.toolName,
    approved,
    reason,
    ...(entry.confirmKind ? { confirmKind: entry.confirmKind } : {}),
  });
  entry.resolve(approved);
}

export function handleConfirmReply(
  confirmId: string,
  approved: boolean,
  subscribedSid: string,
): void {
  const pending = confirmId ? pendingConfirms.get(confirmId) : undefined;
  if (pending && pending.sessionId === subscribedSid) {
    resolveConfirm(confirmId, approved, 'reply');
  } else if (!confirmId && pendingConfirms.size > 0) {
    for (const [k, entry] of pendingConfirms) {
      if (entry.sessionId === subscribedSid) {
        resolveConfirm(k, approved, 'reply');
        break;
      }
    }
  }
}

function formatShellMandatoryConfirmToolName(request: ShellMandatoryConfirmRequest): string {
  const short = request.commandDisplay.length > 60
    ? `${request.commandDisplay.substring(0, 57)}...`
    : request.commandDisplay;
  return `${request.toolName} (${short})`;
}

export function createShellMandatoryConfirmHandler(
  runSessionId: string,
): (request: ShellMandatoryConfirmRequest) => Promise<boolean> {
  return (request) => new Promise<boolean>((resolve) => {
    const toolName = formatShellMandatoryConfirmToolName(request);
    startPendingConfirm(runSessionId, toolName, {
      type: 'confirm',
      toolName,
      args: {
        ...redactToolArguments(request.toolName, request.args),
        command: request.commandDisplay,
      },
      confirmKind: 'shell_mandatory',
      shellMandatory: {
        sessionId: request.sessionId,
        taskId: request.taskId,
        command: request.commandDisplay,
        matchedPattern: request.risk.matchedPattern,
        category: request.risk.category,
        impact: request.risk.impact,
        normalizedCommandHash: request.normalizedCommandHash,
      },
    }, resolve, 'shell_mandatory');
  });
}

/** handleChatMessage 使用的普通工具确认；与 shell mandatory 共用 pendingConfirms / first-win。 */
export function createToolConfirmHandler(
  runSessionId: string,
): (toolName: string, args: Record<string, any>) => Promise<boolean> {
  return (toolName, args) => {
    return new Promise<boolean>((resolve) => {
      startPendingConfirm(runSessionId, toolName, {
        type: 'confirm',
        toolName,
        args,
      }, resolve);
    });
  };
}

export function purgeSessionConfirms(sessionId: string): void {
  for (const [cid, entry] of pendingConfirms) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.timer) clearTimeout(entry.timer);
    pendingConfirms.delete(cid);
    try { entry.resolve(false); } catch { /* ignore */ }
  }
}

export function clearAllConfirms(): void {
  for (const [cid, entry] of pendingConfirms) {
    if (entry.timer) clearTimeout(entry.timer);
    pendingConfirms.delete(cid);
    try { entry.resolve(false); } catch { /* ignore */ }
  }
}
