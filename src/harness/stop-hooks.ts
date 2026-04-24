/**
 * 停止钩子 — 在循环结束前执行的检查逻辑。
 *
 * 当模型认为任务完成（不再请求工具调用）时，
 * 停止钩子可以检查是否真的完成了，如果没有，
 * 注入提示消息让模型继续。
 *
 * 典型用例：
 * - 检查测试是否通过
 * - 检查代码是否编译成功
 * - 检查是否遗漏了某些步骤
 */

import type { UnifiedMessage } from '../llm/types.js';

/**
 * 停止钩子的执行结果。
 */
export interface StopHookResult {
  /** 是否应该继续循环（true = 不要停，继续） */
  shouldContinue: boolean;
  /** 如果需要继续，注入的提示消息 */
  message?: string;
  /** 钩子名称（用于日志） */
  hookName: string;
}

/**
 * 停止钩子函数类型。
 *
 * @param messages - 当前完整的对话历史
 * @param lastContent - 模型最后一次回复的内容
 * @returns 钩子执行结果
 */
export type StopHookFn = (
  messages: UnifiedMessage[],
  lastContent: string,
) => Promise<StopHookResult>;

/**
 * 停止钩子管理器。
 *
 * 使用方式：
 * ```ts
 * const hooks = new StopHookManager();
 *
 * // 注册钩子：检查是否提到了"完成"
 * hooks.register(async (messages, lastContent) => ({
 *   shouldContinue: !lastContent.includes('完成'),
 *   message: '请确认任务是否已完成。',
 *   hookName: 'completion_check',
 * }));
 *
 * // 在 Harness 循环结束前执行
 * const result = await hooks.execute(messages, lastContent);
 * if (result.shouldContinue) {
 *   messages.push({ role: 'user', content: result.message! });
 *   // 继续循环...
 * }
 * ```
 */
export class StopHookManager {
  private hooks: StopHookFn[] = [];

  /**
   * 注册一个停止钩子。
   */
  register(hook: StopHookFn): void {
    this.hooks.push(hook);
  }

  /**
   * 执行所有停止钩子。
   * 如果任何一个钩子要求继续，就继续。
   * 返回第一个要求继续的钩子的结果。
   */
  async execute(
    messages: UnifiedMessage[],
    lastContent: string,
  ): Promise<StopHookResult> {
    for (const hook of this.hooks) {
      try {
        const result = await hook(messages, lastContent);
        if (result.shouldContinue) {
          return result;
        }
      } catch (error) {
        console.error('[stop-hook] 钩子执行失败:', error);
        // 钩子失败不阻止停止
      }
    }

    return {
      shouldContinue: false,
      hookName: 'none',
    };
  }

  /**
   * 获取已注册的钩子数量。
   */
  get count(): number {
    return this.hooks.length;
  }

  /**
   * 清除所有钩子。
   */
  clear(): void {
    this.hooks = [];
  }
}
