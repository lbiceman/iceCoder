/**
 * 进程级 Harness Runtime 状态注册表（per session）。
 *
 * chat-ws 在任务 batch 开始/结束/Restore 时更新；UI 通过 WS 广播同步。
 */

import type { HarnessState } from '../types/harness-runtime-state.js';
import { isHarnessIdle, isHarnessRestoreAllowed } from '../types/harness-runtime-state.js';

const states = new Map<string, HarnessState>();
/** 活跃 Harness run 嵌套深度（含排队 batch 内多轮 handleChatMessage） */
const runDepth = new Map<string, number>();
const restoringSessions = new Set<string>();

export function getHarnessRuntimeState(sessionId: string): HarnessState {
  return states.get(sessionId) ?? 'idle';
}

export function setHarnessRuntimeState(sessionId: string, state: HarnessState): void {
  states.set(sessionId, state);
}

export function getSessionHarnessRunDepth(sessionId: string): number {
  return runDepth.get(sessionId) ?? 0;
}

/** batch / handleChatMessage 开始时调用；depth 从 0→1 时进入 running。 */
export function beginSessionHarnessRun(sessionId: string): void {
  const next = (runDepth.get(sessionId) ?? 0) + 1;
  runDepth.set(sessionId, next);
  if (next === 1 && !restoringSessions.has(sessionId)) {
    setHarnessRuntimeState(sessionId, 'running');
  }
}

/** batch / handleChatMessage 结束时调用；depth 回到 0 且非 restoring 时进入 idle。 */
export function endSessionHarnessRun(sessionId: string): void {
  const current = runDepth.get(sessionId) ?? 0;
  const next = Math.max(0, current - 1);
  if (next === 0) runDepth.delete(sessionId);
  else runDepth.set(sessionId, next);
  if (next === 0 && !restoringSessions.has(sessionId)) {
    setHarnessRuntimeState(sessionId, 'idle');
  }
}

export function isSessionRestoring(sessionId: string): boolean {
  return restoringSessions.has(sessionId);
}

export function markSessionRestoring(sessionId: string, restoring: boolean): void {
  if (restoring) {
    restoringSessions.add(sessionId);
    setHarnessRuntimeState(sessionId, 'restoring');
  } else {
    restoringSessions.delete(sessionId);
    const depth = getSessionHarnessRunDepth(sessionId);
    setHarnessRuntimeState(sessionId, depth > 0 ? 'running' : 'idle');
  }
}

export function isSessionHarnessIdle(sessionId: string): boolean {
  return isHarnessIdle(getHarnessRuntimeState(sessionId))
    && getSessionHarnessRunDepth(sessionId) === 0
    && !isSessionRestoring(sessionId);
}

export function canSessionRestore(sessionId: string): boolean {
  return isHarnessRestoreAllowed(getHarnessRuntimeState(sessionId))
    && getSessionHarnessRunDepth(sessionId) === 0
    && !isSessionRestoring(sessionId);
}

export function clearHarnessRuntimeState(sessionId: string): void {
  states.delete(sessionId);
  runDepth.delete(sessionId);
  restoringSessions.delete(sessionId);
}

/** 测试 / session 删除时清理 */
export function resetHarnessRuntimeRegistry(): void {
  states.clear();
  runDepth.clear();
  restoringSessions.clear();
}
