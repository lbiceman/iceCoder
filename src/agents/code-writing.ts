/**
 * 代码编写智能体
 * 接收任务 Markdown 并为每个任务生成源代码文件。
 * 生成的代码使用 Node.js/TypeScript 技术栈。
 * 在文件头部添加包含任务编号和描述的注释。
 * 标记描述不清晰的任务。
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';
import { MemoryType } from '../memory/types.js';

export class CodeWritingAgent extends BaseAgent {
  constructor() {
    super('CodeWriting');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const tasks = context.inputData.tasks;

    // 验证输入任务文档
    if (!tasks || typeof tasks !== 'string' || tasks.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Tasks input is empty or undefined. Cannot generate source code.',
        error: 'Tasks input is empty or undefined',
      };
    }

    // 构建提示让 LLM 生成源代码
    const prompt = `You are a professional software engineer specializing in Node.js and TypeScript. Based on the following task breakdown document, generate source code files for each task.

Requirements:
1. Use Node.js/TypeScript stack
2. Each generated file MUST start with a header comment containing:
   - Task number
   - Task description
   - Example: // Task: T-001 - Implement user authentication module
3. Generate complete, working TypeScript code with proper types
4. Include necessary imports and exports
5. Follow best practices: proper error handling, input validation, clear naming
6. If a task description is unclear or ambiguous, flag it with a comment: // [UNCLEAR] <explanation of what is unclear>

Output format:
For each file, use the following structure:
\`\`\`
=== FILE: <filepath> ===
<file content>
=== END FILE ===
\`\`\`

Generate all source files needed to implement the tasks described below.

--- Task Document ---
${tasks}
--- End of Task Document ---`;

    // 调用 LLM 生成源代码
    const result = await this.callLLM(prompt, context);

    // 从 LLM 响应中解析生成的文件
    const files = this.parseGeneratedFiles(result);

    // 将所有生成的源文件保存到输出目录
    const savedPaths: string[] = [];
    for (const file of files) {
      const savedPath = await this.saveDocument(file.content, file.filepath, context.outputDir);
      savedPaths.push(savedPath);
    }

    // Store the result in episodic memory for future reference
    await this.storeMemory(
      `Generated ${files.length} source code files from task document. Files: ${savedPaths.join(', ')}`,
      MemoryType.EPISODIC,
      context,
    );

    return {
      success: true,
      outputData: { code: result, files: savedPaths },
      artifacts: savedPaths,
      summary: `Successfully generated ${files.length} source code file(s) at ${context.outputDir}`,
    };
  }

  /**
   * 解析 LLM 响应以提取各个文件内容。
   * 期望格式：=== FILE: <filepath> === ... === END FILE ===
   */
  private parseGeneratedFiles(content: string): Array<{ filepath: string; content: string }> {
    const files: Array<{ filepath: string; content: string }> = [];
    const filePattern = /=== FILE: (.+?) ===\n([\s\S]*?)(?:=== END FILE ===)/g;

    let match: RegExpExecArray | null;
    while ((match = filePattern.exec(content)) !== null) {
      const filepath = match[1].trim();
      const fileContent = match[2].trim();
      files.push({ filepath, content: fileContent });
    }

    // 如果没有找到结构化文件，将整个响应保存为单个文件
    if (files.length === 0 && content.trim().length > 0) {
      files.push({ filepath: 'generated-code.ts', content: content.trim() });
    }

    return files;
  }
}
