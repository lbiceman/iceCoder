/**
 * 子 Agent 的轮次、超时、token 预算与主 Harness 相同。
 * 数字来自 token-budget-config；派出时若父级 loop 写了自己的值，跟父级走。
 */

import type { AgentTypeDefinition } from './agent-types.js';
import {
  getHarnessMaxRoundsFromEnv,
  getHarnessTimeoutMsFromEnv,
  getHarnessTokenBudget,
} from '../token-budget-config.js';

export const agentConfig = {
  /** 同时运行的子 Agent 上限，超出排队 */
  maxConcurrent: 6,
  /** 一次 run() 最多派出几个，超出时 task 直接报错 */
  maxPerRun: 30,
  /** 子 Agent 必须比主 Harness 早结束的余量 */
  parentDeadlineMarginMs: 2 * 60 * 1000,
  /** 被主 Harness 剩余时长压缩后的最小超时，避免 0ms 立即超时 */
  minTimeoutMs: 10_000,
} as const;

export interface AgentLimits {
  maxRounds: number;
  timeoutMs: number;
  tokenBudget: number;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 子 Agent 上限与主 Agent 相同。
 * 传了父级 loop 时用父级的数；否则用主 Harness 的默认上限。
 * 超时仍压到父级截止时间之前，避免子任务跑过主任务。
 */
export function resolveAgentLimits(
  _type: AgentTypeDefinition,
  options: {
    parentDeadline?: number;
    now?: number;
    maxRounds?: number;
    timeoutMs?: number;
    tokenBudget?: number;
  } = {},
): AgentLimits {
  const maxRounds = positiveOr(options.maxRounds, getHarnessMaxRoundsFromEnv());
  let timeoutMs = positiveOr(options.timeoutMs, getHarnessTimeoutMsFromEnv());
  const tokenBudget = positiveOr(options.tokenBudget, getHarnessTokenBudget());
  if (options.parentDeadline !== undefined && Number.isFinite(options.parentDeadline)) {
    const now = options.now ?? Date.now();
    const ceiling = options.parentDeadline - now - agentConfig.parentDeadlineMarginMs;
    timeoutMs = Math.max(agentConfig.minTimeoutMs, Math.min(timeoutMs, ceiling));
  }
  return { maxRounds, timeoutMs, tokenBudget };
}
