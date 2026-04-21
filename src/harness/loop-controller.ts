/**
 * 循环控制器 — 负责"什么时候停"。
 *
 * 职责：
 * - 模型说 done → 停
 * - token 预算耗尽 → 停
 * - max rounds → 强制停
 * - 用户中断 → 停
 * - 超时 → 停
 */

import type { LoopControlConfig, LoopState, StopReason } from './types.js';

/**
 * LoopController 管理 Harness 核心循环的生命周期。
 * 对应 Harness 文档中的"什么时候停（循环控制）"。
 */
export class LoopController {
  private config: LoopControlConfig;
  private state: LoopState;

  constructor(config: LoopControlConfig) {
    this.config = config;
    this.state = {
      currentRound: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalToolCalls: 0,
      startTime: Date.now(),
    };
  }

  /**
   * 检查是否应该继续循环。
   * 返回 null 表示继续，返回 StopReason 表示应该停止。
   */
  shouldContinue(): StopReason | null {
    // 用户中断
    if (this.config.signal?.aborted) {
      return 'user_abort';
    }

    // 最大轮次
    if (this.state.currentRound >= this.config.maxRounds) {
      return 'max_rounds';
    }

    // Token 预算
    if (this.config.tokenBudget) {
      const totalTokens = this.state.totalInputTokens + this.state.totalOutputTokens;
      if (totalTokens >= this.config.tokenBudget) {
        return 'token_budget';
      }
    }

    // 超时
    if (this.config.timeout) {
      const elapsed = Date.now() - this.state.startTime;
      if (elapsed >= this.config.timeout) {
        return 'timeout';
      }
    }

    return null;
  }

  /**
   * 推进一轮循环。
   */
  advanceRound(): void {
    this.state.currentRound++;
  }

  /**
   * 记录 token 使用。
   */
  recordTokenUsage(inputTokens: number, outputTokens: number): void {
    this.state.totalInputTokens += inputTokens;
    this.state.totalOutputTokens += outputTokens;
  }

  /**
   * 记录工具调用。
   */
  recordToolCalls(count: number): void {
    this.state.totalToolCalls += count;
  }

  /**
   * 标记循环结束。
   */
  stop(reason: StopReason): void {
    this.state.stopReason = reason;
  }

  /**
   * 获取当前循环状态。
   */
  getState(): LoopState {
    return { ...this.state };
  }

  /**
   * 获取剩余 token 预算（如果设置了的话）。
   */
  getRemainingTokenBudget(): number | undefined {
    if (!this.config.tokenBudget) return undefined;
    const used = this.state.totalInputTokens + this.state.totalOutputTokens;
    return Math.max(0, this.config.tokenBudget - used);
  }

  /**
   * 获取剩余轮次。
   */
  getRemainingRounds(): number {
    return Math.max(0, this.config.maxRounds - this.state.currentRound);
  }
}
