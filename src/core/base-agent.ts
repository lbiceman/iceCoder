/**
 * BaseAgent 抽象类，为所有智能体提供通用功能。
 * 实现 Agent 接口，提供错误处理包装器以及 LLM 调用、记忆操作和文档保存的辅助方法。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Agent, AgentContext, AgentResult } from './types.js';
import { MemoryType } from '../memory/types.js';
import { UnifiedMessage } from '../llm/types.js';

/**
 * 所有系统智能体的抽象基类。
 * 提供：
 * - 通过 execute() 包装 doExecute() 实现自动错误处理
 * - LLM 交互、记忆操作和文件 I/O 的辅助方法
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
   * 调用 LLM 的辅助方法，接受提示字符串。
   * 创建 role='user' 的 UnifiedMessage 并通过 LLM 适配器发送。
   *
   * @param prompt - 发送给 LLM 的提示文本
   * @param context - 包含 LLM 适配器的智能体执行上下文
   * @returns LLM 响应内容字符串
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
   * 将内容存储到智能体记忆系统的辅助方法。
   *
   * @param content - 要存储为记忆的内容
   * @param type - 记忆类型（short_term、long_term、episodic 等）
   * @param context - 包含记忆管理器的智能体执行上下文
   */
  protected async storeMemory(content: string, type: MemoryType, context: AgentContext): Promise<void> {
    await context.memoryManager.store(content, type, { sourceAgent: this.name });
  }

  /**
   * 将内容保存到输出目录中文件的辅助方法。
   * 如果目录不存在则自动创建。
   *
   * @param content - 要写入文件的内容
   * @param filename - 要创建的文件名
   * @param outputDir - 写入文件的目录
   * @returns 保存文件的完整路径
   */
  protected async saveDocument(content: string, filename: string, outputDir: string): Promise<string> {
    await fs.mkdir(outputDir, { recursive: true });
    const fullPath = path.join(outputDir, filename);
    await fs.writeFile(fullPath, content, 'utf-8');
    return fullPath;
  }

}
