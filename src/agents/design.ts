/**
 * 设计智能体
 * 接收需求 Markdown 并生成结构化的设计文档。
 * 包含章节：系统架构概述、模块分解、接口设计和数据模型设计。
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class DesignAgent extends BaseAgent {
  constructor() {
    super('Design');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const requirements = context.inputData.requirements;

    // 验证输入需求
    if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Requirements input is empty or undefined. Cannot generate design document.',
        error: 'Requirements input is empty or undefined',
      };
    }

    // 构建提示让 LLM 生成设计文档
    const prompt = `你是一名专业的软件架构师。根据以下需求文档，生成完整的系统设计文档（Markdown 格式）。

文档必须包含以下章节：
1. **系统架构概述** — 高层架构描述、关键设计决策和技术选型
2. **模块分解** — 系统模块/组件的详细分解，包含职责和交互关系
3. **接口设计** — API 接口、数据契约和模块间通信协议
4. **数据模型设计** — 数据库 schema、数据结构和关系

如果需求不完整或有歧义，用 "[GAP]" 标记清楚标注，并说明需要哪些额外信息。

输出格式为规范的 Markdown 文档，使用正确的标题、列表和代码块。

--- 需求文档 ---
${requirements}
--- 需求文档结束 ---`;

    // 调用 LLM 生成设计文档（如果有工具系统，可读取项目代码了解现有架构）
    const harnessResult = await this.runWithHarness(prompt, context, {
      systemPrompt: '你是 Design 智能体，一名专业的软件架构师。你可以使用文件操作工具读取项目中的现有代码和配置，以便设计与现有架构一致的方案。完成后给出完整的设计文档。',
      maxRounds: 20,
    });
    const result = harnessResult.content;

    // Save the design document to the output directory
    const savedPath = await this.saveDocument(result, 'design.md', context.outputDir);

    return {
      success: true,
      outputData: { design: result },
      artifacts: [savedPath],
      summary: `Successfully generated system design document at ${savedPath}`,
    };
  }
}
