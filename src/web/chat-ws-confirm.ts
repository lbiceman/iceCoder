/**
 * chat-ws 多端 confirm：first-win 协议（普通工具确认 + shell mandatory）。
 */

import type { ShellMandatoryConfirmRequest } from '../harness/harness-permission-runtime.js';
import { redactToolArguments } from '../tools/tool-argument-redaction.js';
import { broadcastToSession } from './chat-ws-broadcast.js';

interface PendingConfirm {
  sessionId: string;
  toolName: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  confirmKind?: 'shell_mandatory';
}

const pendingConfirms = new Map<string, PendingConfirm>();
let nextConfirmIdCounter = 1;

function nextConfirmId(): string {
  return `c-${Date.now().toString(36)}-${(nextConfirmIdCounter++).toString(36)}`;
}

export function resolveConfirm(confirmId: string, approved: boolean, reason: 'reply' | 'timeout'): void {
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
    // 兼容旧客户端（不带 confirmId）：取该 session 下最早的一个 pending
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
    const confirmId = nextConfirmId();
    const toolName = formatShellMandatoryConfirmToolName(request);
    const timer = setTimeout(() => {
      if (pendingConfirms.has(confirmId)) {
        broadcastToSession(runSessionId, {
          type: 'confirm_timeout',
          confirmId,
          toolName,
          confirmKind: 'shell_mandatory',
        });
        resolveConfirm(confirmId, false, 'timeout');
      }
    }, 60_000);
    pendingConfirms.set(confirmId, {
      sessionId: runSessionId,
      toolName,
      resolve,
      timer,
      confirmKind: 'shell_mandatory',
    });
    broadcastToSession(runSessionId, {
      type: 'confirm',
      confirmId,
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
    });
  });
}

/** handleChatMessage 使用的普通工具确认；与 shell mandatory 共用 pendingConfirms / first-win。 */
export function createToolConfirmHandler(
  runSessionId: string,
): (toolName: string, args: Record<string, any>) => Promise<boolean> {
  return (toolName, args) => {
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
      broadcastToSession(runSessionId, { type: 'confirm', confirmId, toolName, args });
    });
  };
}

export function purgeSessionConfirms(sessionId: string): void {
  for (const [cid, entry] of pendingConfirms) {
    if (entry.sessionId !== sessionId) continue;
    clearTimeout(entry.timer);
    pendingConfirms.delete(cid);
    try { entry.resolve(false); } catch { /* ignore */ }
  }
}

export function clearAllConfirms(): void {
  for (const [cid, entry] of pendingConfirms) {
    clearTimeout(entry.timer);
    pendingConfirms.delete(cid);
    try { entry.resolve(false); } catch { /* ignore */ }
  }
}
