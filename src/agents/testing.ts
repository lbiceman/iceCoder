/**
 * 测试智能体
 * 接收需求、设计和任务文档，通过 Harness 循环编写并执行测试。
 * 可以使用工具读取源代码、写入测试文件、运行测试命令。
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

    const prompt = `你是一名专业的 QA 工程师。根据以下项目文档，编写并执行端到端测试。

工作流程：
1. 先用 list_directory 和 read_file 了解项目结构和已有代码
2. 用 write_file 编写测试文件（使用项目已有的测试框架）
3. 用 run_command 执行测试
4. 如果测试失败，分析原因并修复
5. 最终给出测试报告

测试要求：
- 覆盖需求文档中的所有功能需求
- 包含正向和反向测试场景
- 包含边界条件测试
- 每个测试用例包含：测试编号（TC-001）、描述、步骤、预期结果

--- 需求文档 ---
${requirements}
--- 需求文档结束 ---

${design ? `--- 设计文档 ---\n${design}\n--- 设计文档结束 ---\n` : ''}
${tasks ? `--- 任务文档 ---\n${tasks}\n--- 任务文档结束 ---\n` : ''}

请开始。先了解项目结构，然后编写和执行测试。`;

    const result = await this.runWithHarness(prompt, context, {
      systemPrompt: '你是 Testing 智能体，一名专业的 QA 工程师。你可以使用文件操作工具读取源代码、写入测试文件，使用 Shell 工具执行测试命令。根据需求编写高质量的测试用例并确保通过。',
      maxRounds: 80,
      timeout: 15 * 60 * 1000,
    });

    // 提取测试报告
    const report = this.extractTestReport(result.content);
    const reportPath = await this.saveDocument(
      report || result.content,
      'test-report.md',
      context.outputDir,
    );

    // 提取写入的测试文件
    const writtenFiles = this.extractWrittenFiles(result.messages);

    return {
      success: true,
      outputData: { testReport: report || result.content },
      artifacts: [reportPath, ...writtenFiles],
      summary: `测试完成（${result.loopState.totalToolCalls} 次工具调用，${result.loopState.currentRound} 轮）。${writtenFiles.length > 0 ? `写入 ${writtenFiles.length} 个测试文件。` : ''}`,
    };
  }

  private extractTestReport(content: string): string | null {
    // 尝试提取 markdown 中的测试报告部分
    const reportMatch = content.match(/#{1,3}\s*(?:测试|Test).*?Report[\s\S]*$/i);
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
