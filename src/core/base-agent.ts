/**
 * BaseAgent 抽象类，为所有智能体提供通用功能。
 * 实现 Agent 接口，提供错误处理包装器以及 LLM 调用、记忆操作和文档保存的辅助方法。
 *
 * 两种 LLM 交互模式：
 * - callLLM(): 单次调用，适合简单的文本生成任务
 * - runWithHarness(): 完整 Harness 循环，支持工具调用 + 多轮推理 + 上下文压缩
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Agent, AgentContext, AgentResult } from './types.js';
import { UnifiedMessage } from '../llm/types.js';
import { Harness } from '../harness/harness.js';
import type { HarnessConfig, HarnessResult } from '../harness/types.js';

/**
 * Harness 运行选项（可选覆盖默认值）。
 */
export interface HarnessRunOptions {
  /** 系统提示词（默认使用 Agent 名称生成） */
  systemPrompt?: string;
  /** 最大循环轮次（默认 50） */
  maxRounds?: number;
  /** 超时时间毫秒（默认 10 分钟） */
  timeout?: number;
  /** Token 预算（默认 200000） */
  tokenBudget?: number;
  /** 每步回调（用于 SSE 推送进度） */
  onStep?: (event: any) => void;
}

/**
 * 所有系统智能体的抽象基类。
 * 提供：
 * - 通过 execute() 包装 doExecute() 实现自动错误处理
 * - callLLM(): 单次 LLM 调用
 * - runWithHarness(): 完整 Harness 循环（工具 + 多轮推理）
 * - saveDocument(): 文件保存
 */
export abstract class BaseAgent implements Agent {
  protected name: string;

  constructor(name: string) {
    this.name = name;
  }

  /**
   * 返回智能体的名称。
   */
  getName(): string {
    return this.name;
  }

  /**
   * 公共执行方法，通过 try-catch 包装 doExecute()。
   * 所有智能体通过此模式自动获得错误处理能力。
   * 具体智能体实现 doExecute() 而非直接实现 execute()。
   */
  async execute(context: AgentContext): Promise<AgentResult> {
    try {
      return await this.doExecute(context);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: `Agent "${this.name}" failed with error: ${errorMessage}`,
        error: errorMessage,
      };
    }
  }

  /**
   * 具体智能体必须实现的抽象方法。
   * 包含实际的智能体逻辑，无需处理错误。
   */
  protected abstract doExecute(context: AgentContext): Promise<AgentResult>;

  /**
   * 单次 LLM 调用（无工具，无多轮）。
   * 适合简单的文本生成任务。
   */
  protected async callLLM(prompt: string, context: AgentContext): Promise<string> {
    const message: UnifiedMessage = {
      role: 'user',
      content: prompt,
    };

    const response = await context.llmAdapter.chat([message]);
    return response.content;
  }

  /**
   * 通过 Harness 循环执行任务（工具调用 + 多轮推理）。
   *
   * 将 Agent 的 prompt 交给 Harness，Harness 会：
   * 1. 调用 LLM
   * 2. 如果 LLM 请求工具调用 → 执行工具 → 将结果反馈给 LLM
   * 3. 重复直到 LLM 给出最终回复
   * 4. 自动处理上下文压缩、重试、token 预算
   *
   * 需要 AgentContext 中包含 toolExecutor 和 toolDefinitions。
   * 如果不可用，回退到 callLLM() 单次调用。
   *
   * @param prompt - 发送给 LLM 的任务描述
   * @param context - 智能体执行上下文
   * @param options - 可选的 Harness 配置覆盖
   * @returns Harness 执行结果
   */
  protected async runWithHarness(
    prompt: string,
    context: AgentContext,
    options?: HarnessRunOptions,
  ): Promise<HarnessResult> {
    // 如果没有工具系统，回退到单次调用并包装为 HarnessResult
    if (!context.toolExecutor || !context.toolDefinitions) {
      const content = await this.callLLM(prompt, context);
      return {
        content,
        loopState: {
          currentRound: 1,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          lastInputTokens: 0,
          lastOutputTokens: 0,
          totalToolCalls: 0,
          startTime: Date.now(),
          stopReason: 'model_done',
        },
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content },
        ],
        log: [],
      };
    }

    const systemPrompt = options?.systemPrompt
      ?? `你是 ${this.name} 智能体，一个专业的软件工程助手。你可以使用工具来完成任务。根据任务需求自主决定使用哪些工具，完成后给出最终总结。`;

    const harnessConfig: HarnessConfig = {
      context: {
        systemPrompt,
        tools: context.toolDefinitions,
      },
      loop: {
        maxRounds: options?.maxRounds ?? 50,
        timeout: options?.timeout ?? 10 * 60 * 1000,
        tokenBudget: options?.tokenBudget ?? 200000,
      },
      compactionThreshold: 40,
      compactionKeepRecent: 10,
      compactionEnableLLMSummary: true,
    };

    const harness = new Harness(harnessConfig, context.toolExecutor);

    const chatFn = (msgs: UnifiedMessage[], opts: any) =>
      context.llmAdapter.chat(msgs, opts);

    return harness.run(prompt, chatFn, options?.onStep);
  }

  /**
   * 将内容保存到输出目录中文件的辅助方法。
   * 如果目录不存在则自动创建。
   */
  protected async saveDocument(content: string, filename: string, outputDir: string): Promise<string> {
    await fs.mkdir(outputDir, { recursive: true });
    const fullPath = path.join(outputDir, filename);
    await fs.writeFile(fullPath, content, 'utf-8');
    return fullPath;
  }
}
