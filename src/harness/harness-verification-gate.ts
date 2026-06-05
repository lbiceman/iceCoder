/** verification gate 计数器：blocking 解除，或 file/Acceptance pending 净减少时归零 */
export function shouldResetVerificationGateCounter(
  pendingBefore: number,
  pendingAfter: number,
  blockingAfter: boolean,
  acceptancePendingBefore = 0,
  acceptancePendingAfter = 0,
): boolean {
  if (!blockingAfter) return true;
  if (pendingAfter < pendingBefore) return true;
  if (acceptancePendingAfter < acceptancePendingBefore) return true;
  return false;
}

/** 工具轮结束后按验收净进展更新 Gate 计数（与 runHarnessToolRound 一致） */
export function maybeResetVerificationGateCounter(
  state: { verificationGateContinuationCount: number },
  pendingBefore: number,
  pendingAfter: number,
  blockingAfter: boolean,
  acceptancePendingBefore = 0,
  acceptancePendingAfter = 0,
): void {
  if (shouldResetVerificationGateCounter(
    pendingBefore,
    pendingAfter,
    blockingAfter,
    acceptancePendingBefore,
    acceptancePendingAfter,
  )) {
    state.verificationGateContinuationCount = 0;
  }
}
