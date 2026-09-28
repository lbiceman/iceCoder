/**
 * 子 Agent 上限。改这个文件即可，不读环境变量。
 */

import type { AgentTypeDefinition } from './agent-types.js';

export const agentConfig = {
  /** general：最大轮次 */
  generalMaxRounds: 2000,
  /** general：超时（毫秒），4 小时 */
  generalTimeoutMs: 4 * 60 * 60 * 1000,
  /** explore：最大轮次 */
  exploreMaxRounds: 300,
  /** explore：超时（毫秒），30 分钟 */
  exploreTimeoutMs: 30 * 60 * 1000,
  /** 每个子 Agent 的 token 预算 */
  tokenBudget: 20_000_000,
  /** 同时运行的子 Agent 上限，超出排队 */
  maxConcurrent: 4,
  /** 一次 run() 最多派出几个，超出时 task 直接报错 */
  maxPerRun: 16,
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

/** 按类型取上限，并压到主 Harness 剩余时长之内。 */
export function resolveAgentLimits(
  type: AgentTypeDefinition,
  options: { parentDeadline?: number; now?: number } = {},
): AgentLimits {
  const explore = type.name === 'explore';
  const maxRounds = explore ? agentConfig.exploreMaxRounds : agentConfig.generalMaxRounds;
  let timeoutMs = explore ? agentConfig.exploreTimeoutMs : agentConfig.generalTimeoutMs;
  if (options.parentDeadline !== undefined && Number.isFinite(options.parentDeadline)) {
    const now = options.now ?? Date.now();
    const ceiling = options.parentDeadline - now - agentConfig.parentDeadlineMarginMs;
    timeoutMs = Math.max(agentConfig.minTimeoutMs, Math.min(timeoutMs, ceiling));
  }
  return {
    maxRounds,
    timeoutMs,
    tokenBudget: agentConfig.tokenBudget,
  };
}
