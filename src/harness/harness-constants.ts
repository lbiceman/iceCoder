// ─── max-output-tokens 恢复最大次数 ───
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

// ─── 连续工具失败提示干预阈值 ───
// 1 静默 | 2~3 轻提示 | 4~6 证据包 | 7~9 强警告 | ≥10 熔断
export const LIGHT_HINT_FAILURE_THRESHOLD_START = 2;
export const LIGHT_HINT_FAILURE_THRESHOLD_END = 3;
export const FAILURE_EVIDENCE_THRESHOLD_START = 4;
export const FAILURE_EVIDENCE_THRESHOLD_END = 6;
export const STRONG_WARNING_FAILURE_THRESHOLD = 7;
export const CIRCUIT_BREAKER_THRESHOLD = 10;

/** @deprecated 连续失败不再在固定轮次触发 Rebuild；保留供 file-cap / segment 等路径引用 */
export const REBUILD_ESCALATION_THRESHOLD = 5;
/** @deprecated 使用 FAILURE_EVIDENCE_THRESHOLD_START */
export const MAX_CONSECUTIVE_TOOL_FAILURES = FAILURE_EVIDENCE_THRESHOLD_START;
/** 文件 cap / 续段等 Rebuild Escalation 每 run 最多注入次数 */
export const MAX_REBUILD_ESCALATIONS_PER_RUN = 3;

// ─── LLM 空响应重试最大次数 ───
export const MAX_EMPTY_RESPONSE_RETRIES = 2;

// ─── 仅 reasoning、无 toolCalls 时的恢复次数 ───
export const MAX_REASONING_ONLY_RECOVERY = 2;

// ─── 验收/诊断未清时拦截 model_done 的最大次数 ───
export const MAX_PREMATURE_COMPLETION_RECOVERY = 3;

// ─── stop_hook 连续干预上限 ───
export const MAX_STOP_HOOK_CONTINUATIONS = 5;

// ─── verification gate 连续注入上限（无工具响应时熔断） ───
/** 写后读 / Acceptance gate 连续无工具注入上限（商用默认 5，避免 token 失控） */
export const MAX_VERIFICATION_GATE_CONTINUATIONS = 5;

// ─── LLM 调用重试配置（Harness 层仅做 1 次快速重试，主要重试由 LLMAdapter 负责） ───
export const LLM_MAX_RETRIES = 1;
export const LLM_RETRY_BASE_DELAY = 2000;
export const LLM_RETRY_MAX_DELAY = 2000;

// ─── 工具结果预算裁剪 ───
export const TOOL_RESULT_KEEP_RECENT = 6;
export const TOOL_RESULT_BUDGET_PER_MESSAGE = 3000;
export const SUBAGENT_RESULT_KEEP_RECENT = 6;
export const OLD_SUBAGENT_SUMMARY_CHARS = 300;

// ─── 任务切换检测 ───
export const TASK_SWITCH_JACCARD_THRESHOLD = 0.15;

/** 硬压缩前等待会话笔记 LLM 更新的上限（毫秒）。超时则用磁盘已有内容继续。固定为 2 分钟。 */
export const PRE_COMPACT_SESSION_MEMORY_WAIT_MS = 120_000;
export const PRE_COMPACT_SESSION_TIMEOUT_MSG = 'pre_compact_session_memory_timeout';

// ─── 默认压缩配置 ───
export const DEFAULT_COMPACTION_THRESHOLD = 40;
export const DEFAULT_COMPACTION_KEEP_RECENT = 15;
