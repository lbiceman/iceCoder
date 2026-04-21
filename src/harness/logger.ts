/**
 * Harness 日志器 — 只记录 AI 做了什么，不记录 AI 说了什么。
 *
 * 日志关注点：
 * - AI 调用了什么工具、传了什么参数
 * - 工具执行结果（成功/失败）
 * - 循环控制事件（启动、停止、压缩）
 * - 权限拦截
 * - 耗时统计
 *
 * 不记录：
 * - AI 的回复文本内容
 * - AI 的思考过程
 */

/**
 * 单条日志条目。
 */
export interface HarnessLogEntry {
  /** 时间戳 */
  timestamp: string;
  /** 当前轮次 */
  round: number;
  /** 事件类型 */
  event:
    | 'loop_start'       // 循环启动
    | 'round_start'      // 新一轮开始
    | 'llm_call'         // 调用 LLM
    | 'llm_response'     // LLM 返回（只记录行为类型，不记录内容）
    | 'tool_call'        // AI 决定调用工具
    | 'tool_result'      // 工具执行结果
    | 'tool_denied'      // 工具被权限拒绝
    | 'tool_retry'       // 工具重试
    | 'compaction'       // 上下文压缩
    | 'loop_stop'        // 循环停止
    | 'error';           // 错误
  /** 事件详情 */
  detail: string;
  /** 额外数据（工具名、参数等） */
  data?: Record<string, any>;
}

/**
 * HarnessLogger 收集结构化日志，方便观察 AI 的每一步行为。
 */
export class HarnessLogger {
  private entries: HarnessLogEntry[] = [];
  private currentRound: number = 0;
  private startTime: number = 0;

  /**
   * 循环启动。
   */
  loopStart(toolCount: number, messageCount: number): void {
    this.startTime = Date.now();
    this.log('loop_start', `循环启动 | ${toolCount} 个可用工具 | ${messageCount} 条初始消息`);
  }

  /**
   * 新一轮开始。
   */
  roundStart(round: number, messageCount: number): void {
    this.currentRound = round;
    this.log('round_start', `── 第 ${round} 轮 ── (${messageCount} 条消息)`);
  }

  /**
   * 调用 LLM。
   */
  llmCall(): void {
    this.log('llm_call', '→ 调用 LLM');
  }

  /**
   * LLM 返回 — 只记录行为类型，不记录内容。
   */
  llmResponseFinal(tokenUsage: { input: number; output: number }): void {
    this.log('llm_response', `← LLM 返回最终回复 | tokens: ${tokenUsage.input}→${tokenUsage.output}`);
  }

  llmResponseToolCalls(count: number, tokenUsage: { input: number; output: number }): void {
    this.log('llm_response', `← LLM 请求 ${count} 个工具调用 | tokens: ${tokenUsage.input}→${tokenUsage.output}`);
  }

  /**
   * AI 决定调用工具。
   */
  toolCall(toolName: string, args: Record<string, any>): void {
    const argsStr = JSON.stringify(args);
    const truncated = argsStr.length > 300 ? argsStr.substring(0, 300) + '...' : argsStr;
    this.log('tool_call', `📌 ${toolName}(${truncated})`, { tool: toolName, args });
  }

  /**
   * 工具执行结果。
   */
  toolResult(toolName: string, success: boolean, outputLength: number, error?: string): void {
    if (success) {
      this.log('tool_result', `✅ ${toolName} → 成功 (${outputLength} 字符)`, { tool: toolName });
    } else {
      this.log('tool_result', `❌ ${toolName} → 失败: ${error}`, { tool: toolName, error });
    }
  }

  /**
   * 工具被权限拒绝。
   */
  toolDenied(toolName: string, reason?: string): void {
    this.log('tool_denied', `🚫 ${toolName} 被拒绝: ${reason ?? '无权限'}`, { tool: toolName });
  }

  /**
   * 工具重试。
   */
  toolRetry(toolName: string, attempt: number, maxRetries: number, error: string): void {
    this.log('tool_retry', `🔄 ${toolName} 重试 ${attempt}/${maxRetries}: ${error}`, { tool: toolName, attempt });
  }

  /**
   * 上下文压缩。
   */
  compaction(before: number, after: number): void {
    this.log('compaction', `📦 上下文压缩: ${before} → ${after} 条消息`);
  }

  /**
   * 循环停止。
   */
  loopStop(reason: string, totalRounds: number, totalToolCalls: number): void {
    const elapsed = Date.now() - this.startTime;
    this.log('loop_stop', `循环结束 | 原因: ${reason} | ${totalRounds} 轮 | ${totalToolCalls} 次工具调用 | 耗时 ${elapsed}ms`);
  }

  /**
   * 错误。
   */
  error(message: string): void {
    this.log('error', `⚠️ ${message}`);
  }

  /**
   * 获取所有日志条目。
   */
  getEntries(): HarnessLogEntry[] {
    return [...this.entries];
  }

  /**
   * 打印所有日志到控制台。
   */
  dump(): void {
    for (const entry of this.entries) {
      console.log(`[harness] ${entry.detail}`);
    }
  }

  private log(event: HarnessLogEntry['event'], detail: string, data?: Record<string, any>): void {
    const entry: HarnessLogEntry = {
      timestamp: new Date().toISOString(),
      round: this.currentRound,
      event,
      detail,
      data,
    };
    this.entries.push(entry);

    // 实时输出到控制台
    console.log(`[harness] ${detail}`);
  }
}
