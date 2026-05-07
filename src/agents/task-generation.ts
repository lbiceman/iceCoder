/**
 * Task Generation Agent
 * Receives design Markdown and generates a structured task document.
 * Each task includes: task ID, description, owning module, dependencies, and estimated complexity.
 * Tasks are grouped by module and ordered by dependencies.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class TaskGenerationAgent extends BaseAgent {
  constructor() {
    super('TaskGeneration');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const design = context.inputData.design;

    if (!design || typeof design !== 'string' || design.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Design input is empty or undefined. Cannot generate task document.',
        error: 'Design input is empty or undefined',
      };
    }

    // 任务生成提示词：指导 LLM 根据设计文档生成任务分解文档
    /*
    中文版本：
    你是一名专业的项目经理和技术负责人。请根据以下系统设计文档，生成一份完整的任务分解文档（Markdown 格式）。

    每个任务必须包含以下字段：
    - **任务 ID**：顺序标识符（如 T-001、T-002）
    - **描述**：需要实现什么的清晰描述
    - **所属模块**：该任务属于哪个模块/组件
    - **依赖项**：该任务依赖的任务 ID 列表（或 "无"）
    - **预估复杂度**：低 / 中 / 高

    任务列表要求：
    1. 先按模块分组，然后在每个模块内按依赖关系排序
    2. 任务粒度应足够细，可以独立完成
    3. 依赖项必须引用有效的任务 ID
    4. 覆盖设计文档中描述的所有模块和接口

    输出格式良好的 Markdown 文档，使用表格或结构化列表。

    --- 设计文档 ---
    ${design}
    --- 设计文档结束 ---
    */
    const prompt = `You are a professional project manager and technical lead. Based on the following system design document, generate a complete task breakdown document (Markdown format).

Each task must include the following fields:
- **Task ID**: Sequential identifier (e.g. T-001, T-002)
- **Description**: Clear description of what needs to be implemented
- **Owning Module**: Which module/component this task belongs to
- **Dependencies**: List of task IDs this task depends on (or "None")
- **Estimated Complexity**: Low / Medium / High

Task list requirements:
1. Group by module first, then order by dependencies within each module
2. Task granularity should be fine enough to be completed independently
3. Dependencies must reference valid task IDs
4. Cover all modules and interfaces described in the design document

Output a well-formatted Markdown document using tables or structured lists.

--- Design Document ---
${design}
--- End of Design Document ---`;

    const harnessResult = await this.runWithHarness(prompt, context, {
      // 任务生成智能体的系统提示词
      // 中文版本：你是 TaskGeneration 智能体，一名专业的项目经理。你可以使用文件操作工具读取项目结构和现有代码，以更准确地分解任务。完成后请提供结构化的任务文档。
      systemPrompt: 'You are the TaskGeneration agent, a professional project manager. You can use file operation tools to read project structure and existing code to break down tasks more accurately. Provide a structured task document when done.',
      maxRounds: 20,
    });
    const result = harnessResult.content;

    const savedPath = await this.saveDocument(result, 'tasks.md', context.outputDir);

    return {
      success: true,
      outputData: { tasks: result },
      artifacts: [savedPath],
      summary: `Successfully generated task breakdown document at ${savedPath}`,
    };
  }
}
