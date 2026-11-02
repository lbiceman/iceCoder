import { RECOVERY_BUDGET } from './recovery-budget.js';

// ─── max-output-tokens 恢复最大次数 ───
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

// ─── 连续工具失败提示干预阈值（见 RECOVERY_BUDGET.failureEvidenceLadder）───
export const FAILURE_EVIDENCE_THRESHOLD_START = RECOVERY_BUDGET.failureEvidenceLadder.evidenceStart;
export const FAILURE_EVIDENCE_THRESHOLD_END = RECOVERY_BUDGET.failureEvidenceLadder.evidenceEnd;
export const STRONG_WARNING_FAILURE_THRESHOLD = RECOVERY_BUDGET.failureEvidenceLadder.strongWarningStart;
export const CIRCUIT_BREAKER_THRESHOLD = RECOVERY_BUDGET.failureEvidenceLadder.circuitBreaker;

export const MAX_EMPTY_RESPONSE_RETRIES = RECOVERY_BUDGET.emptyResponse.max;
export const MAX_REASONING_ONLY_RECOVERY = RECOVERY_BUDGET.reasoningOnly.max;
export const MAX_STOP_HOOK_CONTINUATIONS = RECOVERY_BUDGET.stopHook.max;

// ─── LLM 调用重试配置（Harness 层传输错误最多 3 次；abort 不重试） ───
export const LLM_MAX_RETRIES = 3;
export const LLM_RETRY_BASE_DELAY = 2000;
export const LLM_RETRY_MAX_DELAY = 15_000;

// ─── 子代理结果封存（单位是字符）───
export const SUBAGENT_RESULT_KEEP_RECENT = 6;
export const OLD_SUBAGENT_SUMMARY_CHARS = 300;

// ─── 任务切换检测 ───
export const TASK_SWITCH_JACCARD_THRESHOLD = 0.15;

/** 硬压缩前等待会话笔记 LLM 更新的上限（毫秒）。超时则用磁盘已有内容继续。 */
export const PRE_COMPACT_SESSION_MEMORY_WAIT_MS = 5_000;
export const PRE_COMPACT_SESSION_TIMEOUT_MSG = 'pre_compact_session_memory_timeout';

/** emergency / proactive fork 每 run 共用配额 */
export const MAX_EMERGENCY_COMPACTS_PER_RUN = 3;

// ─── 默认压缩配置 ───
export const DEFAULT_COMPACTION_THRESHOLD = 40;
export const DEFAULT_COMPACTION_KEEP_RECENT = 15;

/** 验收失败后，同一计划、同一工作区版本最多再续的轮数。数字在 RECOVERY_BUDGET。 */
export const VERIFICATION_CONTINUATION_MAX = RECOVERY_BUDGET.verificationContinuation.max;

/** 恢复 checkpoint 时，已有消息达到此条数就 fork 压缩。 */
export const CHECKPOINT_RESUME_FORK_MIN_MESSAGES = 60;
/** 恢复 checkpoint 时，估算 token 超过窗口的这个比例就 fork 压缩。 */
export const CHECKPOINT_RESUME_FORK_TOKEN_RATIO = 0.5;

/** 输出 token 达到单次上限的这个比例，视为已经顶满。 */
export const OUTPUT_TOKEN_CEILING_RATIO = 0.98;
/** 写工具 content 至少这么长且缺 path，才按截断恢复。 */
export const TRUNCATED_WRITE_CONTENT_MIN_CHARS = 500;

/** 停手验收轮询：间隔、退避上限、最多轮询次数。 */
export const STOP_VERIFICATION_POLL_INTERVAL_MS = 500;
export const STOP_VERIFICATION_MAX_POLL_INTERVAL_MS = 2_000;
export const STOP_VERIFICATION_MAX_POLL_ATTEMPTS = 60;

/** 短确认消息，轻量压缩可以丢掉。 */
export const SHORT_USER_MSG_MAX_LENGTH = 50;
/** 超过这个长度的 user 消息视为任务描述，硬压缩时保留最近一条。 */
export const MIN_USER_MSG_LENGTH_TO_PRESERVE = 200;

/** 连续空召回达到此次数后进入冷却。 */
export const EMPTY_RECALL_STREAK_BEFORE_COOLDOWN = 3;
/** 空召回冷却持续的轮数。 */
export const EMPTY_RECALL_COOLDOWN_ROUNDS = 3;

/** 子 Agent 硬超时之后再等多久才 abort。 */
export const AGENT_HARD_TIMEOUT_GRACE_MS = 30_000;
/** 子 Agent 进度更新的默认节流。 */
export const AGENT_UPDATE_THROTTLE_MS = 500;
