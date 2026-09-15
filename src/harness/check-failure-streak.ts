import { normalizeAcceptanceCommandKey } from './run-command-result.js';
import type { RunCommandResultClassification } from './run-command-result.js';

/** 同一规范化命令连续失败多少次后注入 Rebuild（中间 write 不清零）。 */
export const CHECK_FAILURE_STREAK_REBUILD = 6;

export interface CheckFailureStreakEntry {
  failCount: number;
  /** 上次成功注入 Rebuild 时的 failCount；用于 6 / 12 / 18… 各注入一次。 */
  lastRebuildAt: number;
  label: string;
}

export interface CheckFailureStreakState {
  entries: Record<string, CheckFailureStreakEntry>;
}

export interface CheckFailureStreakPending {
  key: string;
  label: string;
  failCount: number;
}

export function emptyCheckFailureStreak(): CheckFailureStreakState {
  return { entries: {} };
}

export function isTerminalCheckSuccess(classified: RunCommandResultClassification): boolean {
  if (classified.kind === 'foreground') return classified.foregroundSuccess === true;
  if (classified.kind === 'background_completed') return true;
  return false;
}

export function isTerminalCheckFailure(classified: RunCommandResultClassification): boolean {
  if (classified.kind === 'foreground') return !classified.foregroundSuccess;
  if (classified.kind === 'background_failed') return true;
  return false;
}

/**
 * 按规范化命令键累计终态失败。write 不调用本函数，因此不清零。
 * 该键一次终态成功则删除条目。
 *
 * BranchBudget 拦截（`[BranchBudget / Blocked]`）也是 foreground 失败：
 * 同一命令字符串最多真跑 2 次，后续拦截必须计入 streak，否则永远到不了 6。
 */
export function recordCheckCommandOutcome(
  state: CheckFailureStreakState,
  classified: RunCommandResultClassification,
): CheckFailureStreakPending | null {
  if (classified.kind === 'background_start' || classified.kind === 'background_running') {
    return null;
  }
  const key = normalizeAcceptanceCommandKey(classified.command);
  if (!key) return null;
  const label = classified.command.trim() || key;

  if (isTerminalCheckSuccess(classified)) {
    delete state.entries[key];
    return { key, label, failCount: 0 };
  }
  if (!isTerminalCheckFailure(classified)) return null;

  const prev = state.entries[key] ?? { failCount: 0, lastRebuildAt: 0, label };
  const failCount = prev.failCount + 1;
  state.entries[key] = {
    failCount,
    lastRebuildAt: prev.lastRebuildAt,
    label,
  };
  return { key, label, failCount };
}

export function shouldTriggerCheckFailureStreakRebuild(entry: CheckFailureStreakEntry): boolean {
  return entry.failCount - entry.lastRebuildAt >= CHECK_FAILURE_STREAK_REBUILD;
}

/** 选出当前应注入 Rebuild 的命令（取失败次数最高者）。 */
export function findCheckFailureStreakRebuild(
  state: CheckFailureStreakState,
): CheckFailureStreakPending | null {
  let best: CheckFailureStreakPending | null = null;
  for (const [key, entry] of Object.entries(state.entries)) {
    if (!shouldTriggerCheckFailureStreakRebuild(entry)) continue;
    if (!best || entry.failCount > best.failCount) {
      best = { key, label: entry.label, failCount: entry.failCount };
    }
  }
  return best;
}

/** 注入成功（或同轮已被其它 Rebuild 占用）后推进 lastRebuildAt，避免下一轮立刻再注入。 */
export function markCheckStreakRebuild(state: CheckFailureStreakState, key: string): void {
  const entry = state.entries[key];
  if (!entry) return;
  entry.lastRebuildAt = entry.failCount;
}
