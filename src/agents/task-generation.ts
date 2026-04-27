/**
 * 任务生成智能体
 * 接收设计 Markdown 并生成结构化的任务文档。
 * 每个任务包含：任务编号、描述、所属模块、依赖关系和估计复杂度。
 * 任务按模块和依赖顺序排列。
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class TaskGenerationAgent extends BaseAgent {
  constructor() {
    super('TaskGeneration');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const design = context.inputData.design;

    // 验证输入设计文档
    if (!design || typeof design !== 'string' || design.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Design input is empty or undefined. Cannot generate task document.',
        error: 'Design input is empty or undefined',
      };
    }

    // 构建提示让 LLM 生成任务文档
    const prompt = `你是一名专业的项目经理和技术负责人。根据以下系统设计文档，生成完整的任务分解文档（Markdown 格式）。

每个任务必须包含以下字段：
- **任务编号**：顺序标识符（如 T-001、T-002）
- **描述**：需要实现的内容的清晰描述
- **所属模块**：该任务属于哪个模块/组件
- **依赖关系**：该任务依赖的任务编号列表（或"无"）
- **预估复杂度**：低 / 中 / 高

任务列表要求：
1. 先按模块分组，模块内按依赖顺序排列
2. 任务粒度应足够细，可独立完成
3. 依赖关系必须引用有效的任务编号
4. 覆盖设计文档中描述的所有模块和接口

输出格式为规范的 Markdown 文档，使用表格或结构化列表。

--- 设计文档 ---
${design}
--- 设计文档结束 ---`;

    // 调用 LLM 生成任务文档
    const result = await this.callLLM(prompt, context);

    // Save the task document to the output directory
    const savedPath = await this.saveDocument(result, 'tasks.md', context.outputDir);

    return {
      success: true,
      outputData: { tasks: result },
      artifacts: [savedPath],
      summary: `Successfully generated task breakdown document at ${savedPath}`,
    };
  }
}
