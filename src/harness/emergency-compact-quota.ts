import { MAX_EMERGENCY_COMPACTS_PER_RUN } from './harness-constants.js';
import type { HarnessRunState } from './harness-run-state.js';

function usedCount(state: Pick<HarnessRunState, 'contextEmergencyCompactCount' | 'contextEmergencyCompactUsed'>): number {
  if (typeof state.contextEmergencyCompactCount === 'number') {
    return state.contextEmergencyCompactCount;
  }
  return state.contextEmergencyCompactUsed ? MAX_EMERGENCY_COMPACTS_PER_RUN : 0;
}

export function canUseEmergencyCompact(
  state: Pick<HarnessRunState, 'contextEmergencyCompactCount' | 'contextEmergencyCompactUsed'> | undefined,
): boolean {
  if (!state) return false;
  return usedCount(state) < MAX_EMERGENCY_COMPACTS_PER_RUN;
}

export function consumeEmergencyCompact(state: HarnessRunState): boolean {
  if (!canUseEmergencyCompact(state)) return false;
  const next = usedCount(state) + 1;
  state.contextEmergencyCompactCount = next;
  state.contextEmergencyCompactUsed = next >= MAX_EMERGENCY_COMPACTS_PER_RUN;
  return true;
}

/** 成功硬压缩且占用回到微压缩线以下时归还 1 次，不超过 max。 */
export function refundEmergencyCompact(state: HarnessRunState | undefined): void {
  if (!state) return;
  const current = usedCount(state);
  if (current <= 0) return;
  const next = current - 1;
  state.contextEmergencyCompactCount = next;
  state.contextEmergencyCompactUsed = next >= MAX_EMERGENCY_COMPACTS_PER_RUN;
}
