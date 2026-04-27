/**
 * 需求验证智能体
 * 接收原始需求和测试结果，然后验证每个需求。
 * 将每个需求标记为：已满足、部分满足或未满足。
 * 对部分满足/未满足的需求包含差距描述。
 */

import { BaseAgent } from '../core/base-agent.js';
import { AgentContext, AgentResult } from '../core/types.js';

export class RequirementVerificationAgent extends BaseAgent {
  constructor() {
    super('RequirementVerification');
  }

  protected async doExecute(context: AgentContext): Promise<AgentResult> {
    const requirements = context.inputData.requirements;
    const testResults = context.inputData.testResults;

    // 验证输入需求
    if (!requirements || typeof requirements !== 'string' || requirements.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Requirements input is empty or undefined. Cannot verify requirements.',
        error: 'Requirements input is empty or undefined',
      };
    }

    // 验证测试结果
    if (!testResults || typeof testResults !== 'string' || testResults.trim().length === 0) {
      return {
        success: false,
        outputData: {},
        artifacts: [],
        summary: 'Failed: Test results input is empty or undefined. Cannot verify requirements.',
        error: 'Test results input is empty or undefined',
      };
    }

    // 构建提示让 LLM 验证需求
    const prompt = `你是一名专业的需求验证专家。根据原始需求文档和测试结果报告，验证每个需求的满足状态。

对每个需求，提供：
1. **需求编号/名称**：需求标识符
2. **状态**：以下之一：
   - ✅ **已满足** — 根据测试结果，需求已完全满足
   - ⚠️ **部分满足** — 需求部分满足，存在差距
   - ❌ **未满足** — 需求未满足
3. **证据**：验证该需求的测试用例引用
4. **差距描述**（部分满足或未满足时）：详细说明缺失或不完整的内容

输出格式：
- 生成 Markdown 验证报告
- 顶部包含摘要表格，统计已满足、部分满足和未满足的需求数量
- 后面是逐条需求的详细分析

--- 原始需求文档 ---
${requirements}
--- 需求文档结束 ---

--- 测试结果报告 ---
${testResults}
--- 测试结果报告结束 ---`;

    // 调用 LLM 验证需求（如果有工具系统，可读取实际代码和测试结果文件）
    const harnessResult = await this.runWithHarness(prompt, context, {
      systemPrompt: '你是 RequirementVerification 智能体，一名专业的需求验证专家。你可以使用文件操作工具读取项目中的源代码和测试结果，以便更准确地验证需求满足情况。完成后给出验证报告。',
      maxRounds: 30,
    });
    const result = harnessResult.content;

    // Save the verification report to the output directory
    const savedPath = await this.saveDocument(result, 'verification-report.md', context.outputDir);

    return {
      success: true,
      outputData: { verificationReport: result },
      artifacts: [savedPath],
      summary: `Successfully generated requirement verification report at ${savedPath}`,
    };
  }
}
