/**
 * Harness token budget：单次 `run()` 的**累计** input+output 上限（成本护栏）。
 * 与墙钟超时、最大轮次并列；不再通过 `ICE_HARNESS_TOKEN_BUDGET` 配置。
 */

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;

  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 单次 Harness run 墙钟超时（毫秒）。硬编码 24 小时，不再通过环境变量覆盖。 */
export const DEFAULT_LONG_RUNNING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LONG_RUNNING_MAX_ROUNDS = 5000;

/**
 * 单次 run 的累计 token 上限（`LoopController` 中 inputTokens+outputTokens 累加）。
 * 50e6 量级：在默认 5000 轮、压缩与中等单轮用量下足够支撑长跑；仍可作为异常刷量保险丝。
 */
export const DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL = 50_000_000;

/**
 * Harness 单次 `run()` 的墙钟超时。
 * 固定为 {@link DEFAULT_LONG_RUNNING_TIMEOUT_MS}（24h）
 */
export function getHarnessTimeoutMsFromEnv(): number {
  return DEFAULT_LONG_RUNNING_TIMEOUT_MS;
}

export function getHarnessMaxRoundsFromEnv(defaultRounds = DEFAULT_LONG_RUNNING_MAX_ROUNDS): number {
  return readPositiveIntEnv('ICE_HARNESS_MAX_ROUNDS') ?? defaultRounds;
}

/** 返回固定的累计 token 上限（见 {@link DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL}）。 */
export function getHarnessTokenBudget(): number {
  return DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL;
}

/** 与 OpenAIAdapter 默认单次请求超时对齐，避免首轮 LLM 仍可等、子代理外层 60s 先失败 */
const DEFAULT_SUBAGENT_ENVELOPE_MS = 120_000;

/**
 * 子代理 delegate 整段耗时上限（毫秒）。
 * 可被 `ICE_SUBAGENT_TIMEOUT_MS` 覆盖；默认 120s 或与 ICE_SUBAGENT_TIMEOUT_MS 一致。
 */
export function getSubAgentTimeoutMsFromEnv(defaultMs = DEFAULT_SUBAGENT_ENVELOPE_MS): number {
  return readPositiveIntEnv('ICE_SUBAGENT_TIMEOUT_MS') ?? defaultMs;
}
