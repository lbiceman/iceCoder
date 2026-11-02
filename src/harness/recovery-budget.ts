/**
 * 「别停、换策略」的预算。
 * 上限在这里维护；重置仍发生在对应事件旁边，条件写在 reset。
 */
interface RecoveryLimit {
  max: number;
  reset: string;
}

export const RECOVERY_BUDGET: {
  emptyResponse: RecoveryLimit;
  reasoningOnly: RecoveryLimit;
  embeddedToolSyntax: RecoveryLimit;
  amnesia: RecoveryLimit;
  stopHook: RecoveryLimit;
  verificationContinuation: RecoveryLimit;
  failureEvidenceLadder: {
    evidenceStart: number;
    evidenceEnd: number;
    strongWarningStart: number;
    circuitBreaker: number;
    reset: string;
  };
} = {
  emptyResponse: { max: 2, reset: '收到可展示回复，或进入工具轮' },
  reasoningOnly: { max: 2, reset: '下一轮不再是纯 reasoning' },
  embeddedToolSyntax: { max: 1, reset: '新的用户消息' },
  amnesia: { max: 1, reset: '发生压缩时清零' },
  stopHook: { max: 5, reset: '钩子不再要求继续，或工具轮出现有效进展' },
  verificationContinuation: { max: 1, reset: '验收计划指纹或工作区改动版本变化' },
  failureEvidenceLadder: {
    evidenceStart: 2,
    evidenceEnd: 6,
    strongWarningStart: 7,
    circuitBreaker: 10,
    reset: '出现有效工具进展',
  },
};
