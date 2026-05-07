/**
 * Design Agent
 * Receives requirements Markdown and generates a structured design document.
 * Sections: system architecture overview, module breakdown, interface design, and data model design.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class DesignAgent extends BaseAgent {
  constructor() {
    super('Design');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const requirements = context.inputData.requirements;

    if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Requirements input is empty or undefined. Cannot generate design document.',
        error: 'Requirements input is empty or undefined',
      };
    }

    // 设计提示词：指导 LLM 根据需求文档生成系统设计文档
    /*
    中文版本：
    你是一名专业的软件架构师。请根据以下需求文档，生成一份完整的系统设计文档（Markdown 格式）。

    文档必须包含以下章节：
    1. **系统架构概述** — 高层架构描述、关键设计决策和技术选型
    2. **模块拆分** — 系统模块/组件的详细拆分，包括职责和交互关系
    3. **接口设计** — API 接口、数据契约和模块间通信协议
    4. **数据模型设计** — 数据库表结构、数据结构和关系

    如果需求不完整或有歧义，请用 "[GAP]" 标记并说明需要补充什么信息。

    输出格式良好的 Markdown 文档，包含适当的标题、列表和代码块。

    --- 需求文档 ---
    ${requirements}
    --- 需求文档结束 ---
    */
    const prompt = `You are a professional software architect. Based on the following requirements document, generate a complete system design document (Markdown format).

The document must include the following sections:
1. **System Architecture Overview** — High-level architecture description, key design decisions, and technology choices
2. **Module Breakdown** — Detailed breakdown of system modules/components, including responsibilities and interactions
3. **Interface Design** — API interfaces, data contracts, and inter-module communication protocols
4. **Data Model Design** — Database schema, data structures, and relationships

If requirements are incomplete or ambiguous, clearly mark with "[GAP]" and explain what additional information is needed.

Output a well-formatted Markdown document with proper headings, lists, and code blocks.

--- Requirements Document ---
${requirements}
--- End of Requirements Document ---`;

    const harnessResult = await this.runWithHarness(prompt, context, {
      // 设计智能体的系统提示词
      // 中文版本：你是 Design 智能体，一名专业的软件架构师。你可以使用文件操作工具读取现有项目代码和配置，以设计与当前架构一致的方案。完成后请提供完整的设计文档。
      systemPrompt: 'You are the Design agent, a professional software architect. You can use file operation tools to read existing project code and configuration to design solutions consistent with the current architecture. Provide a complete design document when done.',
      maxRounds: 20,
    });
    const result = harnessResult.content;

    const savedPath = await this.saveDocument(result, 'design.md', context.outputDir);

    return {
      success: true,
      outputData: { design: result },
      artifacts: [savedPath],
      summary: `Successfully generated system design document at ${savedPath}`,
    };
  }
}
