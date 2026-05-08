/**
 * Code Writing Agent
 * Receives task Markdown and generates source code through a Harness loop (tool calls + multi-turn reasoning).
 * Can use file tools to read existing code, write new files, and execute Shell commands for verification.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class CodeWritingAgent extends BaseAgent {
  constructor() {
    super('CodeWriting');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const tasks = context.inputData.tasks;

    if (!tasks || typeof tasks !== 'string' || tasks.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Tasks input is empty or undefined. Cannot generate source code.',
        error: 'Tasks input is empty or undefined',
      };
    }

    // 代码编写提示词：指导 LLM 根据任务文档实现代码
    /*
    中文版本：
    你是一名专业的软件工程师，精通 Node.js 和 TypeScript。请根据以下任务分解文档，实现所有任务。

    要求：
    1. 使用工具读取项目中的现有代码，了解项目结构和代码风格
    2. 使用 write_file 工具创建或修改源代码文件
    3. 每个文件必须包含任务编号注释（如 // Task: T-001）
    4. 生成完整、可运行的 TypeScript 代码，包含正确的类型定义
    5. 遵循项目现有的代码风格和目录结构
    6. 如果任务描述不清楚，请用注释标记：// [UNCLEAR] <描述>
    7. 完成所有文件后，提供实现总结

    --- 任务文档 ---
    ${tasks}
    --- 任务文档结束 ---

    请开始实现。先阅读项目结构了解现有代码，然后逐个任务实现。
    */
    const prompt = `You are a professional software engineer proficient in Node.js and TypeScript. Implement all tasks based on the following task breakdown document.

Requirements:
1. Use tools to read existing code in the project to understand the project structure and code style
2. Use write_file tool to create or modify source code files
3. Each file must include a task number comment (e.g. // Task: T-001)
4. Generate complete, runnable TypeScript code with correct type definitions
5. Follow the project's existing code style and directory structure
6. If a task description is unclear, mark with a comment: // [UNCLEAR] <description>
7. After completing all files, provide an implementation summary

--- Task Document ---
${tasks}
--- End of Task Document ---

Please begin implementation. First read the project structure to understand existing code, then implement task by task.`;

    const result = await this.runWithHarness(prompt, context, {
      // 代码编写智能体的系统提示词
      // 中文版本：你是 CodeWriting 智能体，一名专业的软件工程师。你可以使用文件操作工具（read_file、write_file、edit_file、fs_operation 等）和 Shell 工具来完成编码任务。根据任务需求自主决定使用哪些工具，并编写高质量的代码。
      systemPrompt: 'You are the CodeWriting agent, a professional software engineer. You can use file operation tools (read_file, write_file, edit_file, fs_operation, etc.) and Shell tools to complete coding tasks. Autonomously decide which tools to use based on task requirements and write high-quality code.',
      maxRounds: 100,
      timeout: 15 * 60 * 1000,
    });

    // Extract written file paths from Harness result
    const writtenFiles = this.extractWrittenFiles(result.messages);

    return {
      success: true,
      outputData: { code: result.content, files: writtenFiles },
      artifacts: writtenFiles,
      summary: `Code implementation completed (${result.loopState.totalToolCalls} tool calls, ${result.loopState.currentRound} rounds).${writtenFiles.length > 0 ? ` Written ${writtenFiles.length} file(s).` : ''}`,
    };
  }

  /**
   * Extract file paths from write_file/edit_file tool calls in conversation history.
   */
  private extractWrittenFiles(messages: any[]): string[] {
    const files = new Set<string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (['write_file', 'edit_file', 'append_file'].includes(tc.name)) {
            const filePath = tc.arguments?.path || tc.arguments?.file_path;
            if (filePath) files.add(filePath);
          }
        }
      }
    }
    return Array.from(files);
  }
}
