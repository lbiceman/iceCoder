/**
 * 代码编写智能体
 * 接收任务 Markdown 并通过 Harness 循环（工具调用 + 多轮推理）生成源代码。
 * 可以使用文件工具读取现有代码、写入新文件、执行 Shell 命令验证。
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

    const prompt = `你是一名专业的软件工程师，擅长 Node.js 和 TypeScript。根据以下任务分解文档，实现所有任务。

要求：
1. 使用工具读取项目中的现有代码，了解项目结构和代码风格
2. 使用 write_file 工具创建或修改源代码文件
3. 每个文件必须包含任务编号注释（如 // Task: T-001）
4. 生成完整、可运行的 TypeScript 代码，包含正确的类型定义
5. 遵循项目现有的代码风格和目录结构
6. 如果任务描述不清晰，用注释标记：// [UNCLEAR] <说明>
7. 完成所有文件后，给出实现总结

--- 任务文档 ---
${tasks}
--- 任务文档结束 ---

请开始实现。先读取项目结构了解现有代码，然后逐个任务实现。`;

    const result = await this.runWithHarness(prompt, context, {
      systemPrompt: '你是 CodeWriting 智能体，一名专业的软件工程师。你可以使用文件操作工具（read_file、write_file、edit_file、list_directory 等）和 Shell 工具来完成编码任务。根据任务需求自主决定使用哪些工具，编写高质量的代码。',
      maxRounds: 100,
      timeout: 15 * 60 * 1000,
    });

    // 从 Harness 结果中提取写入的文件路径
    const writtenFiles = this.extractWrittenFiles(result.messages);

    return {
      success: true,
      outputData: { code: result.content, files: writtenFiles },
      artifacts: writtenFiles,
      summary: `代码实现完成（${result.loopState.totalToolCalls} 次工具调用，${result.loopState.currentRound} 轮）。${writtenFiles.length > 0 ? `写入 ${writtenFiles.length} 个文件。` : ''}`,
    };
  }

  /**
   * 从对话历史中提取 write_file/edit_file 工具调用的文件路径。
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
