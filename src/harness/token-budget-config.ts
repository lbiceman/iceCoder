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
