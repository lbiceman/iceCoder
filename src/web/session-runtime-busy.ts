/**
 * 会话级 Runtime Busy 判定 — Restore 门控补充 runningTurn / 排队 batch。
 */

import {
  canSessionRestore,
  getSessionHarnessRunDepth,
} from '../harness/harness-runtime-registry.js';

export interface RunningTurnProbe {
  isProcessing: boolean;
}

export interface SessionRuntimeBusyProbe {
  getRunningTurn?: (sessionId: string) => RunningTurnProbe | null | undefined;
  getPendingBatchCount?: (sessionId: string) => number;
}

let probe: SessionRuntimeBusyProbe = {};

/** chat-ws 启动时注入 runningTurn / pending batch 探针。 */
export function registerSessionRuntimeBusyProbe(next: SessionRuntimeBusyProbe): void {
  probe = next;
}

export function resetSessionRuntimeBusyProbe(): void {
  probe = {};
}

export function isSessionRuntimeBusy(sessionId: string): boolean {
  if (!canSessionRestore(sessionId)) return true;
  if (getSessionHarnessRunDepth(sessionId) > 0) return true;
  const turn = probe.getRunningTurn?.(sessionId);
  if (turn?.isProcessing) return true;
  const pending = probe.getPendingBatchCount?.(sessionId) ?? 0;
  if (pending > 0) return true;
  return false;
}

export function canAcceptRuntimeRestore(sessionId: string): boolean {
  return !isSessionRuntimeBusy(sessionId);
}
