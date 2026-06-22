/**
 * Harness Runtime 生命周期状态。
 *
 * Restore 仅允许在 Idle；Running / Restoring 等非 Idle 状态一律拒绝。
 */

export type HarnessState =
  | 'idle'
  | 'running'
  | 'planning'
  | 'executing'
  | 'streaming'
  | 'tool_calling'
  | 'recovering'
  | 'restoring'
  | 'cancelling';

export function isHarnessIdle(state: HarnessState): boolean {
  return state === 'idle';
}

export function isHarnessBusy(state: HarnessState): boolean {
  return !isHarnessIdle(state);
}

/** 由 chat-ws 在 harness.run 期间映射到细粒度状态；默认 running 即 busy。 */
export function isHarnessRestoreAllowed(state: HarnessState): boolean {
  return isHarnessIdle(state);
}
