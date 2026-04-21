/**
 * 任务生成智能体
 * 接收设计 Markdown 并生成结构化的任务文档。
 * 每个任务包含：任务编号、描述、所属模块、依赖关系和估计复杂度。
 * 任务按模块和依赖顺序排列。
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';
import { MemoryType } from '../memory/types.js';

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
    const prompt = `You are a professional project manager and technical lead. Based on the following system design document, generate a comprehensive task breakdown document in Markdown format.

Each task MUST include the following fields:
- **Task Number**: Sequential identifier (e.g., T-001, T-002)
- **Description**: Clear description of what needs to be implemented
- **Owning Module**: Which module/component this task belongs to
- **Dependencies**: List of task numbers this task depends on (or "None")
- **Estimated Complexity**: Low / Medium / High

Requirements for the task list:
1. Tasks must be sorted by module first, then by dependency order within each module
2. Tasks should be granular enough to be completed independently
3. Dependencies must reference valid task numbers
4. Cover all modules and interfaces described in the design document

Format the output as a clean Markdown document with a table or structured list.

--- Design Document ---
${design}
--- End of Design Document ---`;

    // 调用 LLM 生成任务文档
    const result = await this.callLLM(prompt, context);

    // Save the task document to the output directory
    const savedPath = await this.saveDocument(result, 'tasks.md', context.outputDir);

    // Store the result in episodic memory for future reference
    await this.storeMemory(
      `Generated task breakdown document from design. Output saved to ${savedPath}`,
      MemoryType.EPISODIC,
      context,
    );

    return {
      success: true,
      outputData: { tasks: result },
      artifacts: [savedPath],
      summary: `Successfully generated task breakdown document at ${savedPath}`,
    };
  }
}
