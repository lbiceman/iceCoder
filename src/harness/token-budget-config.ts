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

function readIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;

  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 单次 Harness run 墙钟超时（毫秒）。硬编码 24 小时，不再通过环境变量覆盖。 */
export const DEFAULT_LONG_RUNNING_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LONG_RUNNING_MAX_ROUNDS = 5000;

/**
 * 单次 run 的成本护栏：`LoopController` 把 input+output 累加，达到此值就以 `token_budget` 停止。
 * 1e9 量级，撑得住默认 5000 轮；异常刷量时仍会停。
 *
 * 这不是 {@link TokenBudgetTracker} 的本地默认（那是 50 万，只在没传入 totalBudget 时使用）。
 * Harness 会把本值传进 tracker，所以正式 run 里两边看到的是同一个 run 预算。
 */
export const DEFAULT_HARNESS_RUN_TOKEN_BUDGET = 1_000_000_000;

/** @deprecated 与 {@link DEFAULT_HARNESS_RUN_TOKEN_BUDGET} 相同，保留给已有导入。 */
export const DEFAULT_HARNESS_TOKEN_BUDGET_TOTAL = DEFAULT_HARNESS_RUN_TOKEN_BUDGET;

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

/** 返回单次 run 的成本护栏（见 {@link DEFAULT_HARNESS_RUN_TOKEN_BUDGET}）。 */
export function getHarnessTokenBudget(): number {
  return DEFAULT_HARNESS_RUN_TOKEN_BUDGET;
}

/**
 * Recovery budget 耗尽时是否走 Segment Renewal（同 run 内续段）而非 `user_checkpoint`。
 * `ICE_HARNESS_SOFT_CHECKPOINT=0` 关闭，恢复 budget → checkpoint 旧行为。
 */
export function isSoftCheckpointEnabled(): boolean {
  const raw = readIntEnv('ICE_HARNESS_SOFT_CHECKPOINT');
  return raw === undefined ? true : raw !== 0;
}

/** 单次 run 内最多允许的续段次数；超出后仍走 `fail{checkpoint}`。 */
export function getMaxSegmentRenewals(): number {
  return readPositiveIntEnv('ICE_HARNESS_MAX_SEGMENT_RENEWALS') ?? 20;
}
