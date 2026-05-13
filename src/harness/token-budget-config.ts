/**
 * Harness token budget is a cost guard, not a context-window limit.
 *
 * Leave it disabled by default so long-running coding tasks rely on context
 * compaction instead of stopping after cumulative API usage crosses a number.
 */
export function getHarnessTokenBudgetFromEnv(): number | undefined {
  const raw = process.env.ICE_HARNESS_TOKEN_BUDGET?.trim();
  if (!raw || raw === '0' || raw.toLowerCase() === 'off') return undefined;

  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;

  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export const DEFAULT_LONG_RUNNING_TIMEOUT_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_LONG_RUNNING_MAX_ROUNDS = 5000;

export function getHarnessTimeoutMsFromEnv(defaultMs = DEFAULT_LONG_RUNNING_TIMEOUT_MS): number {
  const hours = readPositiveIntEnv('ICE_HARNESS_TIMEOUT_HOURS');
  if (hours !== undefined) return hours * 60 * 60 * 1000;

  return readPositiveIntEnv('ICE_HARNESS_TIMEOUT_MS') ?? defaultMs;
}

export function getHarnessMaxRoundsFromEnv(defaultRounds = DEFAULT_LONG_RUNNING_MAX_ROUNDS): number {
  return readPositiveIntEnv('ICE_HARNESS_MAX_ROUNDS') ?? defaultRounds;
}

/** 与 OpenAIAdapter 默认单次请求超时对齐，避免首轮 LLM 仍可等、子代理外层 60s 先失败 */
const DEFAULT_SUBAGENT_ENVELOPE_MS = 120_000;

/**
 * 子代理 delegate 整段耗时上限（毫秒）。
 * 可被 `SubAgentRequest.timeoutMs` 覆盖；默认 120s 或与 ICE_SUBAGENT_TIMEOUT_MS 一致。
 */
export function getSubAgentTimeoutMsFromEnv(defaultMs = DEFAULT_SUBAGENT_ENVELOPE_MS): number {
  return readPositiveIntEnv('ICE_SUBAGENT_TIMEOUT_MS') ?? defaultMs;
}
