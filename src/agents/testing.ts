/**
 * Testing Agent
 * Receives requirements, design, and task documents, then writes and executes tests via Harness loop.
 * Can use tools to read source code, write test files, and run test commands.
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class TestingAgent extends BaseAgent {
  constructor() {
    super('Testing');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const requirements = context.inputData.requirements;
    const design = context.inputData.design;
    const tasks = context.inputData.tasks;

    if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Requirements input is empty or undefined. Cannot generate test cases.',
        error: 'Requirements input is empty or undefined',
      };
    }

    // 测试提示词：指导 LLM 根据项目文档编写并执行端到端测试
    /*
    中文版本：
    你是一名专业的 QA 工程师。请根据以下项目文档，编写并执行端到端测试。

    工作流程：
    1. 使用 fs_operation 和 read_file 了解项目结构和现有代码
    2. 使用 write_file 编写测试文件（使用项目现有的测试框架）
    3. 使用 run_command 执行测试
    4. 如果测试失败，分析原因并修复
    5. 提供最终测试报告

    测试要求：
    - 覆盖需求文档中的所有功能需求
    - 包含正向和反向测试场景
    - 包含边界条件测试
    - 每个测试用例包含：测试 ID（TC-001）、描述、步骤和预期结果

    --- 需求文档 ---
    ${requirements}
    --- 需求文档结束 ---

    ${design ? `--- 设计文档 ---\n${design}\n--- 设计文档结束 ---\n` : ''}
    ${tasks ? `--- 任务文档 ---\n${tasks}\n--- 任务文档结束 ---\n` : ''}

    请开始。先了解项目结构，然后编写并执行测试。
    */
    const prompt = `You are a professional QA engineer. Based on the following project documents, write and execute end-to-end tests.

Workflow:
1. Use fs_operation and read_file to understand the project structure and existing code
2. Use write_file to write test files (using the project's existing test framework)
3. Use run_command to execute tests
4. If tests fail, analyze the cause and fix them
5. Provide a final test report

Test requirements:
- Cover all functional requirements from the requirements document
- Include positive and negative test scenarios
- Include boundary condition tests
- Each test case includes: test ID (TC-001), description, steps, and expected results

--- Requirements Document ---
${requirements}
--- End of Requirements Document ---

${design ? `--- Design Document ---\n${design}\n--- End of Design Document ---\n` : ''}
${tasks ? `--- Task Document ---\n${tasks}\n--- End of Task Document ---\n` : ''}

Please begin. First understand the project structure, then write and execute tests.`;

    const result = await this.runWithHarness(prompt, context, {
      // 测试智能体的系统提示词
      // 中文版本：你是 Testing 智能体，一名专业的 QA 工程师。你可以使用文件操作工具读取源代码和编写测试文件，使用 Shell 工具执行测试命令。根据需求编写高质量的测试用例并确保它们通过。
      systemPrompt: 'You are the Testing agent, a professional QA engineer. You can use file operation tools to read source code and write test files, and use Shell tools to execute test commands. Write high-quality test cases based on requirements and ensure they pass.',
    });

    const report = this.extractTestReport(result.content);
    const reportPath = await this.saveDocument(
      report || result.content,
      'test-report.md',
      context.outputDir,
    );

    const writtenFiles = this.extractWrittenFiles(result.messages);

    return {
      success: true,
      outputData: { testReport: report || result.content },
      artifacts: [reportPath, ...writtenFiles],
      summary: `Testing completed (${result.loopState.totalToolCalls} tool calls, ${result.loopState.currentRound} rounds).${writtenFiles.length > 0 ? ` Written ${writtenFiles.length} test file(s).` : ''}`,
    };
  }

  private extractTestReport(content: string): string | null {
    const reportMatch = content.match(/#{1,3}\s*Test.*?Report[\s\S]*$/i);
    return reportMatch ? reportMatch[0] : null;
  }

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
