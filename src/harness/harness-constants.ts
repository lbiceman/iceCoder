// ─── max-output-tokens 恢复最大次数 ───
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

// ─── 连续工具失败提示干预阈值 ───
// 第3轮开始注入强提示A，第6轮开始注入强提示B，第10轮触发熔断
export const MAX_CONSECUTIVE_TOOL_FAILURES = 3;
export const CIRCUIT_BREAKER_THRESHOLD = 10;

// ─── LLM 空响应重试最大次数 ───
export const MAX_EMPTY_RESPONSE_RETRIES = 2;

// ─── 仅 reasoning、无 toolCalls 时的恢复次数 ───
export const MAX_REASONING_ONLY_RECOVERY = 2;

// ─── 验收/诊断未清时拦截 model_done 的最大次数 ───
export const MAX_PREMATURE_COMPLETION_RECOVERY = 3;

// ─── stop_hook 连续干预上限 ───
export const MAX_STOP_HOOK_CONTINUATIONS = 3;

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
